import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers.js";
import {
  _setDeviceProbeForTesting,
  _setEtcGroupReaderForTesting,
  type DeviceStatResult,
} from "../devices.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

// ensureRunning on a missing container builds a createContainer payload;
// these tests capture it via the mock client and assert the device/group
// fields: HostConfig.Devices for node entries, HostConfig.Binds +
// HostConfig.DeviceCgroupRules for hot-plug directory entries, and
// HostConfig.GroupAdd (plus the rootless-podman keep-original-groups
// annotation) for supplementary groups.

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

const podmanRootless: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
};

/** Linux dev_t: major in bits 8–19, minor split across bits 0–7 and 20+. */
function rdevOf(major: number, minor: number): number {
  return (minor & 0xff) + major * 0x100 + Math.floor(minor / 0x100) * 0x100000;
}

const hostStats: Record<string, DeviceStatResult> = {
  "/dev/snd": { kind: "directory", rdev: 0 },
  "/dev/snd/controlC0": { kind: "device-node", rdev: rdevOf(116, 0) },
  "/dev/ttyUSB0": { kind: "device-node", rdev: rdevOf(188, 0) },
};

const hostDirs: Record<string, string[]> = {
  "/dev/snd": ["controlC0"],
};

before(() => {
  _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 }));
  _setDeviceProbeForTesting({
    stat: (p) => hostStats[p] ?? null,
    readdir: (p) => hostDirs[p] ?? [],
  });
  _setEtcGroupReaderForTesting(() => "audio:x:29:pi\ndialout:x:20:pi\n");
});
after(() => {
  _setCurrentHostIdsForTesting(null);
  _setDeviceProbeForTesting(null);
  _setEtcGroupReaderForTesting(null);
});

const baseConfig: ContainerConfig = {
  image: "myorg/voice-satellite",
  tag: "1.0.0",
};

interface HostConfigShape {
  Devices?: Array<{
    PathOnHost: string;
    PathInContainer: string;
    CgroupPermissions: string;
  }>;
  DeviceCgroupRules?: string[];
  GroupAdd?: string[];
  Binds?: string[];
  Annotations?: Record<string, string>;
}

function makeClient(): {
  client: ReturnType<typeof makeMockClient>;
  calls: Map<string, unknown[]>;
} {
  const calls = new Map<string, unknown[]>();
  const client = makeMockClient({
    images: {
      "myorg/voice-satellite:1.0.0": { Id: "sha256:abc", Config: {} },
      "docker.io/myorg/voice-satellite:1.0.0": {
        Id: "sha256:abc",
        Config: {},
      },
    },
    calls,
  });
  return { client, calls };
}

function hostConfigFrom(calls: Map<string, unknown[]>): HostConfigShape {
  const created = calls.get("createContainer");
  if (!created || created.length === 0) {
    throw new Error("no `createContainer` call captured");
  }
  return (created[0] as { HostConfig?: HostConfigShape }).HostConfig ?? {};
}

describe("ensureRunning — devices in the create payload", () => {
  it("maps a node entry to HostConfig.Devices with expanded defaults", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "satellite",
      { ...baseConfig, devices: ["/dev/ttyUSB0"] },
      () => {},
      undefined,
      client,
    );
    const hc = hostConfigFrom(calls);
    assert.deepEqual(hc.Devices, [
      {
        PathOnHost: "/dev/ttyUSB0",
        PathInContainer: "/dev/ttyUSB0",
        CgroupPermissions: "rwm",
      },
    ]);
    assert.equal(hc.DeviceCgroupRules, undefined);
  });

  it("maps a directory entry to a plain bind plus class cgroup rules on docker", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "satellite",
      {
        ...baseConfig,
        volumes: { "/data": "/host/data" },
        devices: ["/dev/snd"],
      },
      () => {},
      undefined,
      client,
    );
    const hc = hostConfigFrom(calls);
    assert.equal(hc.Devices, undefined);
    assert.deepEqual(hc.DeviceCgroupRules, ["c 116:* rwm"]);
    assert.deepEqual(hc.Binds, ["/host/data:/data", "/dev/snd:/dev/snd"]);
  });

  it("omits cgroup rules on rootless podman and never adds :Z to the device bind", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      podmanRootless,
      "satellite",
      {
        ...baseConfig,
        volumes: { "/data": "/host/data" },
        devices: ["/dev/snd"],
      },
      () => {},
      undefined,
      client,
    );
    const hc = hostConfigFrom(calls);
    assert.equal(hc.DeviceCgroupRules, undefined);
    // The regular volume gets podman's :Z relabel flag; the device
    // directory must not (relabelling /dev/snd would hit the host's
    // own device nodes).
    assert.deepEqual(hc.Binds, ["/host/data:/data:Z", "/dev/snd:/dev/snd"]);
  });

  it("skips a missing device with a warning instead of blocking start", async () => {
    const { client, calls } = makeClient();
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "satellite",
      { ...baseConfig, devices: ["/dev/ttyACM9"] },
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    const hc = hostConfigFrom(calls);
    assert.equal(hc.Devices, undefined);
    assert.ok(
      debugLines.some((l) => l.includes("/dev/ttyACM9 does not exist")),
      `expected a skip warning, got: ${debugLines.join(" | ")}`,
    );
  });
});

describe("ensureRunning — groupAdd in the create payload", () => {
  it("resolves names to host GIDs and passes numerics through", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "satellite",
      { ...baseConfig, groupAdd: ["audio", 995] },
      () => {},
      undefined,
      client,
    );
    const hc = hostConfigFrom(calls);
    assert.deepEqual(hc.GroupAdd, ["29", "995"]);
    assert.equal(
      hc.Annotations,
      undefined,
      "docker must never receive the keep-original-groups annotation",
    );
  });

  it("adds the keep-original-groups annotation on rootless podman only", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      podmanRootless,
      "satellite",
      { ...baseConfig, groupAdd: ["audio"] },
      () => {},
      undefined,
      client,
    );
    const hc = hostConfigFrom(calls);
    assert.deepEqual(hc.GroupAdd, ["29"]);
    assert.deepEqual(hc.Annotations, {
      "run.oci.keep_original_groups": "1",
    });
  });

  it("leaves all device/group fields unset when the config doesn't use them", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "satellite",
      baseConfig,
      () => {},
      undefined,
      client,
    );
    const hc = hostConfigFrom(calls);
    assert.equal(hc.Devices, undefined);
    assert.equal(hc.DeviceCgroupRules, undefined);
    assert.equal(hc.GroupAdd, undefined);
    assert.equal(hc.Annotations, undefined);
  });
});
