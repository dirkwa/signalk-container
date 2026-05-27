import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ensureRunning,
  removeContainer,
  getContainerState,
} from "../../containers.js";
import type { ContainerRuntimeInfo } from "../../types.js";

const execFileP = promisify(execFile);

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  for (const rt of ["podman", "docker"] as const) {
    try {
      await execFileP(rt, ["--version"], { timeout: 5000 });
      return { runtime: rt, version: "test", isPodmanDockerShim: false };
    } catch {
      // try next
    }
  }
  return null;
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
