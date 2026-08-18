import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureRunning,
  _clearAnnouncedWedgedForTesting,
} from "../containers.js";
import { requestedResourcesLabel } from "../namespace.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type {
  ContainerConfig,
  ContainerRuntimeInfo,
  ContainerWedged,
} from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

type Json = Record<string, unknown>;

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

// Pin the host UID/GID resolver so user-mapping flags are deterministic
// regardless of who runs `npm test`. `buildLiveInspect` defaults to
// `user: "1000:1000"` to match.
before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

/**
 * Build a dockerode-style `inspect()` result carrying both the State fields
 * `getContainerState` reads and the Config/HostConfig fields
 * `getLiveContainerConfig` reads, since both go through the same
 * `getContainer(name).inspect()`.
 */
function buildLiveInspect(parts: {
  state?: { status: string; running: boolean; pid: number };
  image: string;
  cmd?: string[] | null;
  networkMode?: string;
  binds?: string[] | null;
  env?: string[] | null;
  portBindings?: Record<string, unknown> | null;
  extraHosts?: string[] | null;
  user?: string;
}): Json {
  const st = parts.state ?? { status: "running", running: true, pid: 12345 };
  return {
    State: { Status: st.status, Running: st.running, Pid: st.pid },
    Config: {
      Image: parts.image,
      Cmd: parts.cmd ?? null,
      Env: parts.env ?? null,
      // Matches the pinned host-id resolver above (1000:1000), so the
      // existing "no drift" fixtures stay no-drift without each call
      // having to set user explicitly.
      User: parts.user ?? "1000:1000",
    },
    HostConfig: {
      NetworkMode: parts.networkMode ?? "bridge",
      Binds: parts.binds ?? null,
      PortBindings: parts.portBindings ?? null,
      ExtraHosts: parts.extraHosts ?? null,
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
  tag: "9.0.0",
  env: { FOO: "2" },
};

describe("ensureRunning — config drift triggers automatic recreate", () => {
  it("calls remove + recreate when env drifts on a running container", async () => {
    const calls = new Map<string, unknown[]>();
    // First inspect: running + drifted env. After remove, the container is
    // gone (404 → "missing"), so the recursive ensureRunning lands in the
    // missing branch and creates a fresh one.
    const inspect = (): Promise<Json> => {
      if ((calls.get("remove") ?? []).length > 0) {
        return Promise.reject(notFound("no such object"));
      }
      return Promise.resolve(
        buildLiveInspect({
          image: "questdb/questdb:9.0.0",
          env: ["FOO=1"],
        }),
      );
    };
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect } },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    // Assert: stop + remove happened (removeContainer issues both), then a
    // fresh createContainer in the missing branch.
    assert.ok((calls.get("stop") ?? []).length > 0, "stop should be called");
    assert.ok(
      (calls.get("remove") ?? []).length > 0,
      "remove should be called",
    );
    assert.ok(
      (calls.get("createContainer") ?? []).length > 0,
      "createContainer should be called",
    );
    // Drift line in debug.
    assert.ok(
      debugLines.some((l) => l.includes("config drift detected")),
      `expected 'config drift detected' in debug, got: ${debugLines.join(" | ")}`,
    );
  });

  it("keeps a running container (no startup failure) when removal fails with a permission error", async () => {
    // A rootless container can wedge unkillable in `Stopping` — podman's
    // remove returns "operation not permitted". With drift present, the
    // recreate must NOT propagate that into a startup failure; the existing
    // running container is kept and the recreate is deferred.
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          // The real wedge shape observed live: Status=stopping, Running=false,
          // but a live Pid — getContainerState ORs on the live PID and reports
          // "running", which is exactly what the guard relies on. Drifted env
          // so a recreate is attempted; never goes missing (remove fails).
          inspect: () =>
            Promise.resolve(
              buildLiveInspect({
                state: { status: "stopping", running: false, pid: 12345 },
                image: "questdb/questdb:9.0.0",
                env: ["FOO=1"],
              }),
            ),
          remove: () => Promise.reject(new Error("operation not permitted")),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    const debugLines: string[] = [];
    // Must resolve, not reject.
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    assert.ok(
      (calls.get("remove") ?? []).length > 0,
      "remove should have been attempted",
    );
    assert.equal(
      (calls.get("createContainer") ?? []).length,
      0,
      "must NOT create a new container when the old one can't be removed",
    );
    assert.ok(
      debugLines.some((l) => l.includes("keeping it and")),
      `expected the keep-and-defer debug line, got: ${debugLines.join(" | ")}`,
    );
  });

  it("announces the wedge via onContainerWedged, once, with a recovery hint", async () => {
    _clearAnnouncedWedgedForTesting();
    const makeWedgedClient = () =>
      makeMockClient({
        containers: {
          "sk-questdb": {
            inspect: () =>
              Promise.resolve(
                buildLiveInspect({
                  state: { status: "stopping", running: false, pid: 12345 },
                  image: "questdb/questdb:9.0.0",
                  env: ["FOO=1"],
                }),
              ),
            remove: () => Promise.reject(new Error("operation not permitted")),
          },
        },
        images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      });

    const wedged: ContainerWedged[] = [];
    const opts = {
      onContainerWedged: (e: ContainerWedged) => {
        wedged.push(e);
      },
    };

    // Two reconciles of the same wedged container.
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      makeWedgedClient(),
    );
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      makeWedgedClient(),
    );

    assert.equal(wedged.length, 1, "the wedge must be announced exactly once");
    assert.equal(wedged[0].name, "questdb");
    assert.match(wedged[0].drift, /env/);
    assert.match(wedged[0].reason, /operation not permitted/);
    assert.match(wedged[0].reason, /system migrate/);
    assert.match(wedged[0].reason, /data is safe|bind mount/i);
  });

  it("re-arms after the operator externally removes the wedged container (missing → recreate)", async () => {
    // The advisory tells the operator to `<runtime> rm -f <name>`. After that
    // the next reconcile finds the container MISSING and creates a fresh one —
    // a path that is neither the no-drift nor the in-process-recreate clear.
    // The name must still be re-armed so a future wedge on the reused name is
    // announced again (regression guard: it was previously stranded forever).
    _clearAnnouncedWedgedForTesting();
    const wedgedClient = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () =>
            Promise.resolve(
              buildLiveInspect({
                state: { status: "stopping", running: false, pid: 12345 },
                image: "questdb/questdb:9.0.0",
                env: ["FOO=1"],
              }),
            ),
          remove: () => Promise.reject(new Error("operation not permitted")),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
    });
    // Operator removed it externally: now missing → the create branch runs.
    const missingClient = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () => Promise.reject(notFound("no such object")),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
    });

    const wedged: ContainerWedged[] = [];
    const opts = {
      onContainerWedged: (e: ContainerWedged) => {
        wedged.push(e);
      },
    };

    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      wedgedClient,
    );
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      missingClient,
    );
    // Wedges again after the fresh container was created.
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      wedgedClient,
    );

    assert.equal(
      wedged.length,
      2,
      "a container going missing must re-arm the advisory (external rm -f recovery)",
    );
  });

  it("uses socket/mount wording (not the userns remedy) for a permission-denied removal", async () => {
    // `kind === "permission"` also matches EACCES / "permission denied"
    // (socket or mount perms), which is NOT an orphaned userns — the advisory
    // must not tell the operator to run `system migrate` in that case.
    _clearAnnouncedWedgedForTesting();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () =>
            Promise.resolve(
              buildLiveInspect({
                state: { status: "running", running: true, pid: 12345 },
                image: "questdb/questdb:9.0.0",
                env: ["FOO=1"],
              }),
            ),
          remove: () => Promise.reject(new Error("permission denied")),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
    });
    const wedged: ContainerWedged[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      {
        onContainerWedged: (e: ContainerWedged) => {
          wedged.push(e);
        },
      },
      client,
    );
    assert.equal(wedged.length, 1);
    assert.match(wedged[0].reason, /permission denied/);
    assert.doesNotMatch(
      wedged[0].reason,
      /system migrate|user namespace/,
      "socket/mount permission errors must not suggest the userns remedy",
    );
  });

  it("re-arms the wedge advisory once the container recovers (no drift)", async () => {
    _clearAnnouncedWedgedForTesting();
    const wedgedClient = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () =>
            Promise.resolve(
              buildLiveInspect({
                state: { status: "stopping", running: false, pid: 12345 },
                image: "questdb/questdb:9.0.0",
                env: ["FOO=1"],
              }),
            ),
          remove: () => Promise.reject(new Error("operation not permitted")),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
    });
    // A healthy container matching the request → diffContainerConfig finds
    // no drift, which clears the announcement.
    const recoveredClient = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: buildLiveInspect({
            image: "questdb/questdb:9.0.0",
            env: ["FOO=1"],
            extraHosts: ["host.containers.internal:host-gateway"],
          }),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
    });

    const wedged: ContainerWedged[] = [];
    const opts = {
      onContainerWedged: (e: ContainerWedged) => {
        wedged.push(e);
      },
    };

    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      wedgedClient,
    );
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      recoveredClient,
    );
    // Wedged again after recovery → announced a second time.
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      wedgedClient,
    );

    assert.equal(
      wedged.length,
      2,
      "recovery must re-arm the advisory so a later wedge is announced again",
    );
  });

  it("re-arms after a successful recreate clears the wedge (still-drifting recovery)", async () => {
    // The real recovery path on the reporter's box: wedged, then the
    // operator frees the container so remove now succeeds while drift is
    // STILL present. The recreate succeeds → the success branch clears the
    // announcement (not the no-drift branch), so a later wedge re-announces.
    _clearAnnouncedWedgedForTesting();

    const wedgedClient = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () =>
            Promise.resolve(
              buildLiveInspect({
                state: { status: "stopping", running: false, pid: 12345 },
                image: "questdb/questdb:9.0.0",
                env: ["FOO=1"],
              }),
            ),
          remove: () => Promise.reject(new Error("operation not permitted")),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
    });

    // Drift is still present (env FOO=1 vs requested FOO=2) but remove now
    // succeeds, so the recursive ensureRunning recreates in the missing
    // branch.
    const recreateCalls = new Map<string, unknown[]>();
    const recoverAndRecreateClient = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () => {
            if ((recreateCalls.get("remove") ?? []).length > 0) {
              return Promise.reject(notFound("no such object"));
            }
            return Promise.resolve(
              buildLiveInspect({
                state: { status: "running", running: true, pid: 12345 },
                image: "questdb/questdb:9.0.0",
                env: ["FOO=1"],
              }),
            );
          },
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls: recreateCalls,
    });

    const wedged: ContainerWedged[] = [];
    const opts = {
      onContainerWedged: (e: ContainerWedged) => {
        wedged.push(e);
      },
    };

    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      wedgedClient,
    );
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      recoverAndRecreateClient,
    );
    await ensureRunning(
      docker,
      "questdb",
      requested,
      () => {},
      opts,
      wedgedClient,
    );

    assert.ok(
      (recreateCalls.get("createContainer") ?? []).length > 0,
      "the recovery reconcile must actually recreate the container",
    );
    assert.equal(
      wedged.length,
      2,
      "a successful recreate must re-arm the advisory for a later wedge",
    );
  });

  it("does NOT recreate when no drift (early-return path preserved)", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: buildLiveInspect({
            image: "questdb/questdb:9.0.0",
            env: ["FOO=2"],
            // Docker runtime always carries the auto-injected host-gateway
            // entry; include it in live so diffContainerConfig finds
            // extraHosts symmetric.
            extraHosts: ["host.containers.internal:host-gateway"],
          }),
        },
      },
      calls,
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    assert.equal((calls.get("stop") ?? []).length, 0);
    assert.equal((calls.get("remove") ?? []).length, 0);
    assert.equal((calls.get("createContainer") ?? []).length, 0);
    assert.ok(
      debugLines.some((l) => l.includes("already running")),
      `expected 'already running' in debug, got: ${debugLines.join(" | ")}`,
    );
  });

  it("treats inspect failure during diff as 'cannot diff, skip' (no recreate)", async () => {
    const calls = new Map<string, unknown[]>();
    // getContainerState's inspect succeeds (running), but
    // getLiveContainerConfig's inspect fails. A 404-shaped error makes
    // safeInspect return null → "could not inspect" (the fail-safe path;
    // non-404 errors are a real daemon fault and rethrow).
    let stateProbeDone = false;
    const inspect = (): Promise<Json> => {
      if (!stateProbeDone) {
        stateProbeDone = true;
        return Promise.resolve(
          buildLiveInspect({ image: "questdb/questdb:9.0.0", env: ["FOO=1"] }),
        );
      }
      return Promise.reject(notFound("boom"));
    };
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect } },
      calls,
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    assert.equal((calls.get("remove") ?? []).length, 0);
    assert.ok(
      debugLines.some((l) => l.includes("could not inspect for drift")),
    );
  });

  it("_postRecreate guard prevents recursion if state stays 'running'", async () => {
    // Force inspect to ALWAYS report "running" with drifted config, even
    // after remove. Real-world this would be a race or a restart-policy
    // auto-restart; we want the guard to short-circuit, not infinite-loop.
    const calls = new Map<string, unknown[]>();
    const inspect = (): Promise<Json> =>
      Promise.resolve(
        buildLiveInspect({ image: "questdb/questdb:9.0.0", env: ["FOO=1"] }),
      );
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect } },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    // First pass diffs + removes once. The recursive _postRecreate pass sees
    // state "running" again, hits the guard, and returns silently — it does
    // NOT diff-and-remove a second time, so remove fires exactly once.
    assert.equal(
      (calls.get("remove") ?? []).length,
      1,
      "remove should fire exactly once (guard breaks the loop)",
    );
    assert.ok(
      debugLines.some((l) => l.includes("unexpectedly running after recreate")),
      `expected guard message in debug, got: ${debugLines.join(" | ")}`,
    );
    // No fresh container created (the recursion guard returned before the
    // missing-branch create path could fire).
    assert.equal((calls.get("createContainer") ?? []).length, 0);
  });
});

