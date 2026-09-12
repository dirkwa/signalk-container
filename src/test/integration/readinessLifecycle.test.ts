import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../../index.js";
import { _setDetectRuntimeForTesting } from "../../runtime.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

/**
 * `whenReady()` must settle for every start, including one torn down while its
 * runtime detection is still in flight. The generation guards resolve on each
 * path they take, but only once the awaited call returns — so the resolver
 * lives in plugin-scope state and `stop()` settles it directly.
 *
 * A consumer plugin blocks on this promise before touching the container API,
 * so a regression here hangs that plugin's startup rather than failing it.
 * Every assertion races a timeout: a hung promise must fail the test, never
 * wedge the suite.
 *
 * Detection is stubbed rather than live. Holding a probe pending is the whole
 * point — against a real runtime it returns in milliseconds, and the race
 * these tests exist for would close before `stop()` ever ran.
 */
const SETTLE_TIMEOUT_MS = 5_000;

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

/** A probe the test completes by hand, so a start stays mid-detection. */
function pendingProbe(): {
  probe: () => Promise<ContainerRuntimeInfo | null>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    probe: async () => {
      await gate;
      // Null keeps the startup path off the post-detection work (prune
      // scheduler, doctor surfacing) — readiness is what is under test.
      return null;
    },
    release,
  };
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
  afterEach(() => {
    _setDetectRuntimeForTesting(null);
  });

  it("settles when stop() lands on a start still detecting", async () => {
    const { probe, release } = pendingProbe();
    _setDetectRuntimeForTesting(probe);
    const { plugin, api, cleanup } = bootPlugin();
    try {
      plugin.start(CONFIG);
      const ready = api().whenReady();
      // Detection is parked in the probe, so the resolver is unreachable from
      // the start path — stop() is the only thing that can settle it.
      if (plugin.stop) await plugin.stop();
      assert.equal(
        await settles(ready),
        true,
        "whenReady() must settle when the plugin is stopped mid-detection",
      );
    } finally {
      release();
      cleanup();
    }
  });

  it("settles the current start after a superseded one completes late", async () => {
    // The resolver-ownership sequence: start A parks, start B parks, A's probe
    // returns and its stale closure runs, then stop() has to settle B. Without
    // the ownership check A's late completion nulls B's resolver and B hangs.
    const a = pendingProbe();
    const b = pendingProbe();
    let call = 0;
    _setDetectRuntimeForTesting(() => {
      call += 1;
      return call === 1 ? a.probe() : b.probe();
    });
    const { plugin, api, cleanup } = bootPlugin();
    try {
      plugin.start(CONFIG);
      const first = api().whenReady();
      plugin.start(CONFIG);
      const second = api().whenReady();

      // Re-entering start() settles the promise it superseded.
      assert.equal(
        await settles(first),
        true,
        "a superseded start's promise must not be left pending",
      );

      // A completes now, after B took the slot; its generation guard makes it
      // return without touching state, but it still runs its own resolver.
      a.release();
      await new Promise((r) => setTimeout(r, 50));

      // B is still parked in its probe, so stop() must be what settles it.
      if (plugin.stop) await plugin.stop();
      assert.equal(
        await settles(second),
        true,
        "a stale start must not clear the current start's resolver",
      );
    } finally {
      a.release();
      b.release();
      cleanup();
    }
  });
});
