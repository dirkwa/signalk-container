import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ensureRunning,
  parseProcLimitsNofile,
  readContainerNofile,
  _clearNofileRegrantAttemptsForTesting,
  _setNofileCeilingForTesting,
  _setProcLimitsReaderForTesting,
} from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type {
  ContainerConfig,
  ContainerRuntimeInfo,
  UlimitClamp,
} from "../types.js";

type Json = Record<string, unknown>;

// ulimits sit outside drift detection, so a container created while the host
// nofile ceiling was low keeps the clamped limit forever — a restart
// re-applies the stored value. ensureRunning therefore live-probes the
// container's actual nofile: when the host can now grant more, it recreates
// the container to apply it; when it still can't, it re-emits the clamp
// advisory so consumers keep showing the (true) capped state.

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => {
  _setCurrentHostIdsForTesting(null);
  _setNofileCeilingForTesting(null);
  _setProcLimitsReaderForTesting(null);
});
afterEach(() => {
  _setNofileCeilingForTesting(null);
  _setProcLimitsReaderForTesting(null);
  _clearNofileRegrantAttemptsForTesting();
});

function procLimits(soft: number | string, hard: number | string): string {
  return (
    "Limit                     Soft Limit           Hard Limit           Units\n" +
    "Max cpu time              unlimited            unlimited            seconds\n" +
    `Max open files            ${soft}              ${hard}              files\n` +
    "Max locked memory         8388608              8388608              bytes\n"
  );
}

/** Minimal inspect shape passing the drift diff for `requested` unchanged. */
function liveInspect(parts: {
  running?: boolean;
  pid?: number;
  ulimits?: { Name?: string; Soft?: number; Hard?: number }[] | null;
}): Json {
  const running = parts.running ?? true;
  return {
    State: {
      Status: running ? "running" : "exited",
      Running: running,
      Pid: parts.pid ?? 0,
    },
    Config: {
      Image: "questdb/questdb:latest",
      Cmd: null,
      Env: null,
      User: "1000:1000",
    },
    HostConfig: {
      NetworkMode: "bridge",
      Binds: null,
      PortBindings: null,
      // Docker always carries the auto-injected host-gateway entry; include
      // it so diffContainerConfig finds extraHosts symmetric (no drift).
      ExtraHosts: ["host.containers.internal:host-gateway"],
      Ulimits: parts.ulimits ?? null,
    },
  };
}

function notFound(msg: string): Error {
  const err = new Error(msg) as Error & { statusCode?: number };
  err.statusCode = 404;
  return err;
}

const requested: ContainerConfig = {
  image: "questdb/questdb",
  tag: "latest",
  ulimits: { nofile: 1048576 },
};

/** Mock whose container 404s once `remove` has been recorded. */
function makeRegrantClient(inspectResult: Json): {
  client: ReturnType<typeof makeMockClient>;
  calls: Map<string, unknown[]>;
} {
  const calls = new Map<string, unknown[]>();
  const inspect = (): Promise<Json> =>
    (calls.get("remove") ?? []).length > 0
      ? Promise.reject(notFound("no such object"))
      : Promise.resolve(inspectResult);
  const client = makeMockClient({
    containers: { "sk-questdb": { inspect } },
    images: { "questdb/questdb:latest": { Id: "sha256:abc", Config: {} } },
    calls,
  });
  return { client, calls };
}

function createdUlimits(
  calls: Map<string, unknown[]>,
): { Name?: string; Soft?: number; Hard?: number }[] | undefined {
  const created = calls.get("createContainer") ?? [];
  assert.ok(created.length > 0, "expected a createContainer call");
  return (
    created[0] as {
      HostConfig?: {
        Ulimits?: { Name?: string; Soft?: number; Hard?: number }[];
      };
    }
  ).HostConfig?.Ulimits;
}

describe("parseProcLimitsNofile", () => {
  it("parses soft and hard from the Max open files row", () => {
    assert.deepEqual(parseProcLimitsNofile(procLimits(1024, 524288)), {
      soft: 1024,
      hard: 524288,
    });
  });

  it("maps unlimited to Infinity", () => {
    assert.deepEqual(
      parseProcLimitsNofile(procLimits("unlimited", "unlimited")),
      {
        soft: Infinity,
        hard: Infinity,
      },
    );
  });

  it("returns null when the row is absent or garbled", () => {
    assert.equal(parseProcLimitsNofile(""), null);
    assert.equal(parseProcLimitsNofile("Max open files garbage\n"), null);
  });
});