describe("ensureRunning — stopped-state drift detection", () => {
  it("recreates a STOPPED container when its config has drifted (not just starts it)", async () => {
    // Without the stopped-state diff, the old container would be `start`ed
    // back up with stale env.
    const calls = new Map<string, unknown[]>();
    const inspect = (): Promise<Json> => {
      // Container is stopped on first probe. After remove, missing.
      if ((calls.get("remove") ?? []).length > 0) {
        return Promise.reject(notFound("no such object"));
      }
      return Promise.resolve(
        buildLiveInspect({
          state: { status: "exited", running: false, pid: 0 },
          image: "questdb/questdb:9.0.0",
          env: ["FOO=1"], // live still has the OLD value
        }),
      );
    };
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect } },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    assert.ok(
      (calls.get("remove") ?? []).length > 0,
      "stopped+drifted should be removed",
    );
    assert.ok(
      (calls.get("createContainer") ?? []).length > 0,
      "stopped+drifted should be recreated",
    );
    // The stopped+drifted container must be REMOVED and recreated, never
    // started in place with stale config. The fresh container that
    // createAndStart spins up reuses the same prefixed name (sk-questdb) and
    // gets exactly one post-create start — so the only `start` is the
    // recreate's, never a standalone "start the stale container" call. Equal
    // start/createContainer counts prove no stray in-place start happened.
    const started = (calls.get("start") ?? []) as string[];
    assert.equal(
      started.length,
      (calls.get("createContainer") ?? []).length,
      "the only start should be the recreated container's, not an in-place start of the stale one",
    );
    assert.ok(
      debugLines.some((l) => l.includes("config drift detected")),
      `expected drift message, got: ${debugLines.join(" | ")}`,
    );
  });

  it("starts a STOPPED container without recreating when no drift", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: buildLiveInspect({
            state: { status: "exited", running: false, pid: 0 },
            image: "questdb/questdb:9.0.0",
            env: ["FOO=2"], // matches requested
            // Docker runtime always carries the auto-injected host-gateway
            // entry; include it in live so diffContainerConfig finds
            // extraHosts symmetric.
            extraHosts: ["host.containers.internal:host-gateway"],
          }),
        },
      },
      calls,
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    const started = (calls.get("start") ?? []) as string[];
    assert.ok(started.includes("sk-questdb"));
    assert.equal((calls.get("remove") ?? []).length, 0);
    assert.equal((calls.get("createContainer") ?? []).length, 0);
    assert.ok(debugLines.some((l) => l.includes("Starting stopped container")));
  });

  it("starts a STOPPED container without diff when inspect fails (fail-safe)", async () => {
    const calls = new Map<string, unknown[]>();
    // State probe succeeds (stopped); the drift Config probe 404s → null →
    // "could not inspect"; fail-safe still starts.
    let stateProbeDone = false;
    const inspect = (): Promise<Json> => {
      if (!stateProbeDone) {
        stateProbeDone = true;
        return Promise.resolve(
          buildLiveInspect({
            state: { status: "exited", running: false, pid: 0 },
            image: "questdb/questdb:9.0.0",
            env: ["FOO=1"],
          }),
        );
      }
      return Promise.reject(notFound("boom"));
    };
    const client = makeMockClient({
      containers: { "sk-questdb": { inspect } },
      calls,
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    const started = (calls.get("start") ?? []) as string[];
    assert.ok(
      started.includes("sk-questdb"),
      "should still start when diff inspect fails",
    );
    assert.equal((calls.get("remove") ?? []).length, 0);
    assert.ok(
      debugLines.some((l) => l.includes("could not inspect for drift")),
    );
  });
});

