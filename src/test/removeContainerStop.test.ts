import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContainerRemovalError, removeContainer } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.8.6",
  isPodmanDockerShim: false,
  isRootless: true,
};

async function stopOptsOf(graceful?: boolean): Promise<unknown[]> {
  const calls = new Map<string, unknown[]>();
  const client = makeMockClient({
    containers: {
      "sk-questdb": {
        inspect: { State: { Status: "running", Running: true, Pid: 12345 } },
      },
    },
    calls,
  });
  await removeContainer(
    podman,
    "questdb",
    client,
    graceful === undefined ? undefined : { graceful },
  );
  assert.equal((calls.get("remove") ?? []).length, 1);
  return (calls.get("stop") ?? []).map((c) => (c as { opts: unknown }).opts);
}

describe("removeContainer — how the container is stopped", () => {
  it("kills at once by default (t: 0)", async () => {
    assert.deepEqual(await stopOptsOf(), [{ t: 0 }]);
  });

  it("kills at once with graceful: false", async () => {
    assert.deepEqual(await stopOptsOf(false), [{ t: 0 }]);
  });

  it("leaves the runtime's stop timeout in place with graceful: true", async () => {
    // No `t`: the runtime sends SIGTERM and waits the container's stop
    // timeout before SIGKILL.
    assert.deepEqual(await stopOptsOf(true), [{}]);
  });
});

describe("removeContainer — a graceful stop the runtime refused", () => {
  function refusingClient(running: boolean, calls: Map<string, unknown[]>) {
    return makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: {
            State: {
              Status: running ? "running" : "exited",
              Running: running,
              Pid: running ? 12345 : 0,
            },
          },
          stop: () => Promise.reject(new Error("operation not permitted")),
        },
      },
      calls,
    });
  }

  it("throws instead of force-removing the still-running container", async () => {
    const calls = new Map<string, unknown[]>();
    await assert.rejects(
      removeContainer(podman, "questdb", refusingClient(true, calls), {
        graceful: true,
      }),
      (err: unknown) =>
        err instanceof ContainerRemovalError &&
        err.kind === "permission" &&
        /operation not permitted/.test(err.message),
    );
    assert.equal((calls.get("remove") ?? []).length, 0);
  });

  it("removes a container that is no longer running", async () => {
    const calls = new Map<string, unknown[]>();
    await removeContainer(podman, "questdb", refusingClient(false, calls), {
      graceful: true,
    });
    assert.equal((calls.get("remove") ?? []).length, 1);
  });

  it("force-removes without graceful, as before", async () => {
    const calls = new Map<string, unknown[]>();
    await removeContainer(podman, "questdb", refusingClient(true, calls));
    assert.equal((calls.get("remove") ?? []).length, 1);
  });
});
