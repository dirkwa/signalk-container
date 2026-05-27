import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRunning,
  removeContainer,
  getContainerState,
  getLiveContainerConfig,
} from "../../containers.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

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

// trap-and-wait so the container exits promptly on SIGTERM — busybox
// `sleep` and `tail` ignore SIGTERM and force `podman stop` into its 10s
// SIGKILL fallback, which races against execRuntime's 10s execFile
// timeout and the subsequent `rm -f`.
const TRAP_AND_WAIT_CMD = ["sh", "-c", "trap exit TERM; sleep 60 & wait"];

/**
 * Spin up the real signalk-container plugin against a temp data dir.
 * Returns the `ContainerManagerApi` the consumer-plugin side talks to,
 * plus a stop() callback. The runtime probe runs against the host's
 * actual podman/docker — tests gate on `hasContainerRuntime()` before
 * touching this.
 */
async function bootPlugin(): Promise<{
  api: ContainerManagerApi;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-recreate-test-"));
  // Minimal SignalK app shim. The plugin reads `getDataDirPath`,
  // `debug`, `error`, `setPluginStatus`, `setPluginError`; everything
  // else is optional.
  const noop = () => {};
  const app = {
    debug: noop,
    error: noop,
    setPluginStatus: noop,
    setPluginError: noop,
    getDataDirPath: () => dataDir,
    config: { configPath: dataDir },
  };
  const plugin = containerManagerPlugin(app);
  await plugin.start({} as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  // Wait for detectRuntime to settle. start() returns synchronously but
  // schedules an async runtime probe; whenReady resolves after that.
  await api.whenReady();
  return {
    api,
    stop: async () => {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("containers.recreate() — public API", () => {
  let api: ContainerManagerApi;
  let stopPlugin: () => Promise<void>;

  before(async () => {
    const runtime = await hasContainerRuntime();
    if (!runtime) return;
    const booted = await bootPlugin();
    api = booted.api;
    stopPlugin = booted.stop;
  });

  after(async () => {
    if (api) {
      try {
        await api.remove(CONTAINER_NAME);
      } catch {
        // best-effort cleanup
      }
    }
    if (stopPlugin) await stopPlugin();
  });

  it("replaces a running container's image with the new tag", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    try {
      await api.remove(CONTAINER_NAME);
    } catch {
      // OK if it didn't exist.
    }

    await api.ensureRunning(CONTAINER_NAME, {
      image: "docker.io/library/alpine",
      tag: "3.18",
      command: TRAP_AND_WAIT_CMD,
      restart: "no",
    });
    const beforeLive = await getLiveContainerConfig(runtime, CONTAINER_NAME);
    assert.equal(beforeLive?.tag, "3.18", "first container should be 3.18");

    // The function-boundary call we actually want to exercise.
    await api.recreate(CONTAINER_NAME, {
      image: "docker.io/library/alpine",
      tag: "3.19",
      command: TRAP_AND_WAIT_CMD,
      restart: "no",
    });

    const afterState = await api.getState(CONTAINER_NAME);
    assert.equal(afterState, "running");
    const afterLive = await getLiveContainerConfig(runtime, CONTAINER_NAME);
    assert.equal(afterLive?.tag, "3.19", "recreated container should be 3.19");
    assert.notEqual(
      beforeLive?.tag,
      afterLive?.tag,
      "tag must actually change",
    );
  });

  it("recreate is idempotent when no container exists", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    try {
      await api.remove(CONTAINER_NAME);
    } catch {
      // OK if it didn't exist.
    }
    const initial = await api.getState(CONTAINER_NAME);
    assert.equal(initial, "missing");

    // No prior container — recreate falls through to ensureRunning's
    // case "missing" branch, which pulls and creates from scratch.
    await api.recreate(CONTAINER_NAME, {
      image: "docker.io/library/alpine",
      tag: "3.19",
      command: TRAP_AND_WAIT_CMD,
      restart: "no",
    });

    const final = await api.getState(CONTAINER_NAME);
    assert.equal(final, "running");
  });
});

/**
 * Sanity coverage for the low-level primitives the wrapper composes,
 * decoupled from the SignalK plugin lifecycle. If the wrapper test
 * above hangs on plugin boot for any reason, this still catches a
 * regression in the underlying remove → ensureRunning sequence.
 */
describe("recreate primitive (low-level)", () => {
  after(async () => {
    const runtime = await hasContainerRuntime();
    if (!runtime) return;
    try {
      await removeContainer(runtime, CONTAINER_NAME + "-primitive");
    } catch {
      // best-effort cleanup
    }
  });

  it("primitive sequence replaces the tag", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const name = CONTAINER_NAME + "-primitive";
    try {
      await removeContainer(runtime, name);
    } catch {
      // OK
    }

    await ensureRunning(
      runtime,
      name,
      {
        image: "docker.io/library/alpine",
        tag: "3.18",
        command: TRAP_AND_WAIT_CMD,
        restart: "no",
      },
      () => {},
    );
    const beforeLive = await getLiveContainerConfig(runtime, name);
    assert.equal(beforeLive?.tag, "3.18");

    await removeContainer(runtime, name);
    await ensureRunning(
      runtime,
      name,
      {
        image: "docker.io/library/alpine",
        tag: "3.19",
        command: TRAP_AND_WAIT_CMD,
        restart: "no",
      },
      () => {},
    );

    const afterState = await getContainerState(runtime, name);
    assert.equal(afterState, "running");
    const afterLive = await getLiveContainerConfig(runtime, name);
    assert.equal(afterLive?.tag, "3.19");
  });
});