describe("ensureRunning — buildCreateOptions ownership", () => {
  // Capture the createContainer payload by driving the missing-state path
  // (no inspect-drift logic involved): the container is missing (no inspect
  // registered → 404), the image is present, then createContainer fires.
  function captureCreateOnMissing(config: ContainerConfig): {
    payload: () => Json | null;
    run: () => Promise<void>;
  } {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      // Container missing: not registered → inspect 404 → "missing".
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    return {
      payload() {
        const created = calls.get("createContainer") ?? [];
        return (created[0] as Json | undefined) ?? null;
      },
      run: () =>
        ensureRunning(docker, "demo", config, () => {}, undefined, client),
    };
  }

  it("emits User host:host by default (in-image uid 0 maps to host 1000:1000)", async () => {
    const cap = captureCreateOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
    });
    await cap.run();
    const payload = cap.payload();
    assert.ok(payload, "createContainer should have been issued");
    assert.equal(payload.User, "1000:1000");
  });

  it("omits User when ContainerConfig.user is false (opt-out)", async () => {
    const cap = captureCreateOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
      user: false,
    });
    await cap.run();
    const payload = cap.payload();
    assert.ok(payload);
    assert.equal(payload.User, undefined, "User should not be set");
    const hostConfig = (payload.HostConfig ?? {}) as Json;
    assert.equal(
      hostConfig.UsernsMode,
      undefined,
      "UsernsMode should not be set on the docker path",
    );
  });

  it("does NOT inject any UMASK env var (image controls umask, not us)", async () => {
    // The image and its entrypoint own the container process's umask.
    // Most Linux binaries (Node.js, kopia, rclone, …) don't read the
    // UMASK env var, so auto-injecting it would advertise a guarantee
    // signalk-container can't deliver.
    const cap = captureCreateOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
    });
    await cap.run();
    const payload = cap.payload();
    assert.ok(payload);
    const env = (payload.Env ?? []) as string[];
    assert.ok(
      !env.some((a) => a.startsWith("UMASK=")),
      `no UMASK env should be auto-injected; got: ${env.join(" ")}`,
    );
  });

  it("passes caller-provided UMASK in config.env through verbatim", async () => {
    // Plugin authors can still set UMASK in env if their image's
    // entrypoint script honors it. We just don't pretend to.
    const cap = captureCreateOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
      env: { UMASK: "0027" },
    });
    await cap.run();
    const payload = cap.payload();
    assert.ok(payload);
    const env = (payload.Env ?? []) as string[];
    assert.ok(env.includes("UMASK=0027"));
  });

  it("emits Labels from config.labels", async () => {
    const cap = captureCreateOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
      labels: {
        "io.signalk.role": "updater",
        "io.signalk.persistent": "true",
      },
    });
    await cap.run();
    const payload = cap.payload();
    assert.ok(payload);
    const labels = (payload.Labels ?? {}) as Record<string, string>;
    assert.equal(
      labels["io.signalk.role"],
      "updater",
      `expected role label, got: ${JSON.stringify(labels)}`,
    );
    assert.equal(
      labels["io.signalk.persistent"],
      "true",
      `expected persistent label, got: ${JSON.stringify(labels)}`,
    );
  });

  it("emits only the provenance label when config.labels is unset", async () => {
    const cap = captureCreateOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
    });
    await cap.run();
    const payload = cap.payload();
    assert.ok(payload);
    // The requested-resources provenance label is always stamped; no
    // consumer labels means nothing else.
    assert.deepEqual(payload.Labels, {
      [requestedResourcesLabel()]: "{}",
    });
  });
});
