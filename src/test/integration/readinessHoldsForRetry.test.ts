import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../../index.js";
import { resetClient } from "../../client.js";
import type { ContainerManagerApi, PluginConfig } from "../../types.js";

/**
 * `whenReady()` must stay pending while a re-probe is outstanding.
 *
 * Consumer plugins read `getRuntime()` exactly once, right after awaiting
 * this promise — `waitForContainerManager` in signalk-container-helper is the
 * common path, and questdb and grafana both reach the runtime through it.
 * Settling early with no runtime therefore does not merely fail to help
 * them, it makes them publish "no container runtime detected" and stop for
 * good, even when a probe a few seconds later would have succeeded. Their own
 * timeout bounds the wait; this one must not cut it short.
 *
 * Terminal failures are the other half of the contract: nothing further will
 * change them, so holding waiters would hang a consumer that could have
 * surfaced a useful error.
 */
const ENV_VARS = ["DOCKER_HOST", "CONTAINER_HOST"] as const;
const SAVED = new Map<string, string | undefined>();

function clearEndpointEnv(): void {
  for (const key of ENV_VARS) {
    if (!SAVED.has(key)) SAVED.set(key, process.env[key]);
    delete process.env[key];
  }
  resetClient();
}

function restoreEndpointEnv(): void {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  SAVED.clear();
  resetClient();
}

/** Resolves true if `p` settles within `ms`, false if it is still pending. */
async function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bootPlugin(): {
  plugin: ReturnType<typeof containerManagerPlugin>;
  api: () => ContainerManagerApi;
  cleanup: () => void;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-readiness-hold-"));
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
  return {
    plugin,
    api: () => {
      const found = (
        globalThis as { __signalk_containerManager?: ContainerManagerApi }
      ).__signalk_containerManager;
      if (!found) throw new Error("plugin did not expose containerManager API");
      return found;
    },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

const CONFIG = { disableUserNamespaceRemap: true } as PluginConfig;

describe("whenReady holds while a re-probe is outstanding", () => {
  afterEach(restoreEndpointEnv);

  it("stays pending when the endpoint is absent but retryable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skc-absent-endpoint-"));
    clearEndpointEnv();
    // Absent, not malformed: detection reports no-runtime, which is
    // retryable, so a consumer must be held rather than told there is
    // nothing here.
    process.env.CONTAINER_HOST = join(dir, "not-yet.sock");

    const { plugin, api, cleanup } = bootPlugin();
    try {
      plugin.start(CONFIG);
      const ready = api().whenReady();
      // Comfortably past the first retry interval (5s): if readiness were
      // going to settle empty, it would have by now.
      assert.equal(
        await settlesWithin(ready, 7_000),
        false,
        "whenReady() must not settle while a re-probe is still scheduled",
      );
      assert.equal(api().getRuntime(), null);
    } finally {
      if (plugin.stop) await plugin.stop();
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settles promptly when the failure is terminal", async () => {
    clearEndpointEnv();
    // A scheme we do not speak: no probe will ever change this verdict, so
    // holding a consumer would strand it instead of letting it report.
    process.env.DOCKER_HOST = "tcp://192.0.2.10:2375";

    const { plugin, api, cleanup } = bootPlugin();
    try {
      plugin.start(CONFIG);
      assert.equal(
        await settlesWithin(api().whenReady(), 5_000),
        true,
        "a terminal failure must release waiters rather than hang them",
      );
      assert.equal(api().getRuntime(), null);
    } finally {
      if (plugin.stop) await plugin.stop();
      cleanup();
    }
  });
});
