import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ensureRunning,
  removeContainer,
  getContainerState,
  getLiveContainerConfig,
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

const CONTAINER_NAME = "recreate-test";

describe("recreate primitive (remove + ensureRunning)", () => {
  after(async () => {
    const runtime = await hasContainerRuntime();
    if (!runtime) return;
    try {
      await removeContainer(runtime, CONTAINER_NAME);
    } catch {
      // Best effort cleanup; ignore if already gone.
    }
  });

  it("replaces a running container's image with the new tag", async (t) => {
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

    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: "docker.io/library/alpine",
        tag: "3.18",
        // trap-and-wait so the container exits promptly on SIGTERM —
        // busybox `sleep` and `tail` ignore SIGTERM and force `podman stop`
        // into its 10s SIGKILL fallback, which races against execRuntime's
        // 10s execFile timeout and the subsequent `rm -f`.
        command: ["sh", "-c", "trap exit TERM; sleep 60 & wait"],
        restart: "no",
      },
      () => {},
    );
    const beforeState = await getContainerState(runtime, CONTAINER_NAME);
    assert.equal(beforeState, "running");
    const beforeLive = await getLiveContainerConfig(runtime, CONTAINER_NAME);
    assert.equal(beforeLive?.tag, "3.18", "first container should be 3.18");

    // Simulate the recreate wrapper: remove + ensureRunning with new tag.
    // No drift detection involved — the container is gone before the second
    // ensureRunning call lands in its case "missing" branch.
    await removeContainer(runtime, CONTAINER_NAME);
    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: "docker.io/library/alpine",
        tag: "3.19",
        // trap-and-wait so the container exits promptly on SIGTERM —
        // busybox `sleep` and `tail` ignore SIGTERM and force `podman stop`
        // into its 10s SIGKILL fallback, which races against execRuntime's
        // 10s execFile timeout and the subsequent `rm -f`.
        command: ["sh", "-c", "trap exit TERM; sleep 60 & wait"],
        restart: "no",
      },
      () => {},
    );

    const afterState = await getContainerState(runtime, CONTAINER_NAME);
    assert.equal(afterState, "running");
    const afterLive = await getLiveContainerConfig(runtime, CONTAINER_NAME);
    assert.equal(afterLive?.tag, "3.19", "recreated container should be 3.19");
    assert.notEqual(
      beforeLive?.tag,
      afterLive?.tag,
      "tag must actually change",
    );
  });

  it("recreate is idempotent when no live container exists", async (t) => {
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
    const initial = await getContainerState(runtime, CONTAINER_NAME);
    assert.equal(initial, "missing");

    // The wrapper's `state !== "missing"` guard means no remove is issued;
    // the subsequent ensureRunning creates from scratch.
    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: "docker.io/library/alpine",
        tag: "3.19",
        // trap-and-wait so the container exits promptly on SIGTERM —
        // busybox `sleep` and `tail` ignore SIGTERM and force `podman stop`
        // into its 10s SIGKILL fallback, which races against execRuntime's
        // 10s execFile timeout and the subsequent `rm -f`.
        command: ["sh", "-c", "trap exit TERM; sleep 60 & wait"],
        restart: "no",
      },
      () => {},
    );

    const final = await getContainerState(runtime, CONTAINER_NAME);
    assert.equal(final, "running");
  });
});
