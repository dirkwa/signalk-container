import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../index.js";
import { _setClientForTesting } from "../client.js";
import {
  _setCurrentHostIdsForTesting,
  _setDetectRuntimeForTesting,
} from "../runtime.js";
import {
  INTERNET_PLUGIN_ID,
  INTERNET_STATE_PATH,
  isInternetRestricted,
  type InternetStateSource,
} from "../internetState.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../types.js";

describe("isInternetRestricted", () => {
  function source(
    value: unknown,
    plugin: { enabled: boolean } | null = { enabled: true },
  ): InternetStateSource {
    return {
      getSelfPath: (path) =>
        path === INTERNET_STATE_PATH ? { value, timestamp: "t" } : undefined,
      getPluginsList: async () => [
        { id: "signalk-container", enabled: true },
        ...(plugin ? [{ id: INTERNET_PLUGIN_ID, ...plugin }] : []),
      ],
    };
  }

  it("holds back on a metered, offline or captive uplink", async () => {
    for (const state of ["metered", "offline", "captive"]) {
      assert.equal(await isInternetRestricted(source(state)), true, state);
    }
  });

  it("lets traffic through when the uplink is online", async () => {
    assert.equal(await isInternetRestricted(source("online")), false);
  });

  it("ignores a value left behind by a disabled or removed plugin", async () => {
    assert.equal(
      await isInternetRestricted(source("metered", { enabled: false })),
      false,
    );
    assert.equal(await isInternetRestricted(source("metered", null)), false);
  });

  it("holds back while the enabled plugin has not published yet", async () => {
    assert.equal(await isInternetRestricted(source(undefined)), true);
  });

  it("changes nothing on a server that cannot tell which plugins run", async () => {
    assert.equal(
      await isInternetRestricted({ getSelfPath: () => "metered" }),
      false,
    );
    assert.equal(
      await isInternetRestricted({
        getSelfPath: () => "metered",
        getPluginsList: () => Promise.reject(new Error("boom")),
      }),
      false,
    );
  });

  it("accepts a bare value", async () => {
    assert.equal(
      await isInternetRestricted({
        getSelfPath: () => "metered",
        getPluginsList: async () => [{ id: INTERNET_PLUGIN_ID, enabled: true }],
      }),
      true,
    );
  });
});

const RUNTIME: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "29.0.0",
  isPodmanDockerShim: false,
};
const IMAGE = "example/app";
const TAG = "latest";

describe("floating-tag auto-update on a restricted uplink", () => {
  const savedContainer = process.env.container;

  before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
  after(() => _setCurrentHostIdsForTesting(null));

  afterEach(() => {
    _setDetectRuntimeForTesting(null);
    _setClientForTesting(null);
    if (savedContainer === undefined) {
      delete process.env.container;
    } else {
      process.env.container = savedContainer;
    }
  });

  async function pullsOnStart(
    internetState: string,
    internetPluginEnabled = true,
  ): Promise<number> {
    delete process.env.container;
    const calls = new Map<string, unknown[]>();
    _setClientForTesting(
      makeMockClient({
        containers: {
          "sk-app": {
            inspect: () =>
              Promise.resolve({
                Image: "sha256:live",
                State: { Status: "running", Running: true, Pid: 42 },
                // Matches the request, so the floating-tag probe is the only
                // thing ensureRunning has left to do.
                Config: {
                  Image: `${IMAGE}:${TAG}`,
                  Env: [],
                  Labels: {},
                  User: "1000:1000",
                },
                HostConfig: {
                  NetworkMode: "default",
                  ExtraHosts: ["host.containers.internal:host-gateway"],
                },
                Mounts: [],
              }),
          },
        },
        images: { [`${IMAGE}:${TAG}`]: { Id: "sha256:live", Config: {} } },
        calls,
      }),
    );
    _setDetectRuntimeForTesting(() => Promise.resolve(RUNTIME));
    const dataDir = mkdtempSync(join(tmpdir(), "skc-internet-state-"));
    const noop = () => {};
    const plugin = containerManagerPlugin({
      debug: noop,
      error: noop,
      setPluginStatus: noop,
      setPluginError: noop,
      getDataDirPath: () => dataDir,
      config: { configPath: dataDir },
      getSelfPath: (path: string) =>
        path === INTERNET_STATE_PATH ? { value: internetState } : undefined,
      getPluginsList: async () => [
        { id: INTERNET_PLUGIN_ID, enabled: internetPluginEnabled },
      ],
    });
    plugin.start({ backgroundUpdateChecks: false } as PluginConfig);
    const api = (
      globalThis as { __signalk_containerManager?: ContainerManagerApi }
    ).__signalk_containerManager;
    try {
      if (!api) throw new Error("plugin did not expose containerManager API");
      await api.whenReady();
      await api.ensureRunning("app", {
        image: IMAGE,
        tag: TAG,
        autoUpdateOnFloatingTag: true,
      });
      return (calls.get("pull") ?? []).length;
    } finally {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  it("pulls the tag on start while online", async () => {
    assert.equal(await pullsOnStart("online"), 1);
  });

  it("does not pull while metered", async () => {
    assert.equal(await pullsOnStart("metered"), 0);
  });

  it("pulls as before when signalk-internet is disabled but its old value lingers", async () => {
    assert.equal(await pullsOnStart("metered", false), 1);
  });
});
