import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin, {
  _setHostDeviceProbeForTesting,
} from "../index.js";
import { _setClientForTesting } from "../client.js";
import { _setDetectRuntimeForTesting } from "../runtime.js";
import { DEVICES_UNRESOLVED_LABEL } from "../devices.js";
import {
  HTTP_NOT_FOUND,
  httpError,
  makeMockClient,
  type MockContainerBehaviour,
} from "./helpers/mockClient.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  HostDeviceProbeResult,
  PluginConfig,
} from "../types.js";

/**
 * A containerized manager records a serial device the host rejected in a
 * label and keeps it out of drift. These drive `ensureRunning` through the
 * public API and check that the container is recreated once the host has
 * the device, and only then.
 */
const RUNTIME: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.8.6",
  isPodmanDockerShim: false,
  isRootless: true,
  isContainerized: true,
};

const CONFIG = { disableUserNamespaceRemap: true } as PluginConfig;
const NAME = "svc";
const FULL_NAME = "sk-svc";
const IMAGE = "docker.io/library/alpine";
const TAG = "3.19";
const BY_ID = "/dev/serial/by-id/usb-stick-if00-port0";

interface FakeContainer {
  exists: boolean;
  labels: Record<string, string>;
}

function behaviourFor(c: FakeContainer): MockContainerBehaviour {
  return {
    inspect: () =>
      c.exists
        ? Promise.resolve({
            State: { Status: "running", Running: true, Pid: 4242 },
            Config: { Image: `${IMAGE}:${TAG}`, Env: [], Labels: c.labels },
            HostConfig: { NetworkMode: "bridge" },
            Mounts: [],
          })
        : Promise.reject(
            httpError(`no such container ${FULL_NAME}`, HTTP_NOT_FOUND),
          ),
    start: () => {
      c.exists = true;
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
    remove: () => {
      c.exists = false;
      return Promise.resolve();
    },
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
  const dataDir = mkdtempSync(join(tmpdir(), "skc-serial-appeared-"));
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

function recordedContainer(): FakeContainer {
  return {
    exists: true,
    labels: { [DEVICES_UNRESOLVED_LABEL]: JSON.stringify([BY_ID]) },
  };
}

function probeReporting(
  result: HostDeviceProbeResult | null,
  probed: string[],
): (path: string) => Promise<HostDeviceProbeResult | null> {
  return (path) => {
    probed.push(path);
    return Promise.resolve(result);
  };
}

describe("a recorded serial device that appears on the host", () => {
  const savedNamespace = process.env.SIGNALK_CONTAINER_NAMESPACE;

  afterEach(() => {
    _setHostDeviceProbeForTesting(null);
    _setDetectRuntimeForTesting(null);
    _setClientForTesting(null);
    if (savedNamespace === undefined) {
      delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    } else {
      process.env.SIGNALK_CONTAINER_NAMESPACE = savedNamespace;
    }
  });

  it("recreates the container once the host has the device", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const probed: string[] = [];
    _setHostDeviceProbeForTesting(
      probeReporting(
        { exists: true, nodes: ["ttyUSB0"], groups: ["dialout"] },
        probed,
      ),
    );
    const { api, calls, shutdown } = await bootPlugin(recordedContainer());
    try {
      await api.ensureRunning(NAME, {
        image: IMAGE,
        tag: TAG,
        devices: [BY_ID],
      });
      assert.ok(probed.includes(BY_ID));
      assert.ok(count(calls, "remove") >= 1, "old container removed");
      assert.ok(count(calls, "createContainer") >= 1, "replacement created");
      const created = calls.get("createContainer") ?? [];
      const replacement = created[created.length - 1] as {
        HostConfig?: { Devices?: Array<{ PathOnHost?: string }> };
      };
      assert.ok(
        replacement.HostConfig?.Devices?.some((d) => d.PathOnHost === BY_ID),
        "replacement requests the serial device",
      );
    } finally {
      await shutdown();
    }
  });

  const notFound: [string, HostDeviceProbeResult | null][] = [
    ["absent", { exists: false, nodes: [], groups: [] }],
    ["unknown", null],
  ];
  for (const [label, result] of notFound) {
    it(`does not recreate while the host probe reports ${label}`, async () => {
      delete process.env.SIGNALK_CONTAINER_NAMESPACE;
      const probed: string[] = [];
      _setHostDeviceProbeForTesting(probeReporting(result, probed));
      const { api, calls, shutdown } = await bootPlugin(recordedContainer());
      try {
        await api.ensureRunning(NAME, {
          image: IMAGE,
          tag: TAG,
          devices: [BY_ID],
        });
        assert.deepEqual(probed, [BY_ID]);
        assert.equal(count(calls, "remove"), 0);
      } finally {
        await shutdown();
      }
    });
  }

  it("rejects a malformed digest before probing or removing", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const probed: string[] = [];
    _setHostDeviceProbeForTesting(
      probeReporting(
        { exists: true, nodes: ["ttyUSB0"], groups: ["dialout"] },
        probed,
      ),
    );
    const { api, calls, shutdown } = await bootPlugin(recordedContainer());
    try {
      await assert.rejects(
        api.ensureRunning(NAME, {
          image: IMAGE,
          tag: TAG,
          digest: "sha256:nothex",
          devices: [BY_ID],
        }),
        /Invalid digest/,
      );
      assert.deepEqual(probed, []);
      assert.equal(count(calls, "remove"), 0);
    } finally {
      await shutdown();
    }
  });

  it("rejects a malformed device entry before removing", async () => {
    delete process.env.SIGNALK_CONTAINER_NAMESPACE;
    const probed: string[] = [];
    _setHostDeviceProbeForTesting(
      probeReporting(
        { exists: true, nodes: ["ttyUSB0"], groups: ["dialout"] },
        probed,
      ),
    );
    const { api, calls, shutdown } = await bootPlugin(recordedContainer());
    try {
      await assert.rejects(
        api.ensureRunning(NAME, {
          image: IMAGE,
          tag: TAG,
          devices: [`${BY_ID}:/dev/zigbee:xyz`],
        }),
        /Invalid device permissions/,
      );
      assert.deepEqual(probed, []);
      assert.equal(count(calls, "remove"), 0);
    } finally {
      await shutdown();
    }
  });
});
