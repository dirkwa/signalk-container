import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../index.js";
import { _setClientForTesting } from "../client.js";
import { _setDetectRuntimeForTesting } from "../runtime.js";
import {
  HTTP_NOT_FOUND,
  httpError,
  makeMockClient,
  type MockContainerBehaviour,
} from "./helpers/mockClient.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../types.js";

/**
 * `recreate()` and the resource-update fallback replace a running container
 * after a graceful stop. These drive both through the public API against a
 * one-container mock runtime and check what they do when the old container
 * does not go away: neither may kill it, create a replacement, or report a
 * replacement that did not happen.
 */
const RUNTIME: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.8.6",
  isPodmanDockerShim: false,
  isRootless: true,
};

const CONFIG = { disableUserNamespaceRemap: true } as PluginConfig;
const NAME = "svc";
const FULL_NAME = "sk-svc";
const IMAGE = "docker.io/library/alpine";
const TAG = "3.19";
const EPERM = "sending SIGTERM to container: operation not permitted";

interface FakeContainer {
  exists: boolean;
  running: boolean;
  refuseStop: boolean;
  refuseRemove: boolean;
  refuseStart: boolean;
}

/** Behaviour of one container whose state the test steers through `c`. */
function behaviourFor(c: FakeContainer): MockContainerBehaviour {
  return {
    inspect: () =>
      c.exists
        ? Promise.resolve({
            State: {
              Status: c.running ? "running" : "exited",
              Running: c.running,
              Pid: c.running ? 4242 : 0,
            },
            Config: { Image: `${IMAGE}:${TAG}`, Env: [], Labels: {} },
            HostConfig: { NetworkMode: "bridge" },
            Mounts: [],
          })
        : Promise.reject(
            httpError(`no such container ${FULL_NAME}`, HTTP_NOT_FOUND),
          ),
    start: () => {
      if (c.refuseStart) return Promise.reject(new Error("start refused"));
      c.exists = true;
      c.running = true;
      return Promise.resolve();
    },
    stop: () => {
      if (c.refuseStop) return Promise.reject(new Error(EPERM));
      c.running = false;
      return Promise.resolve();
    },
    remove: () => {
      if (c.refuseRemove) {
        return Promise.reject(new Error("removing container: device busy"));
      }
      c.exists = false;
      c.running = false;
      return Promise.resolve();
    },
    // The live resource update fails, so updateResources takes its
    // recreate fallback.
    update: () => Promise.reject(new Error("update refused")),
  };
}

async function bootPlugin(c: FakeContainer): Promise<{
  api: ContainerManagerApi;
  calls: Map<string, unknown[]>;
  shutdown: () => Promise<void>;
}> {
  const calls = new Map<string, unknown[]>();
  _setClientForTesting(
    makeMockClient({
      containers: { [FULL_NAME]: behaviourFor(c) },
      images: { [`${IMAGE}:${TAG}`]: { Id: "sha256:abc", Config: {} } },
      calls,
    }),
  );
  _setDetectRuntimeForTesting(() => Promise.resolve(RUNTIME));
  const dataDir = mkdtempSync(join(tmpdir(), "skc-recreate-refused-"));
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
    api,
    calls,
    shutdown: async () => {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function count(calls: Map<string, unknown[]>, op: string): number {
  return (calls.get(op) ?? []).length;
}

describe("replacing a container that does not go away", () => {
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

  it("recreate() rejects and keeps the container when the stop is refused", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const c: FakeContainer = {
      exists: true,
      running: true,
      refuseStop: true,
      refuseRemove: false,
      refuseStart: false,
    };
    const { api, calls, shutdown } = await bootPlugin(c);
    try {
      await assert.rejects(
        api.recreate(NAME, { image: IMAGE, tag: TAG }),
        /operation not permitted/,
      );
      assert.equal(count(calls, "remove"), 0, "must not force-remove");
      assert.equal(count(calls, "createContainer"), 0);
      assert.equal(c.running, true);
    } finally {
      await shutdown();
    }
  });

  it("updateResources starts the old container again when only the remove failed", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const c: FakeContainer = {
      exists: false,
      running: false,
      refuseStop: false,
      refuseRemove: false,
      refuseStart: false,
    };
    const { api, calls, shutdown } = await bootPlugin(c);
    try {
      await api.ensureRunning(NAME, { image: IMAGE, tag: TAG });
      assert.equal(count(calls, "createContainer"), 1);
      c.refuseRemove = true;

      await assert.rejects(
        api.updateResources(NAME, { memory: "64m" }),
        /keeps its previous limits/,
      );
      assert.equal(count(calls, "stop"), 1, "the graceful stop went through");
      assert.equal(c.running, true, "the old container is running again");
      assert.equal(count(calls, "createContainer"), 1, "no replacement");
    } finally {
      await shutdown();
    }
  });

  it("updateResources reports both failures when the restart fails too", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const c: FakeContainer = {
      exists: false,
      running: false,
      refuseStop: false,
      refuseRemove: false,
      refuseStart: false,
    };
    const { api, shutdown } = await bootPlugin(c);
    try {
      await api.ensureRunning(NAME, { image: IMAGE, tag: TAG });
      c.refuseRemove = true;
      c.refuseStart = true;

      await assert.rejects(
        api.updateResources(NAME, { memory: "64m" }),
        (err: unknown) =>
          err instanceof Error &&
          /device busy/.test(err.message) &&
          /keeps its previous limits/.test(err.message) &&
          /Starting it again also failed: .*start refused/.test(err.message),
      );
    } finally {
      await shutdown();
    }
  });
});
