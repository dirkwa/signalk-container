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
import { INTERNET_STATE_PATH, isInternetRestricted } from "../internetState.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../types.js";

describe("isInternetRestricted", () => {
  const node = (value: unknown) => (path: string) =>
    path === INTERNET_STATE_PATH ? { value, timestamp: "t" } : undefined;

  it("holds back on a metered, offline or captive uplink", () => {
    for (const state of ["metered", "offline", "captive"]) {
      assert.equal(isInternetRestricted(node(state)), true, state);
    }
  });

  it("lets traffic through when online or when nothing reports a state", () => {
    assert.equal(isInternetRestricted(node("online")), false);
    assert.equal(isInternetRestricted(node(null)), false);
    assert.equal(
      isInternetRestricted(() => undefined),
      false,
    );
    assert.equal(isInternetRestricted(undefined), false);
  });

  it("accepts a bare value", () => {
    assert.equal(
      isInternetRestricted(() => "metered"),
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

  async function pullsOnStart(internetState: string): Promise<number> {
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
});
