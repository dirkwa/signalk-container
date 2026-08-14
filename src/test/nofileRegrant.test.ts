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
import {
  DEVICES_UNRESOLVED_LABEL,
  _setDeviceProbeForTesting,
} from "../devices.js";
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
  index = 0,
): { Name?: string; Soft?: number; Hard?: number }[] | undefined {
  const created = calls.get("createContainer") ?? [];
  assert.ok(created.length > index, `expected create call #${index + 1}`);
  return (
    created[index] as {
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

  it("partial regrant advises exactly once, from the create-time clamp", async () => {
    // Ceiling raised from 524288 to 786432, request 1048576: the recreate's
    // create emits the clamp {requested, granted: 786432}, and the container
    // lands exactly on that grant — the post-recreate verification must not
    // duplicate it.
    _setNofileCeilingForTesting(() => 786432);
    const { client, calls } = makeRegrantClient(liveInspect({ pid: 4242 }));
    _setProcLimitsReaderForTesting(() =>
      (calls.get("createContainer") ?? []).length > 0
        ? procLimits(786432, 786432)
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
    assert.equal(clamps.length, 1, "exactly one advisory for one capped state");
    assert.equal(clamps[0].granted, 786432);
    assert.equal(clamps[0].requested, 1048576);
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

// The crun phrasing observed on podman machine (macOS): the manager cannot
// read the VM's limits, so the ask goes through unclamped and the runtime
// rejects it at container start.
const CRUN_RLIMIT_REJECT =
  "crun: setrlimit `RLIMIT_NOFILE`: Operation not permitted: OCI permission denied";

describe("ensureRunning — nofile rejection fallback", () => {
  /**
   * Mock for the "missing" create path: the container 404s until a create
   * has been recorded (then inspects as running WITHOUT a nofile ask — the
   * fallback container's shape); `start` behaviours are consumed in order.
   */
  function makeMissingClient(startBehaviours: Array<() => Promise<unknown>>): {
    client: ReturnType<typeof makeMockClient>;
    calls: Map<string, unknown[]>;
  } {
    const calls = new Map<string, unknown[]>();
    let startCall = 0;
    const inspect = (): Promise<Json> =>
      (calls.get("createContainer") ?? []).length > 0
        ? Promise.resolve(liveInspect({ pid: 4242, ulimits: null }))
        : Promise.reject(notFound("no such container"));
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect,
          start: () => {
            const behaviour = startBehaviours[startCall];
            startCall += 1;
            return behaviour ? behaviour() : Promise.resolve();
          },
        },
      },
      images: { "questdb/questdb:latest": { Id: "sha256:abc", Config: {} } },
      calls,
    });
    return { client, calls };
  }

  it("retries once without the nofile ask and advises the shortfall", async () => {
    // Unknown ceiling (macOS shape): the ask passes through unclamped.
    _setNofileCeilingForTesting(() => null);
    // The fallback container's live limits — the runtime's defaults.
    _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
    const { client, calls } = makeMissingClient([
      () => Promise.reject(new Error(CRUN_RLIMIT_REJECT)),
      () => Promise.resolve(),
    ]);
    const clamps: UlimitClamp[] = [];
    await ensureRunning(
      docker,
      "questdb",
      {
        image: "questdb/questdb",
        tag: "latest",
        ulimits: { nofile: 1048576, nproc: 4096 },
      },
      () => {},
      {
        onUlimitClamped: (e) => {
          clamps.push(e);
        },
      },
      client,
    );
    assert.deepEqual(createdUlimits(calls, 0), [
      { Name: "nofile", Soft: 1048576, Hard: 1048576 },
      { Name: "nproc", Soft: 4096, Hard: 4096 },
    ]);
    // The retry drops only the nofile entry; other ulimits survive.
    assert.deepEqual(createdUlimits(calls, 1), [
      { Name: "nproc", Soft: 4096, Hard: 4096 },
    ]);
    assert.ok(
      (calls.get("remove") ?? []).length >= 1,
      "the failed-start container must be removed before the retry",
    );
    assert.equal(clamps.length, 1);
    assert.equal(clamps[0].ulimit, "nofile");
    assert.equal(clamps[0].requested, 1048576);
    assert.equal(clamps[0].granted, 524288);
    assert.match(clamps[0].reason, /rejected/);
    assert.match(clamps[0].reason, /default limits/);
    // The remediation must couple removal with the restart: on macOS a bare
    // Signal K restart cannot re-grant (the regrant probe reads neither the
    // inspect echo nor the VM's /proc), so an "or restart" phrasing would
    // send the operator down a path that silently does nothing. The remove
    // command must name this fixture's runtime (docker), not a hardcoded
    // podman.
    assert.match(clamps[0].reason, /docker rm -f sk-questdb/);
    assert.match(clamps[0].reason, /and restart Signal K/);
  });

  it("reports granted 0 when no live source is readable (macOS shape)", async () => {
    _setNofileCeilingForTesting(() => null);
    _setProcLimitsReaderForTesting(() => {
      throw new Error("ENOENT");
    });
    const { client, calls } = makeMissingClient([
      () => Promise.reject(new Error(CRUN_RLIMIT_REJECT)),
      () => Promise.resolve(),
    ]);
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
    // The lone nofile entry gone, the retry emits no Ulimits at all.
    assert.equal(createdUlimits(calls, 1), undefined);
    assert.equal(clamps.length, 1);
    assert.equal(clamps[0].requested, 1048576);
    assert.equal(clamps[0].granted, 0);
  });

  it("does not retry an unrelated create failure", async () => {
    _setNofileCeilingForTesting(() => null);
    const { client, calls } = makeMissingClient([
      () => Promise.reject(new Error("boom")),
    ]);
    await assert.rejects(
      ensureRunning(docker, "questdb", requested, () => {}, undefined, client),
      /Failed to create sk-questdb/,
    );
    assert.equal((calls.get("createContainer") ?? []).length, 1);
    assert.equal(calls.get("remove"), undefined);
  });

  it("does not retry a rejection when the config asks no nofile", async () => {
    _setNofileCeilingForTesting(() => null);
    const { client, calls } = makeMissingClient([
      () => Promise.reject(new Error(CRUN_RLIMIT_REJECT)),
    ]);
    await assert.rejects(
      ensureRunning(
        docker,
        "questdb",
        { image: "questdb/questdb", tag: "latest", ulimits: { nproc: 4096 } },
        () => {},
        undefined,
        client,
      ),
      /Failed to create sk-questdb/,
    );
    assert.equal((calls.get("createContainer") ?? []).length, 1);
  });

  it("throws the retry's error when the retry is rejected too", async () => {
    _setNofileCeilingForTesting(() => null);
    const { client, calls } = makeMissingClient([
      () => Promise.reject(new Error(CRUN_RLIMIT_REJECT)),
      () => Promise.reject(new Error(CRUN_RLIMIT_REJECT)),
    ]);
    const clamps: UlimitClamp[] = [];
    await assert.rejects(
      ensureRunning(
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
      ),
      // The categorized message names the mechanism, not the misleading
      // socket/mount permission remediation.
      /Failed to create sk-questdb: A requested per-process limit \(ulimit/,
    );
    assert.equal(
      (calls.get("createContainer") ?? []).length,
      2,
      "exactly one retry, never a loop",
    );
    assert.deepEqual(clamps, [], "no advisory for a container that never ran");
  });

  describe("composed with the optimistic-device fallback", () => {
    // A containerized manager cannot see /dev/snd locally, so the bind is
    // emitted unverified; the REAL host lacks it too AND rejects the nofile
    // ask. Whichever failure the runtime reports first, the other fallback
    // must still engage — and every retry must carry the concessions
    // already made, or the final create re-fails on a problem that was
    // already conceded away.
    const dockerInContainer: ContainerRuntimeInfo = {
      runtime: "docker",
      version: "27.0.0",
      isPodmanDockerShim: false,
      isContainerized: true,
    };
    const DEVICE_REJECT =
      'invalid mount config for type "bind": ' +
      "bind source path does not exist: /dev/snd";
    const composedConfig: ContainerConfig = {
      image: "questdb/questdb",
      tag: "latest",
      devices: ["/dev/snd"],
      ulimits: { nofile: 1048576 },
    };

    before(() =>
      _setDeviceProbeForTesting({ stat: () => null, readdir: () => [] }),
    );
    after(() => _setDeviceProbeForTesting(null));

    function createShapes(calls: Map<string, unknown[]>): Array<{
      hasBind: boolean;
      asksNofile: boolean;
      label: string | undefined;
    }> {
      return (calls.get("createContainer") ?? []).map((opts) => {
        const o = opts as {
          HostConfig?: { Binds?: string[]; Ulimits?: { Name?: string }[] };
          Labels?: Record<string, string>;
        };
        return {
          hasBind: (o.HostConfig?.Binds ?? []).includes("/dev/snd:/dev/snd"),
          asksNofile: (o.HostConfig?.Ulimits ?? []).some(
            (u) => u.Name === "nofile",
          ),
          label: o.Labels?.[DEVICES_UNRESOLVED_LABEL],
        };
      });
    }

    async function runComposed(
      client: ReturnType<typeof makeMockClient>,
    ): Promise<UlimitClamp[]> {
      const clamps: UlimitClamp[] = [];
      await ensureRunning(
        dockerInContainer,
        "questdb",
        composedConfig,
        () => {},
        {
          onUlimitClamped: (e) => {
            clamps.push(e);
          },
        },
        client,
      );
      return clamps;
    }

    it("keeps the dropped device when the rlimit rejection follows it", async () => {
      _setNofileCeilingForTesting(() => null);
      _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
      const { client, calls } = makeMissingClient([
        () => Promise.reject(new Error(DEVICE_REJECT)),
        () => Promise.reject(new Error(CRUN_RLIMIT_REJECT)),
        () => Promise.resolve(),
      ]);
      const clamps = await runComposed(client);
      assert.deepEqual(createShapes(calls), [
        { hasBind: true, asksNofile: true, label: undefined },
        { hasBind: false, asksNofile: true, label: '["/dev/snd"]' },
        { hasBind: false, asksNofile: false, label: '["/dev/snd"]' },
      ]);
      assert.equal(clamps.length, 1);
      assert.equal(clamps[0].requested, 1048576);
      assert.equal(clamps[0].granted, 524288);
    });

    it("announces the create clamp once across device retries", async () => {
      // Readable ceiling below the ask: the FIRST build clamps and
      // advises. The device retry rebuilds with the same clamped ask —
      // rebuilding must not announce the identical clamp a second time.
      _setNofileCeilingForTesting(() => 524288);
      _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
      const { client, calls } = makeMissingClient([
        () => Promise.reject(new Error(DEVICE_REJECT)),
        () => Promise.resolve(),
      ]);
      const clamps = await runComposed(client);
      assert.deepEqual(createShapes(calls), [
        { hasBind: true, asksNofile: true, label: undefined },
        { hasBind: false, asksNofile: true, label: '["/dev/snd"]' },
      ]);
      assert.equal(clamps.length, 1, "one advisory despite the rebuild");
      assert.equal(clamps[0].requested, 1048576);
      assert.equal(clamps[0].granted, 524288);
    });

    it("re-enters the device fallback after the rlimit concession", async () => {
      _setNofileCeilingForTesting(() => null);
      _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
      const { client, calls } = makeMissingClient([
        () => Promise.reject(new Error(CRUN_RLIMIT_REJECT)),
        () => Promise.reject(new Error(DEVICE_REJECT)),
        () => Promise.resolve(),
      ]);
      const clamps = await runComposed(client);
      assert.deepEqual(createShapes(calls), [
        { hasBind: true, asksNofile: true, label: undefined },
        { hasBind: true, asksNofile: false, label: undefined },
        { hasBind: false, asksNofile: false, label: '["/dev/snd"]' },
      ]);
      assert.equal(clamps.length, 1, "one advisory even across two retries");
      assert.equal(clamps[0].requested, 1048576);
    });
  });

  it("regrant after the fallback bounces once, then advisories only", async () => {
    // Bare-metal Linux with a skewed Signal K limit: the ceiling probe
    // over-reports what the podman service can grant, so the regrant
    // recreates WITH the doomed ask; the create re-enters the fallback and
    // the per-observed-limit attempt map must then hold the line.
    _setNofileCeilingForTesting(() => 1048576);
    _setProcLimitsReaderForTesting(() => procLimits(524288, 524288));
    const calls = new Map<string, unknown[]>();
    const inspect = (): Promise<Json> => {
      const removed = (calls.get("remove") ?? []).length;
      const created = (calls.get("createContainer") ?? []).length;
      // More removes than creates = the container is currently gone.
      return removed > created
        ? Promise.reject(notFound("no such object"))
        : Promise.resolve(liveInspect({ pid: 4242, ulimits: null }));
    };
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect,
          // The host rejects exactly the creates that carry a nofile ask.
          start: () => {
            const creates = calls.get("createContainer") ?? [];
            const last = creates[creates.length - 1] as {
              HostConfig?: { Ulimits?: { Name?: string }[] };
            };
            return last?.HostConfig?.Ulimits?.some((u) => u.Name === "nofile")
              ? Promise.reject(new Error(CRUN_RLIMIT_REJECT))
              : Promise.resolve();
          },
        },
      },
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
      2,
      "one regrant remove + one fallback remove",
    );
    assert.equal((calls.get("createContainer") ?? []).length, 2);
    assert.equal(clamps[0]?.requested, 1048576);
    assert.equal(clamps[0]?.granted, 524288);
    const clampsAfterFirstCall = clamps.length;
    await ensureRunning(docker, "questdb", requested, () => {}, opts, client);
    assert.equal(
      (calls.get("remove") ?? []).length,
      2,
      "no recreate ping-pong while the observed limit is unchanged",
    );
    assert.equal((calls.get("createContainer") ?? []).length, 2);
    assert.ok(
      clamps.length > clampsAfterFirstCall,
      "the capped state stays advised on later calls",
    );
    assert.equal(clamps.at(-1)?.granted, 524288);
  });
});
