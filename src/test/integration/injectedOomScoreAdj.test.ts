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
 * Rootless podman gives a container the oom_score_adj of the service that
 * starts it. Read back as a limit, it made every start of an unchanged
 * container send a live resource update. What the runtime sets is
 * reported; that the plugin sends no update is asserted.
 */

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const CONTAINER = "injected-oom-score-adj";
// Exit promptly on SIGTERM so remove() does not wait out the stop grace.
const WAIT_UNTIL_TERM = ["sh", "-c", "trap exit TERM; sleep 600 & wait"];
const CONFIG: ContainerConfig = {
  image: "docker.io/library/alpine",
  tag: "3.19",
  command: WAIT_UNTIL_TERM,
  resources: { memory: "64m" },
};

interface Booted {
  api: ContainerManagerApi;
  debug: string[];
  errors: string[];
  stop: () => Promise<void>;
}

/** Boot the plugin with an `app.debug` and `app.error` that record. */
async function bootPlugin(dataDir: string): Promise<Booted> {
  const debug: string[] = [];
  const errors: string[] = [];
  const noop = () => {};
  const plugin = containerManagerPlugin({
    debug: (...args: unknown[]) => {
      debug.push(String(args[0]));
    },
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
    debug,
    errors,
    stop: async () => {
      if (plugin.stop) await plugin.stop();
    },
  };
}

function liveUpdates(b: Booted): string[] {
  return [...b.debug, ...b.errors].filter(
    (m) =>
      m.startsWith(`ensureRunning(${CONTAINER})`) &&
      /live-updated resources|live resource update failed/.test(m),
  );
}

describe("a runtime-injected oomScoreAdj", () => {
  let dataDir: string | undefined;
  let booted: Booted | undefined;
  let memoryDelegated = true;

  before(async () => {
    const runtime = await hasContainerRuntime();
    if (!runtime) return;
    memoryDelegated =
      !runtime.cgroupControllers ||
      runtime.cgroupControllers.includes("memory");
    dataDir = mkdtempSync(join(tmpdir(), "skc-injected-oom-"));
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

  it("sends no live update to an unchanged container, warm or after a restart", async (t) => {
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
    const info = await getClient()
      .getContainer(prefixedName(CONTAINER))
      .inspect();
    const oom = (info.HostConfig as { OomScoreAdj?: number }).OomScoreAdj;
    t.diagnostic(`created with no oomScoreAdj requested: OomScoreAdj=${oom}`);

    // A second start in the same process: the warm-cache provenance path.
    await booted.api.ensureRunning(CONTAINER, CONFIG);
    assert.deepEqual(liveUpdates(booted), []);

    // A server restart: a fresh plugin reads provenance from the label.
    await booted.stop();
    booted = await bootPlugin(dataDir);
    await booted.api.ensureRunning(CONTAINER, CONFIG);
    assert.deepEqual(liveUpdates(booted), []);
    assert.deepEqual(booted.errors, []);
  });
});
