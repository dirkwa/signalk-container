import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClient } from "../../client.js";
import { prefixedName } from "../../containers.js";
import { detectRuntime } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerConfig,
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

/**
 * A container created with a memory cap and no memorySwap gets a swap
 * limit from the runtime. Read back as a limit somebody set, it made every
 * start log "cannot live-unset fields memorySwap" and every
 * updateResources force a recreate. What the runtime sets is reported per
 * runtime; that the plugin neither logs the error nor recreates is
 * asserted.
 */

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const CONTAINER = "memory-swap-default";
const MEMORY = "64m";
const UPDATED_MEMORY = "96m";
// Exit promptly on SIGTERM so remove() does not wait out the stop grace.
const WAIT_UNTIL_TERM = ["sh", "-c", "trap exit TERM; sleep 600 & wait"];
const CONFIG: ContainerConfig = {
  image: "docker.io/library/alpine",
  tag: "3.19",
  command: WAIT_UNTIL_TERM,
  resources: { memory: MEMORY },
};

async function liveMemory(): Promise<{ memory: number; swap: number }> {
  const info = await getClient()
    .getContainer(prefixedName(CONTAINER))
    .inspect();
  const hc = info.HostConfig as { Memory?: number; MemorySwap?: number };
  return { memory: hc.Memory ?? 0, swap: hc.MemorySwap ?? 0 };
}

interface Booted {
  api: ContainerManagerApi;
  errors: string[];
  stop: () => Promise<void>;
}

/** Boot the plugin with an `app.error` that records every message. */
async function bootPlugin(dataDir: string): Promise<Booted> {
  const errors: string[] = [];
  const noop = () => {};
  const plugin = containerManagerPlugin({
    debug: noop,
    error: (...args: unknown[]) => {
      errors.push(String(args[0]));
    },
    setPluginStatus: noop,
    setPluginError: noop,
    getDataDirPath: () => dataDir,
    config: { configPath: dataDir },
  });
  await plugin.start({ disableUserNamespaceRemap: true } as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  return {
    api,
    errors,
    stop: async () => {
      if (plugin.stop) await plugin.stop();
    },
  };
}

function unsetErrors(errors: string[]): string[] {
  return errors.filter((m) => m.includes("cannot live-unset"));
}

describe("the runtime's default memorySwap", () => {
  let dataDir: string | undefined;
  let booted: Booted | undefined;
  let memoryDelegated = true;

  before(async () => {
    const runtime = await hasContainerRuntime();
    if (!runtime) return;
    memoryDelegated =
      !runtime.cgroupControllers ||
      runtime.cgroupControllers.includes("memory");
    dataDir = mkdtempSync(join(tmpdir(), "skc-memory-swap-"));
    booted = await bootPlugin(dataDir);
  });

  after(async () => {
    if (booted) {
      try {
        await booted.api.remove(CONTAINER);
      } catch {
        // best-effort cleanup
      }
      await booted.stop();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("is not reported as an unset, warm or after a restart, nor before an update", async (t) => {
    if (!booted || !dataDir) {
      t.skip("no container runtime available");
      return;
    }
    if (!memoryDelegated) {
      t.skip("memory cgroup controller not delegated");
      return;
    }
    try {
      await booted.api.remove(CONTAINER);
    } catch {
      // OK if it didn't exist.
    }

    await booted.api.ensureRunning(CONTAINER, CONFIG);
    const created = await liveMemory();
    t.diagnostic(
      `created with memory ${MEMORY}: Memory=${created.memory} MemorySwap=${created.swap}`,
    );

    // A second start in the same process: the warm-cache provenance path.
    await booted.api.ensureRunning(CONTAINER, CONFIG);
    assert.deepEqual(unsetErrors(booted.errors), []);

    // A server restart: a fresh plugin reads provenance from the label.
    await booted.stop();
    booted = await bootPlugin(dataDir);
    await booted.api.ensureRunning(CONTAINER, CONFIG);
    assert.deepEqual(unsetErrors(booted.errors), []);

    // Changing the memory cap must not need a recreate for the swap.
    const result = await booted.api.updateResources(CONTAINER, {
      memory: UPDATED_MEMORY,
    });
    assert.equal(result.method, "live", JSON.stringify(result));
    const updated = await liveMemory();
    t.diagnostic(
      `after a live update to ${UPDATED_MEMORY}: Memory=${updated.memory} MemorySwap=${updated.swap}`,
    );

    // And the swap the runtime left after that update is not reported
    // as an unset on the next start either.
    await booted.api.ensureRunning(CONTAINER, CONFIG);
    await booted.stop();
    booted = await bootPlugin(dataDir);
    await booted.api.ensureRunning(CONTAINER, CONFIG);
    assert.deepEqual(unsetErrors(booted.errors), []);
  });
});
