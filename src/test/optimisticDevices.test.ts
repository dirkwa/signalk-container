import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  diffContainerConfig,
  ensureRunning,
  getLiveContainerConfig,
} from "../containers.js";
import {
  DEVICES_UNRESOLVED_LABEL,
  filterUnresolvedDeviceEntries,
  parseUnresolvedDevicesLabel,
  resolveDeviceRequests,
  _setDeviceProbeForTesting,
  _setEtcGroupReaderForTesting,
  type DeviceStatResult,
} from "../devices.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type {
  ContainerConfig,
  ContainerRuntimeInfo,
  DeviceIssue,
} from "../types.js";

// The manager runs inside the Signal K container, so its filesystem is not
// the filesystem the runtime resolves bind sources against. These tests
// cover the optimistic-emission path for well-known device directories the
// manager cannot see locally, the create-failure fallback when the REAL
// host lacks the path too, and the DEVICES_UNRESOLVED_LABEL stickiness
// that keeps the reconcile loop from recreating forever afterwards.

const podmanRootlessInContainer: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
  isContainerized: true,
};

const dockerInContainer: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isContainerized: true,
};

const podmanRootlessBareMetal: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
};

/** Mutable per-test view of the manager's local filesystem. */
let hostStats: Record<string, DeviceStatResult> = {};

before(() => {
  _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 }));
  _setDeviceProbeForTesting({
    stat: (p) => hostStats[p] ?? null,
    readdir: () => [],
  });
  _setEtcGroupReaderForTesting(() => "audio:x:29:pi\n");
});
after(() => {
  _setCurrentHostIdsForTesting(null);
  _setDeviceProbeForTesting(null);
  _setEtcGroupReaderForTesting(null);
});

describe("resolveDeviceRequests — optimistic emission when containerized", () => {
  it("emits an unverified bind for a well-known directory it cannot see", () => {
    hostStats = {};
    const resolved = resolveDeviceRequests(
      ["/dev/snd"],
      podmanRootlessInContainer,
    );
    assert.deepEqual(resolved.directoryBinds, [
      { pathOnHost: "/dev/snd", pathInContainer: "/dev/snd", unverified: true },
    ]);
    assert.deepEqual(resolved.cgroupRules, []);
    assert.equal(resolved.issues.length, 1);
    assert.equal(resolved.issues[0].disposition, "optimistic");
    assert.equal(resolved.issues[0].hostPath, "/dev/snd");
  });

  it("emits the well-known class cgroup rule on a rootful runtime", () => {
    hostStats = {};
    const resolved = resolveDeviceRequests(["/dev/snd"], dockerInContainer);
    assert.deepEqual(resolved.cgroupRules, ["c 116:* rwm"]);
  });

  it("still skips a missing path on a bare-metal manager", () => {
    hostStats = {};
    const resolved = resolveDeviceRequests(
      ["/dev/snd"],
      podmanRootlessBareMetal,
    );
    assert.deepEqual(resolved.directoryBinds, []);
    assert.equal(resolved.issues[0].disposition, "skipped");
  });

  it("still skips a non-well-known path even when containerized", () => {
    hostStats = {};
    const resolved = resolveDeviceRequests(
      ["/dev/ttyUSB0"],
      podmanRootlessInContainer,
    );
    assert.deepEqual(resolved.nodes, []);
    assert.deepEqual(resolved.directoryBinds, []);
    assert.equal(resolved.issues[0].disposition, "skipped");
  });
});

describe("DEVICES_UNRESOLVED_LABEL helpers", () => {
  it("round-trips a JSON path list and tolerates garbage", () => {
    assert.deepEqual(parseUnresolvedDevicesLabel('["/dev/snd"]'), ["/dev/snd"]);
    assert.deepEqual(parseUnresolvedDevicesLabel(undefined), []);
    assert.deepEqual(parseUnresolvedDevicesLabel("not json"), []);
    assert.deepEqual(parseUnresolvedDevicesLabel('{"a":1}'), []);
    assert.deepEqual(parseUnresolvedDevicesLabel('["/dev/snd", 5]'), [
      "/dev/snd",
    ]);
  });

  it("filters only entries that are labeled AND still invisible", () => {
    hostStats = { "/dev/input": { kind: "directory", rdev: 0 } };
    const entries = ["/dev/snd", "/dev/input", "/dev/dri"];
    assert.deepEqual(
      filterUnresolvedDeviceEntries(entries, ["/dev/snd", "/dev/input"]),
      // /dev/snd: labeled + invisible → dropped. /dev/input: labeled but
      // now visible → kept (drift applies it for real). /dev/dri: not
      // labeled → kept.
      ["/dev/input", "/dev/dri"],
    );
  });
});

