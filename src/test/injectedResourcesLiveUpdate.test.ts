import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../index.js";
import { _setClientForTesting } from "../client.js";
import { requestedResourcesLabel } from "../namespace.js";
import { _setDetectRuntimeForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type {
  ContainerConfig,
  ContainerManagerApi,
  ContainerResourceLimits,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../types.js";

/**
 * Rootless podman gives every container it starts the oom_score_adj of
 * the service that starts it. These drive ensureRunning and
 * updateResources through the public API against a running container
 * that matches its request apart from that inherited value, and check
 * that neither sends the runtime a live update for it.
 */
const RUNTIME: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.8.6",
  isPodmanDockerShim: false,
  isRootless: true,
};

const NAME = "svc";
const FULL_NAME = "sk-svc";
const IMAGE = "docker.io/library/alpine";
const TAG = "3.19";
const MIB = 1024 * 1024;
const CONFIG: ContainerConfig = {
  image: IMAGE,
  tag: TAG,
  resources: { memory: "64m" },
};

interface Live {
  /** HostConfig.Memory, in bytes. */
  memory: number;
  /** The requested-resources label the container was created with. */
  createdWith: ContainerResourceLimits;
}

async function bootPlugin(live: Live): Promise<{
  api: ContainerManagerApi;
  calls: Map<string, unknown[]>;
  errors: string[];
  shutdown: () => Promise<void>;
}> {
  const calls = new Map<string, unknown[]>();
  _setClientForTesting(
    makeMockClient({
      containers: {
        [FULL_NAME]: {
          inspect: () =>
            Promise.resolve({
              State: { Status: "running", Running: true, Pid: 4242 },
              Config: {
                Image: `${IMAGE}:${TAG}`,
                Env: [],
                Labels: {
                  [requestedResourcesLabel()]: JSON.stringify(live.createdWith),
                },
              },
              // As podman 5.8.6 inspects a container created with memory
              // 64m under a podman.service with OOMScoreAdjust=200.
              HostConfig: {
                NetworkMode: "bridge",
                Memory: live.memory,
                MemorySwap: 128 * MIB,
                OomScoreAdj: 200,
              },
              Mounts: [],
            }),
        },
      },
      images: { [`${IMAGE}:${TAG}`]: { Id: "sha256:abc", Config: {} } },
      calls,
    }),
  );
  _setDetectRuntimeForTesting(() => Promise.resolve(RUNTIME));
  const dataDir = mkdtempSync(join(tmpdir(), "skc-injected-resources-"));
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
  plugin.start({ disableUserNamespaceRemap: true } as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  return {
    api,
    calls,
    errors,
    shutdown: async () => {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function count(calls: Map<string, unknown[]>, op: string): number {
  return (calls.get(op) ?? []).length;
}

describe("a runtime-injected oomScoreAdj", () => {
  const savedNamespace = process.env.SIGNALK_CONTAINER_NAMESPACE;
  const savedContainer = process.env.container;

  // `isContainerized()` reads `process.env.container`, and firejail sets
  // `container=firejail` (the plugin registry runs the suite under it). The
  // start-up deployment doctor would then report an unresolved self ID through
  // app.error, which the no-warning assertion below would count against
  // ensureRunning.
  beforeEach(() => {
    delete process.env.container;
  });

  afterEach(() => {
    _setDetectRuntimeForTesting(null);
    _setClientForTesting(null);
    if (savedNamespace === undefined) {
      delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    } else {
      process.env.SIGNALK_CONTAINER_NAMESPACE = savedNamespace;
    }
    if (savedContainer === undefined) {
      delete process.env.container;
    } else {
      process.env.container = savedContainer;
    }
  });

  it("sends no live update from ensureRunning, cold or warm", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const { api, calls, errors, shutdown } = await bootPlugin({
      memory: 64 * MIB,
      createdWith: { memory: "64m" },
    });
    try {
      // The first call reads provenance from the label, the second from
      // the request the first one cached.
      await api.ensureRunning(NAME, CONFIG);
      await api.ensureRunning(NAME, CONFIG);
      assert.equal(count(calls, "createContainer"), 0, "no recreate");
      assert.equal(count(calls, "update"), 0);
      assert.deepEqual(errors, []);
    } finally {
      await shutdown();
    }
  });

  it("still lets ensureRunning live-update a limit that drifted", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const { api, calls, shutdown } = await bootPlugin({
      memory: 96 * MIB,
      createdWith: { memory: "64m" },
    });
    try {
      await api.ensureRunning(NAME, CONFIG);
      assert.equal(count(calls, "update"), 1);
    } finally {
      await shutdown();
    }
  });

  it("still warns when a requested oomScoreAdj is removed", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const { api, errors, shutdown } = await bootPlugin({
      memory: 64 * MIB,
      createdWith: { memory: "64m", oomScoreAdj: 200 },
    });
    try {
      await api.ensureRunning(NAME, CONFIG);
      assert.ok(
        errors.some((m) => /cannot live-unset fields oomScoreAdj/.test(m)),
        errors.join("\n"),
      );
    } finally {
      await shutdown();
    }
  });

  it("leaves updateResources with unchanged limits a no-op", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const { api, calls, shutdown } = await bootPlugin({
      memory: 64 * MIB,
      createdWith: { memory: "64m" },
    });
    try {
      await api.ensureRunning(NAME, CONFIG);
      const result = await api.updateResources(NAME, { memory: "64m" });
      assert.equal(result.method, "live");
      assert.equal(count(calls, "update"), 0);
    } finally {
      await shutdown();
    }
  });
});
