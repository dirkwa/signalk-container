import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntime } from "../../runtime.js";
import { getClient } from "../../client.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const CONTAINER_NAME = "skc-portreuse-test";
const CONTAINER_PORT = 18098;

// trap-and-wait so the container exits promptly on SIGTERM (see
// recreate.test.ts for the rationale).
const TRAP_AND_WAIT_CMD = ["sh", "-c", "trap exit TERM; sleep 60 & wait"];

/**
 * Boot the real plugin against a fresh temp data dir — a fresh boot models
 * a signalk-server restart: the in-memory port cache starts empty, so the
 * loopback branch must recover the host port from the live container's
 * bindings instead of probing (the probe would collide with the port our
 * own running container publishes and the resulting drift would recreate
 * it on every restart).
 */
async function bootPlugin(): Promise<{
  api: ContainerManagerApi;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-portreuse-test-"));
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
  await plugin.start({ disableUserNamespaceRemap: true } as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  return {
    api,
    stop: async () => {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function liveContainerId(): Promise<string> {
  const info = (await getClient()
    .getContainer(`sk-${CONTAINER_NAME}`)
    .inspect()) as { Id: string };
  return info.Id;
}

describe("signalkAccessiblePorts — host port survives a plugin restart", () => {
  after(async () => {
    const runtime = await hasContainerRuntime();
    if (!runtime) return;
    const { api, stop } = await bootPlugin();
    try {
      await api.remove(CONTAINER_NAME);
    } catch {
      // best-effort cleanup
    }
    await stop();
  });

  it("reuses the live binding instead of drift-recreating", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const config = {
      image: "docker.io/library/alpine",
      tag: "3.19",
      command: TRAP_AND_WAIT_CMD,
      restart: "no" as const,
      signalkAccessiblePorts: [CONTAINER_PORT],
    };

    // First plugin lifetime: create the container, note address + id.
    // Leaked plugin instances keep timers running and hang the test
    // runner, so each lifetime stops its plugin even on failure; the
    // suite-level after() removes any leftover container.
    const first = await bootPlugin();
    let addr1: string | null;
    let id1: string;
    try {
      try {
        await first.api.remove(CONTAINER_NAME);
      } catch {
        // OK if it didn't exist.
      }
      await first.api.ensureRunning(CONTAINER_NAME, config);
      addr1 = await first.api.resolveContainerAddress!(
        CONTAINER_NAME,
        CONTAINER_PORT,
      );
      id1 = await liveContainerId();
    } finally {
      await first.stop();
    }
    assert.ok(addr1, "first lifetime must resolve an address");

    // Second plugin lifetime = simulated signalk-server restart. The
    // container from the first lifetime is still running and still owns
    // the published host port.
    const second = await bootPlugin();
    try {
      await second.api.ensureRunning(CONTAINER_NAME, config);
      const addr2 = await second.api.resolveContainerAddress!(
        CONTAINER_NAME,
        CONTAINER_PORT,
      );
      const id2 = await liveContainerId();

      assert.ok(addr2, "second lifetime must resolve an address");
      assert.equal(
        addr2,
        addr1,
        "resolved address must be stable across restarts",
      );
      assert.equal(
        id2,
        id1,
        "container must not be recreated by a port-probe collision with itself",
      );

      await second.api.remove(CONTAINER_NAME);
    } finally {
      await second.stop();
    }
  });
});
