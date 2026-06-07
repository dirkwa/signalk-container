import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureRunning,
  removeContainer,
  getContainerState,
} from "../../containers.js";
import { detectRuntime } from "../../runtime.js";
import type { ContainerRuntimeInfo } from "../../types.js";

// detectRuntime() resolves AND caches the dockerode client singleton, so a
// non-null result means the bare container-function calls below (which
// default to getClient()) have a live client — the production path.
async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const CONTAINER_NAME = "remove-stop-timeout-test";

describe("removeContainer skips SIGTERM grace", () => {
  after(async () => {
    const runtime = await hasContainerRuntime();
    if (!runtime) return;
    try {
      await removeContainer(runtime, CONTAINER_NAME);
    } catch {
      // best-effort cleanup
    }
  });

  it("completes promptly even when PID 1 ignores SIGTERM", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    try {
      await removeContainer(runtime, CONTAINER_NAME);
    } catch {
      // OK if it didn't exist.
    }

    // busybox `sleep` does NOT install a SIGTERM handler — the kernel
    // delivers SIGTERM but the process ignores it. Without `-t 0` in
    // removeContainer's `stop` call, `podman stop` waits its default
    // 10s grace, which collides with execRuntime's own 10s execFile
    // timeout.
    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: "docker.io/library/alpine",
        tag: "3.18",
        command: ["sleep", "60"],
        restart: "no",
      },
      () => {},
    );
    const before = await getContainerState(runtime, CONTAINER_NAME);
    assert.equal(before, "running");

    const startedAt = Date.now();
    await removeContainer(runtime, CONTAINER_NAME);
    const elapsedMs = Date.now() - startedAt;

    const after = await getContainerState(runtime, CONTAINER_NAME);
    assert.equal(after, "missing");
    // 5s is a generous ceiling — observed elapsed on the fix is ~300ms.
    // The pre-fix code would block ~10s on `stop` waiting for SIGKILL
    // fallback, then potentially fail `rm -f` against the in-flight
    // daemon state.
    assert.ok(
      elapsedMs < 5000,
      `removeContainer should not block on SIGTERM grace; took ${elapsedMs}ms`,
    );
  });
});
