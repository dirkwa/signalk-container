import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../../index.js";
import type { ContainerManagerApi, PluginConfig } from "../../types.js";

/**
 * `whenReady()` must settle for every start, including one torn down while
 * its runtime detection is still in flight. The generation guards resolve on
 * each path they take, but only once the awaited call returns — so the
 * resolver lives in plugin-scope state and `stop()` settles it directly.
 *
 * A consumer plugin blocks on this promise before touching the container API,
 * so a regression here hangs that plugin's startup rather than failing it.
 * Every assertion races a timeout: a hung promise must fail the test, never
 * wedge the suite.
 */
const SETTLE_TIMEOUT_MS = 10_000;

/** Resolves true when `p` settles in time, false when it does not. */
async function settles(p: Promise<void>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SETTLE_TIMEOUT_MS);
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
  const dataDir = mkdtempSync(join(tmpdir(), "skc-readiness-test-"));
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

describe("whenReady lifecycle", () => {
  it("settles when stop() lands on a start still detecting", async () => {
    const { plugin, api, cleanup } = bootPlugin();
    try {
      plugin.start(CONFIG);
      // No await between start and stop: detection is still in flight, which
      // is the window where the resolver used to be unreachable.
      const ready = api().whenReady();
      if (plugin.stop) await plugin.stop();
      assert.equal(
        await settles(ready),
        true,
        "whenReady() must settle when the plugin is stopped mid-detection",
      );
    } finally {
      cleanup();
    }
  });

  it("settles the current promise when a start supersedes another", async () => {
    const { plugin, api, cleanup } = bootPlugin();
    try {
      plugin.start(CONFIG);
      const first = api().whenReady();
      // Re-entering start() retires the previous run and settles its promise.
      // Note this does NOT exercise the resolver-ownership guard: staging that
      // needs start A's detection to still be pending when B begins and to
      // return afterwards, which has no seam to hold open from a test.
      plugin.start(CONFIG);
      const second = api().whenReady();
      assert.equal(
        await settles(first),
        true,
        "a superseded start's promise must not be left pending",
      );
      if (plugin.stop) await plugin.stop();
      assert.equal(
        await settles(second),
        true,
        "the current start's promise must settle on stop()",
      );
    } finally {
      cleanup();
    }
  });
});
