import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../../index.js";
import { resetClient, resolveClient } from "../../client.js";
import { _setDetectRuntimeForTesting } from "../../runtime.js";
import type { ContainerManagerApi, PluginConfig } from "../../types.js";

/**
 * A malformed endpoint must stay terminal through the whole startup path, not
 * only at `resolveClient`. The risk is quiet: if either detection caller
 * turned `EndpointConfigError` into `null`, the doctor would report
 * `no-runtime` — a retryable status — and the plugin would poll a typo every
 * minute forever while telling the operator nothing useful.
 *
 * Booting the real plugin is the only way to assert that, since the decision
 * is split across `detectRuntime`, the doctor, and the startup branch.
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

const CONFIG = { disableUserNamespaceRemap: true } as PluginConfig;

/**
 * Count how many times detection is attempted.
 *
 * Counting probes is what makes the no-re-probe assertion mean anything: a
 * scheduled retry that throws lands in the retry's own catch, which calls
 * `app.error` and never `setPluginError`, so watching surfaced errors would
 * stay flat through exactly the regression being guarded against.
 *
 * The stub keeps the part of `detectRuntime` this scenario turns on — the
 * `resolveClient` call whose `EndpointConfigError` has to stay terminal.
 * Nothing follows it, because a malformed endpoint never resolves.
 */
function countingProbe(): { count: () => number; restore: () => void } {
  let calls = 0;
  _setDetectRuntimeForTesting(async (preference) => {
    calls += 1;
    await resolveClient(preference);
    return null;
  });
  return {
    count: () => calls,
    restore: () => _setDetectRuntimeForTesting(null),
  };
}

describe("malformed endpoint stays terminal through startup", () => {
  afterEach(restoreEndpointEnv);

  it("reports the failure and schedules no re-probe", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "skc-malformed-endpoint-"));
    const pluginErrors: string[] = [];
    const noop = () => {};
    const app = {
      debug: noop,
      error: noop,
      setPluginStatus: noop,
      setPluginError: (...args: unknown[]) => {
        pluginErrors.push(args.map(String).join(" "));
      },
      getDataDirPath: () => dataDir,
      config: { configPath: dataDir },
    };

    clearEndpointEnv();
    // A scheme we do not speak: no socket can ever appear at this address,
    // so waiting is the wrong answer.
    process.env.DOCKER_HOST = "tcp://192.0.2.10:2375";

    const probe = countingProbe();
    const plugin = containerManagerPlugin(app);
    try {
      plugin.start(CONFIG);
      const api = (
        globalThis as { __signalk_containerManager?: ContainerManagerApi }
      ).__signalk_containerManager;
      assert.ok(api, "plugin did not expose containerManager API");
      await api.whenReady();

      assert.equal(
        api.getRuntime(),
        null,
        "a malformed endpoint must not resolve a runtime",
      );
      const surfaced = pluginErrors.filter((m) => m.length > 0);
      assert.ok(
        surfaced.length > 0,
        "the operator must be told the endpoint is unusable",
      );
      assert.ok(
        surfaced.some((m) => /tcp:\/\/192\.0\.2\.10:2375|endpoint/i.test(m)),
        `error should name the endpoint problem; saw ${JSON.stringify(surfaced)}`,
      );

      // Count probes rather than surfaced errors. A scheduled re-probe that
      // throws lands in the retry's own catch, which calls app.error and
      // never setPluginError — so watching the plugin-error list would stay
      // flat through exactly the regression this is guarding against.
      const before = probe.count();
      // The retry ladder starts at 5s; wait past that.
      await new Promise((r) => setTimeout(r, 6_000));
      assert.equal(
        probe.count(),
        before,
        "a malformed endpoint must not be re-probed",
      );
    } finally {
      probe.restore();
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