describe("readContainerNofile", () => {
  it("prefers the live /proc/<pid>/limits over the inspect echo", async () => {
    const paths: string[] = [];
    _setProcLimitsReaderForTesting((p) => {
      paths.push(p);
      return procLimits(524288, 524288);
    });
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: liveInspect({
            pid: 4242,
            ulimits: [{ Name: "nofile", Soft: 1, Hard: 1 }],
          }),
        },
      },
    });
    assert.deepEqual(await readContainerNofile("questdb", client), {
      soft: 524288,
      hard: 524288,
    });
    assert.deepEqual(paths, ["/proc/4242/limits"]);
  });

  it("falls back to HostConfig.Ulimits when /proc is unreadable", async () => {
    _setProcLimitsReaderForTesting(() => {
      throw new Error("EACCES");
    });
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: liveInspect({
            pid: 4242,
            // podman's libpod spelling — must match case-insensitively
            ulimits: [{ Name: "RLIMIT_NOFILE", Soft: 524288, Hard: 524288 }],
          }),
        },
      },
    });
    assert.deepEqual(await readContainerNofile("questdb", client), {
      soft: 524288,
      hard: 524288,
    });
  });

  it("skips the pid probe for a stopped container", async () => {
    _setProcLimitsReaderForTesting(() => {
      throw new Error("should not be called");
    });
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: liveInspect({
            running: false,
            ulimits: [{ Name: "nofile", Soft: 1024, Hard: 2048 }],
          }),
        },
      },
    });
    assert.deepEqual(await readContainerNofile("questdb", client), {
      soft: 1024,
      hard: 2048,
    });
  });

  it("returns null for a missing container or when no source is available", async () => {
    assert.equal(await readContainerNofile("questdb", makeMockClient()), null);
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect: liveInspect({}) } },
    });
    _setProcLimitsReaderForTesting(() => {
      throw new Error("EACCES");
    });
    assert.equal(await readContainerNofile("questdb", client), null);
  });
});

