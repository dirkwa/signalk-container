import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../index.js";
import { _setClientForTesting } from "../client.js";
import { _setDetectRuntimeForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../types.js";

/**
 * A server shutdown stops every plugin at once, so a consumer's own stop()
 * can reach api.stop() after this plugin's stop() already ran. The consumer
 * must still stop its container: before, the call threw "No container
 * runtime available" and signalk-container-helper swallowed it at debug
 * level, leaving the container running for every consumer stopped after
 * signalk-container.
 */
const RUNTIME: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
};

const CONFIG = { disableUserNamespaceRemap: true } as PluginConfig;

/** Start the plugin against a mock client and return its API once ready. */
async function bootPlugin(): Promise<{
  plugin: ReturnType<typeof containerManagerPlugin>;
  api: ContainerManagerApi;
  stopped: () => string[];
  cleanup: () => void;
}> {
  const calls = new Map<string, unknown[]>();
  _setClientForTesting(makeMockClient({ calls }));
  _setDetectRuntimeForTesting(() => Promise.resolve(RUNTIME));
  const dataDir = mkdtempSync(join(tmpdir(), "skc-stop-after-stop-"));
  const noop = () => {};
  const plugin = containerManagerPlugin({
    debug: noop,
    error: noop,
    setPluginStatus: noop,
    setPluginError: noop,
    getDataDirPath: () => dataDir,
    config: { configPath: dataDir },
  });
  plugin.start(CONFIG);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  return {
    plugin,
    api,
    stopped: () =>
      (calls.get("stop") ?? []).map((c) => (c as { id: string }).id),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

describe("api.stop() after the plugin stopped", () => {
  const savedNamespace = process.env.SIGNALK_CONTAINER_NAMESPACE;

  afterEach(() => {
    _setDetectRuntimeForTesting(null);
    _setClientForTesting(null);
    if (savedNamespace === undefined) {
      delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    } else {
      process.env.SIGNALK_CONTAINER_NAMESPACE = savedNamespace;
    }
  });

  it("still stops a consumer's container", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const { plugin, api, stopped, cleanup } = await bootPlugin();
    try {
      if (plugin.stop) await plugin.stop();
      await api.stop("svc");
      assert.deepEqual(stopped(), ["sk-svc"]);
    } finally {
      cleanup();
    }
  });

  it("stops it under the namespace the plugin ran with", async () => {
    // Resetting to the default `sk` here would stop production's container
    // from a dev instance sharing the runtime.
    process.env.SIGNALK_CONTAINER_NAMESPACE = "devpod";
    const { plugin, api, stopped, cleanup } = await bootPlugin();
    try {
      if (plugin.stop) await plugin.stop();
      await api.stop("svc");
      assert.deepEqual(stopped(), ["devpod-svc"]);
    } finally {
      cleanup();
    }
  });
});