describe("ensureRunning — optimistic-device create fallback", () => {
  const config: ContainerConfig = {
    image: "myorg/voice-satellite",
    tag: "1.0.0",
    devices: ["/dev/snd"],
    groupAdd: ["audio"],
  };

  function makeClient(startBehaviours: Array<() => Promise<unknown>>) {
    const calls = new Map<string, unknown[]>();
    let startCall = 0;
    const client = makeMockClient({
      images: {
        "myorg/voice-satellite:1.0.0": { Id: "sha256:abc", Config: {} },
        "docker.io/myorg/voice-satellite:1.0.0": {
          Id: "sha256:abc",
          Config: {},
        },
      },
      containers: {
        "sk-satellite": {
          start: () => {
            const behaviour = startBehaviours[startCall];
            startCall += 1;
            return behaviour ? behaviour() : Promise.resolve();
          },
        },
      },
      calls,
    });
    return { client, calls };
  }

  function createdHostConfigs(calls: Map<string, unknown[]>): Array<{
    Binds?: string[];
    Labels?: Record<string, string>;
  }> {
    return (calls.get("createContainer") ?? []).map((opts) => {
      const o = opts as {
        HostConfig?: { Binds?: string[] };
        Labels?: Record<string, string>;
      };
      return { Binds: o.HostConfig?.Binds, Labels: o.Labels };
    });
  }

  it("recreates without the bind and stamps the label when the host rejects it", async () => {
    hostStats = {};
    const { client, calls } = makeClient([
      () =>
        Promise.reject(new Error("statfs /dev/snd: no such file or directory")),
      () => Promise.resolve(),
    ]);
    const events: DeviceIssue[] = [];
    await ensureRunning(
      podmanRootlessInContainer,
      "satellite",
      config,
      () => {},
      { onDeviceIssue: (e) => void events.push(e) },
      client,
    );
    const created = createdHostConfigs(calls);
    assert.equal(created.length, 2);
    assert.ok(created[0].Binds?.includes("/dev/snd:/dev/snd"));
    assert.equal(created[0].Labels?.[DEVICES_UNRESOLVED_LABEL], undefined);
    assert.ok(!(created[1].Binds ?? []).includes("/dev/snd:/dev/snd"));
    assert.equal(created[1].Labels?.[DEVICES_UNRESOLVED_LABEL], '["/dev/snd"]');
    // The half-created container was removed before the retry.
    assert.ok((calls.get("remove") ?? []).length >= 1);
    assert.deepEqual(
      events.map((e) => e.action),
      ["optimistic", "unresolved"],
    );
    assert.equal(events[1].hostPath, "/dev/snd");
  });

  it("does not fall back on an unrelated start failure", async () => {
    hostStats = {};
    const { client, calls } = makeClient([
      () => Promise.reject(new Error("boom")),
    ]);
    await assert.rejects(
      ensureRunning(
        podmanRootlessInContainer,
        "satellite",
        config,
        () => {},
        undefined,
        client,
      ),
      /Failed to create sk-satellite/,
    );
    assert.equal((calls.get("createContainer") ?? []).length, 1);
  });
});

describe("diffContainerConfig — unresolved-label stickiness", () => {
  const requested: ContainerConfig = {
    image: "myorg/voice-satellite",
    tag: "1.0.0",
    devices: ["/dev/snd"],
  };

  function liveOf(labels: Record<string, string>) {
    return {
      image: "myorg/voice-satellite",
      tag: "1.0.0",
      digest: null,
      command: null,
      networkMode: "",
      env: new Map<string, string>(),
      binds: [],
      portBindings: new Map(),
      extraHosts: new Map(),
      user: "",
      devices: [],
      deviceCgroupRules: [],
      groupAdd: [],
      labels,
    };
  }

  it("suppresses drift for a labeled entry the manager still cannot see", () => {
    hostStats = {};
    const { drifted } = diffContainerConfig(
      requested,
      liveOf({ [DEVICES_UNRESOLVED_LABEL]: '["/dev/snd"]' }),
      podmanRootlessInContainer,
    );
    assert.deepEqual(drifted, []);
  });

  it("flags drift when the container carries no label", () => {
    hostStats = {};
    const { drifted } = diffContainerConfig(
      requested,
      liveOf({}),
      podmanRootlessInContainer,
    );
    assert.ok(drifted.includes("volumes"));
  });

  it("resumes drift once the manager can see the labeled path", () => {
    hostStats = { "/dev/snd": { kind: "directory", rdev: 0 } };
    const { drifted } = diffContainerConfig(
      requested,
      liveOf({ [DEVICES_UNRESOLVED_LABEL]: '["/dev/snd"]' }),
      podmanRootlessInContainer,
    );
    assert.ok(drifted.includes("volumes"));
  });
});

describe("getLiveContainerConfig — labels", () => {
  it("surfaces Config.Labels and defaults to {}", async () => {
    const client = makeMockClient({
      containers: {
        "sk-satellite": {
          inspect: {
            Config: {
              Image: "myorg/voice-satellite:1.0.0",
              Labels: { [DEVICES_UNRESOLVED_LABEL]: '["/dev/snd"]', x: "y" },
            },
            HostConfig: {},
          },
        },
        "sk-bare": {
          inspect: {
            Config: { Image: "myorg/voice-satellite:1.0.0" },
            HostConfig: {},
          },
        },
      },
    });
    const live = await getLiveContainerConfig(
      podmanRootlessInContainer,
      "satellite",
      client,
    );
    assert.equal(live?.labels[DEVICES_UNRESOLVED_LABEL], '["/dev/snd"]');
    const bare = await getLiveContainerConfig(
      podmanRootlessInContainer,
      "bare",
      client,
    );
    assert.deepEqual(bare?.labels, {});
  });
});