describe("ensureRunning — nofile regrant", () => {
  it("recreates a running container when the host now grants more nofile", async () => {
    _setNofileCeilingForTesting(() => 1048576);
    const { client, calls } = makeRegrantClient(liveInspect({ pid: 4242 }));
    // The recreated container really gets the full limit — the post-recreate
    // verification must then stay silent.
    _setProcLimitsReaderForTesting(() =>
      (calls.get("createContainer") ?? []).length > 0
        ? procLimits(1048576, 1048576)
        : procLimits(524288, 524288),
    );
    const clamps: UlimitClamp[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      {
        onUlimitClamped: (e) => {
          clamps.push(e);
        },
      },
      client,
    );
    assert.ok((calls.get("remove") ?? []).length > 0, "expected a recreate");
    assert.deepEqual(createdUlimits(calls), [
      { Name: "nofile", Soft: 1048576, Hard: 1048576 },
    ]);
    assert.deepEqual(clamps, [], "a full grant must not emit a clamp");
  });

  it("re-emits the clamp advisory when the host still cannot grant more", async () => {
    _setNofileCeilingForTesting(() => 524288);
    _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
    const { client, calls } = makeRegrantClient(liveInspect({ pid: 4242 }));
    const clamps: UlimitClamp[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      {
        onUlimitClamped: (e) => {
          clamps.push(e);
        },
      },
      client,
    );
    assert.equal(calls.get("remove"), undefined, "must not recreate");
    assert.equal(clamps.length, 1);
    assert.equal(clamps[0].ulimit, "nofile");
    assert.equal(clamps[0].requested, 1048576);
    assert.equal(clamps[0].granted, 524288);
  });

  it("does nothing when the container already runs with the full limit", async () => {
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => procLimits(1048576, 1048576));
    const { client, calls } = makeRegrantClient(liveInspect({ pid: 4242 }));
    const clamps: UlimitClamp[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      {
        onUlimitClamped: (e) => {
          clamps.push(e);
        },
      },
      client,
    );
    assert.equal(calls.get("remove"), undefined);
    assert.deepEqual(clamps, []);
  });

  it("never recreates DOWN when the container has more than the host grants", async () => {
    // nmbath's shape: container recreated out-of-band with the full limit
    // while the Signal K process still runs under the old, lower ceiling.
    _setNofileCeilingForTesting(() => 524288);
    _setProcLimitsReaderForTesting(() => procLimits(1048576, 1048576));
    const { client, calls } = makeRegrantClient(liveInspect({ pid: 4242 }));
    const clamps: UlimitClamp[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      {
        onUlimitClamped: (e) => {
          clamps.push(e);
        },
      },
      client,
    );
    assert.equal(calls.get("remove"), undefined);
    assert.deepEqual(
      clamps,
      [],
      "live limit satisfies the request — no advisory",
    );
  });

  it("treats an unknown live limit as no-op, never as capped", async () => {
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => {
      throw new Error("EACCES");
    });
    const { client, calls } = makeRegrantClient(
      liveInspect({ pid: 4242, ulimits: null }),
    );
    const clamps: UlimitClamp[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      {
        onUlimitClamped: (e) => {
          clamps.push(e);
        },
      },
      client,
    );
    assert.equal(calls.get("remove"), undefined);
    assert.deepEqual(clamps, []);
  });

  it("regrants a stopped container via the inspect echo (no pid to probe)", async () => {
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => {
      throw new Error("should not be called");
    });
    const { client, calls } = makeRegrantClient(
      liveInspect({
        running: false,
        ulimits: [{ Name: "nofile", Soft: 524288, Hard: 524288 }],
      }),
    );
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      undefined,
      client,
    );
    assert.ok((calls.get("remove") ?? []).length > 0, "expected a recreate");
    assert.deepEqual(createdUlimits(calls), [
      { Name: "nofile", Soft: 1048576, Hard: 1048576 },
    ]);
  });

  it("treats an unlimited host ceiling as no cap on the request", async () => {
    _setNofileCeilingForTesting(() => Infinity);
    _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
    const { client, calls } = makeRegrantClient(liveInspect({ pid: 4242 }));
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      undefined,
      client,
    );
    assert.ok((calls.get("remove") ?? []).length > 0, "expected a recreate");
  });

  it("does not thrash when the runtime grants less than it was asked", async () => {
    // A daemon whose own unit limit caps what it hands out: the create asked
    // for the full request (inspect echoes 1048576) but the container lives
    // with less. Asking again cannot help — the regrant must advise, never
    // recreate, or every ensureRunning would bounce the container.
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
    const { client, calls } = makeRegrantClient(
      liveInspect({
        pid: 4242,
        ulimits: [{ Name: "nofile", Soft: 1048576, Hard: 1048576 }],
      }),
    );
    const clamps: UlimitClamp[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      {
        onUlimitClamped: (e) => {
          clamps.push(e);
        },
      },
      client,
    );
    assert.equal(calls.get("remove"), undefined, "must not recreate");
    assert.equal(clamps.length, 1);
    assert.equal(clamps[0].granted, 524288);
  });

  it("recreates exactly once when the raise does not take (no repeat)", async () => {
    // First call: container was created asking 524288, host now grants
    // 1048576 → recreate, new create asks 1048576. The runtime under-grants
    // (live stays 524288). Second call: the previous ask already equals the
    // grantable value, so no further recreate — only the advisory.
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
    const calls = new Map<string, unknown[]>();
    const inspect = (): Promise<Json> => {
      const created = (calls.get("createContainer") ?? []).length > 0;
      const removed = (calls.get("remove") ?? []).length > 0;
      if (removed && !created) {
        return Promise.reject(notFound("no such object"));
      }
      return Promise.resolve(
        liveInspect({
          pid: 4242,
          ulimits: [
            created
              ? { Name: "nofile", Soft: 1048576, Hard: 1048576 }
              : { Name: "nofile", Soft: 524288, Hard: 524288 },
          ],
        }),
      );
    };
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect } },
      images: { "questdb/questdb:latest": { Id: "sha256:abc", Config: {} } },
      calls,
    });
    const clamps: UlimitClamp[] = [];
    const opts = {
      onUlimitClamped: (e: UlimitClamp) => {
        clamps.push(e);
      },
    };
    await ensureRunning(docker, "questdb", requested, () => {}, opts, client);
    assert.equal((calls.get("remove") ?? []).length, 1, "first call recreates");
    await ensureRunning(docker, "questdb", requested, () => {}, opts, client);
    assert.equal(
      (calls.get("remove") ?? []).length,
      1,
      "second call must not recreate again",
    );
    assert.equal(clamps.at(-1)?.granted, 524288);
  });

  it("attempts a futile regrant once, not per call (podman <5.5 shape)", async () => {
    // Rootless podman < 5.5.0 ignores the compat API's ulimit request
    // (containers/podman#25881) and echoes the EFFECTIVE limits through
    // inspect, so after a recreate both `asked` and `live` still read the
    // old inherited value — the ask-bound alone cannot see that the attempt
    // failed. The per-observed-limit guard must hold the line: one recreate
    // attempt, then advisories only.
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
    const calls = new Map<string, unknown[]>();
    const inspect = (): Promise<Json> => {
      const created = (calls.get("createContainer") ?? []).length > 0;
      const removed = (calls.get("remove") ?? []).length > 0;
      if (removed && !created) {
        return Promise.reject(notFound("no such object"));
      }
      // Echo never improves — the runtime dropped the request.
      return Promise.resolve(
        liveInspect({
          pid: 4242,
          ulimits: [{ Name: "RLIMIT_NOFILE", Soft: 524288, Hard: 524288 }],
        }),
      );
    };
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect } },
      images: { "questdb/questdb:latest": { Id: "sha256:abc", Config: {} } },
      calls,
    });
    const clamps: UlimitClamp[] = [];
    const opts = {
      onUlimitClamped: (e: UlimitClamp) => {
        clamps.push(e);
      },
    };
    await ensureRunning(docker, "questdb", requested, () => {}, opts, client);
    assert.equal(
      (calls.get("remove") ?? []).length,
      1,
      "first call may attempt the regrant",
    );
    assert.equal(
      clamps.length,
      1,
      "the futile recreate must advise in the same call — the create emits " +
        "no clamp (the ceiling looks fine) so this is the only signal",
    );
    assert.equal(clamps[0].granted, 524288);
    await ensureRunning(docker, "questdb", requested, () => {}, opts, client);
    await ensureRunning(docker, "questdb", requested, () => {}, opts, client);
    assert.equal(
      (calls.get("remove") ?? []).length,
      1,
      "further calls must not recreate while the observed limit is unchanged",
    );
    assert.equal(clamps.at(-1)?.granted, 524288);
  });

  it("post-regrant verify failure never fails the start", async () => {
    // The recreate succeeded; the verification probe is best-effort
    // telemetry. A daemon hiccup on that final inspect must degrade to
    // "no advisory", not reject an ensureRunning that actually worked.
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
    const calls = new Map<string, unknown[]>();
    const daemonFault = new Error("server error") as Error & {
      statusCode?: number;
    };
    daemonFault.statusCode = 500;
    const inspect = (): Promise<Json> => {
      if ((calls.get("createContainer") ?? []).length > 0) {
        return Promise.reject(daemonFault);
      }
      if ((calls.get("remove") ?? []).length > 0) {
        return Promise.reject(notFound("no such object"));
      }
      return Promise.resolve(liveInspect({ pid: 4242 }));
    };
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect } },
      images: { "questdb/questdb:latest": { Id: "sha256:abc", Config: {} } },
      calls,
    });
    const clamps: UlimitClamp[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      {
        onUlimitClamped: (e) => {
          clamps.push(e);
        },
      },
      client,
    );
    assert.ok(
      (calls.get("createContainer") ?? []).length > 0,
      "the recreate itself must have completed",
    );
    assert.deepEqual(clamps, [], "no advisory on an unverifiable outcome");
  });

  it("skips the probe entirely when the config requests no nofile ulimit", async () => {
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => procLimits(1024, 1024));
    const { client, calls } = makeRegrantClient(liveInspect({ pid: 4242 }));
    await ensureRunning(
      docker,
      "questdb",
      { image: "questdb/questdb", tag: "latest" },
      () => {},
      undefined,
      client,
    );
    assert.equal(calls.get("remove"), undefined);
  });
});
