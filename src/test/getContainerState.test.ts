import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getContainerState, getContainerStateDetail } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient, storageCorrupt500 } from "./helpers/mockClient.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

describe("getContainerState", () => {
  it("returns 'missing' when the container does not exist (inspect 404)", async () => {
    // No entry in `containers` and no `defaultContainer` → inspect throws
    // a 404, which the production code maps to "missing".
    const client = makeMockClient({});
    const result = await getContainerState(dummyRuntime, "ghost", client);
    assert.equal(result, "missing");
  });

  it("returns 'running' when Status=running, Running=true, Pid>0 (happy case)", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "running", Running: true, Pid: 12345 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("returns 'stopped' when Status=exited, Running=false, Pid=0", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "exited", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("returns 'running' when only Status says running (Running=false, Pid=0)", async () => {
    // Defensive: one data source is enough to trust "running".
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "running", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("returns 'running' when Status lies but Running=true (rootless podman transient state flap)", async () => {
    // This is the exact observed failure mode on Dirk's VM:
    // `State.Status` returns "stopped" for an actually-running container,
    // briefly and intermittently, under concurrent inspect load. But
    // Running=true and Pid>0 are correct. Our OR logic catches it.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "stopped", Running: true, Pid: 54321 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("returns 'running' when only Pid is positive (Running unavailable, Status wrong)", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "stopped", Running: false, Pid: 12345 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("returns 'stopped' for a genuinely stopped container with 'stopped' status", async () => {
    // Covers the path where Status is literally "stopped" (vs "exited"
    // which is the more common podman state for a clean stop). Both
    // should map to our "stopped" state.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "stopped", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("returns 'stopped' for 'created' state (container exists, never started)", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "created", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("uppercase/mixed-case Status is normalized before comparison", async () => {
    // Status is lowercased + trimmed before comparison, so a runtime that
    // reports "Running" still maps to "running".
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "Running", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("prefixes the container name with sk- automatically", async () => {
    // Only the "sk-foo" key is mocked; an unprefixed lookup would 404.
    const client = makeMockClient({
      containers: {
        "sk-foo": {
          inspect: { State: { Status: "running", Running: true, Pid: 1 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "foo", client);
    assert.equal(result, "running");
  });

  it("does not double-prefix when the name already starts with sk-", async () => {
    const client = makeMockClient({
      containers: {
        "sk-foo": {
          inspect: { State: { Status: "running", Running: true, Pid: 1 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "sk-foo", client);
    assert.equal(result, "running");
  });

  it("returns 'stopped' for an absent State object", async () => {
    // Defensive: if inspect somehow returns no State, we don't want a
    // false "running". (false positive is worse than false negative here
    // — but note the tradeoff: ensureRunning's "already running" fast
    // path would then do a redundant start attempt, which is safe).
    const client = makeMockClient({
      containers: { "sk-x": { inspect: {} } },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("returns 'stopped' for non-numeric Pid", async () => {
    // Pid field has garbage; Status=exited, Running=false. Should be stopped.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: { Status: "exited", Running: false, Pid: "notanumber" },
          },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("rethrows a storage-corruption 500 with the classified cause (issue #219)", async () => {
    // The recovery in ensureRunning depends on this contract: a corrupt
    // container is NOT reported as "missing" — the error propagates with
    // cause.kind === "storage-corrupt" so the caller can remove + recreate.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: storageCorrupt500(),
        },
      },
    });
    await assert.rejects(
      getContainerState(dummyRuntime, "x", client),
      (err: Error) => {
        assert.match(err.message, /storage is corrupt/i);
        assert.equal(
          (err.cause as { kind?: string } | undefined)?.kind,
          "storage-corrupt",
        );
        return true;
      },
    );
  });

  it("negative Pid is treated as not-running", async () => {
    // Paranoid: some runtimes might use -1 to mean "no process".
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "exited", Running: false, Pid: -1 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });
});

describe("getContainerStateDetail", () => {
  // The coarse state alone cannot tell a container that crashlooped 200
  // times from one the operator stopped. All of this detail was already
  // in the inspect payload getContainerState fetches; it was discarded.

  it("reports 'missing' with no detail when the container is gone", async () => {
    const client = makeMockClient({});
    const detail = await getContainerStateDetail("ghost", client);
    assert.deepEqual(detail, { state: "missing" });
  });

  it("surfaces exit code, OOM kill and restart count on a dead container", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: {
              Status: "exited",
              Running: false,
              Pid: 0,
              ExitCode: 137,
              OOMKilled: true,
              RestartCount: 42,
            },
          },
        },
      },
    });
    const detail = await getContainerStateDetail("x", client);
    assert.equal(detail.state, "stopped");
    assert.equal(detail.exitCode, 137);
    assert.equal(detail.oomKilled, true);
    assert.equal(detail.restartCount, 42);
  });

  it("distinguishes a clean stop from a crash", async () => {
    // The whole point: both are `state: "stopped"`, and only the exit
    // code separates a deliberate stop from a failure.
    const stopped = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: { Status: "exited", ExitCode: 0, RestartCount: 0 },
          },
        },
      },
    });
    const crashed = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: { Status: "exited", ExitCode: 1, RestartCount: 87 },
          },
        },
      },
    });
    const a = await getContainerStateDetail("x", stopped);
    const b = await getContainerStateDetail("x", crashed);
    assert.equal(a.state, b.state);
    assert.equal(a.exitCode, 0);
    assert.equal(b.exitCode, 1);
    assert.equal(b.restartCount, 87);
  });

  it("surfaces the healthcheck verdict when the image defines one", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: {
              Status: "running",
              Running: true,
              Pid: 99,
              Health: { Status: "unhealthy" },
            },
          },
        },
      },
    });
    const detail = await getContainerStateDetail("x", client);
    assert.equal(detail.state, "running");
    assert.equal(detail.health, "unhealthy");
  });

  it("leaves fields undefined rather than inventing zeros", async () => {
    // A runtime that omits a field must not be reported as exit code 0
    // and zero restarts — that reads as a clean stop that never happened.
    const client = makeMockClient({
      containers: {
        "sk-x": { inspect: { State: { Status: "running", Running: true } } },
      },
    });
    const detail = await getContainerStateDetail("x", client);
    assert.equal(detail.exitCode, undefined);
    assert.equal(detail.oomKilled, undefined);
    assert.equal(detail.restartCount, undefined);
    assert.equal(detail.health, undefined);
  });

  it("treats a null exit code as absent, not as a clean exit", async () => {
    // dockerode types ExitCode as `number | null`. `Number(null)` is a
    // finite 0, so a naive coercion reports a successful exit for a
    // container that never reported one at all.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: {
              Status: "exited",
              ExitCode: null,
              RestartCount: null,
            },
          },
        },
      },
    });
    const detail = await getContainerStateDetail("x", client);
    assert.equal(detail.exitCode, undefined);
    assert.equal(detail.restartCount, undefined);
  });

  it("ignores non-numeric exit code and restart count values", async () => {
    // "" and [] also coerce to a finite 0 through Number().
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: { Status: "exited", ExitCode: "", RestartCount: [] },
          },
        },
      },
    });
    const detail = await getContainerStateDetail("x", client);
    assert.equal(detail.exitCode, undefined);
    assert.equal(detail.restartCount, undefined);
  });

  it("serializes to JSON with state alongside the diagnostics", async () => {
    // The REST route spreads this object next to `name`, so every field
    // has to survive JSON.stringify and `state` must stay top-level for
    // existing consumers that read it there.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: {
              Status: "exited",
              ExitCode: 137,
              OOMKilled: true,
              RestartCount: 3,
              Health: { Status: "unhealthy" },
            },
          },
        },
      },
    });
    const detail = await getContainerStateDetail("x", client);
    const body = JSON.parse(JSON.stringify({ name: "x", ...detail }));
    assert.deepEqual(body, {
      name: "x",
      state: "stopped",
      exitCode: 137,
      oomKilled: true,
      restartCount: 3,
      health: "unhealthy",
    });
  });

  it("ignores an unrecognised health status", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: { Status: "running", Health: { Status: "weird" } },
          },
        },
      },
    });
    assert.equal(
      (await getContainerStateDetail("x", client)).health,
      undefined,
    );
  });

  it("agrees with getContainerState on the podman inconsistent-Status flake", async () => {
    // Status is momentarily stale but Pid is live: both functions must
    // say running, or a caller asking for detail would see a different
    // answer than one asking for the coarse state.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "", Running: false, Pid: 4242 } },
        },
      },
    });
    assert.equal(await getContainerState(dummyRuntime, "x", client), "running");
    assert.equal((await getContainerStateDetail("x", client)).state, "running");
  });
});
