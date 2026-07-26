import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  diffContainerConfig,
  type LiveContainerConfig,
} from "../containers.js";
import {
  _setDeviceProbeForTesting,
  _setEtcGroupReaderForTesting,
  type DeviceStatResult,
} from "../devices.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

/** Linux dev_t: major in bits 8–19, minor split across bits 0–7 and 20+. */
function rdevOf(major: number, minor: number): number {
  return (minor & 0xff) + major * 0x100 + Math.floor(minor / 0x100) * 0x100000;
}

// Deterministic host state for the devices/groupAdd transforms: the diff
// mirrors buildCreateOptions' emission, which stats device paths and
// resolves group names, so both probes are pinned like the host-id
// resolver below.
const hostStats: Record<string, DeviceStatResult> = {
  "/dev/snd": { kind: "directory", rdev: 0 },
  "/dev/snd/controlC0": { kind: "device-node", rdev: rdevOf(116, 0) },
  "/dev/ttyUSB0": { kind: "device-node", rdev: rdevOf(188, 0) },
  "/dev/ttyACM0": { kind: "device-node", rdev: rdevOf(166, 0) },
};

// Pin the host UID/GID resolver so user-mapping flags are deterministic
// across CI (often UID 0) and dev machines (often UID 1000).
// `liveBase().user` is set to the same `1000:1000` string so the
// existing no-drift tests stay no-drift; tests asserting `user` drift
// override `user` explicitly.
before(() => {
  _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 }));
  _setDeviceProbeForTesting({
    stat: (p) => hostStats[p] ?? null,
    readdir: (p) => (p === "/dev/snd" ? ["controlC0"] : []),
  });
  _setEtcGroupReaderForTesting(() => "audio:x:29:pi\ndialout:x:20:pi\n");
});
after(() => {
  _setCurrentHostIdsForTesting(null);
  _setDeviceProbeForTesting(null);
  _setEtcGroupReaderForTesting(null);
});

function liveBase(
  overrides: Partial<LiveContainerConfig> = {},
): LiveContainerConfig {
  return {
    image: "questdb/questdb",
    tag: "9.0.0",
    digest: null,
    command: null,
    networkMode: "bridge",
    env: new Map(),
    binds: [],
    portBindings: new Map(),
    extraHosts: new Map(),
    // Matches the pinned host-id resolver above; userMappingFlags
    // produces `--user 1000:1000` by default on docker/rootful podman,
    // so live state mirrors that to keep existing no-drift tests stable.
    user: "1000:1000",
    devices: [],
    deviceCgroupRules: [],
    groupAdd: [],
    labels: {},
    ...overrides,
  } as LiveContainerConfig;
}

function reqBase(overrides: Partial<ContainerConfig> = {}): ContainerConfig {
  return {
    image: "questdb/questdb",
    tag: "9.0.0",
    ...overrides,
  };
}

describe("diffContainerConfig — no drift on identical configs", () => {
  it("returns empty drifted list when image+tag match and everything else is unset", () => {
    // Docker runtime auto-injects `host.containers.internal:host-gateway`
    // into the requested extraHosts set; the live state mirrors that.
    const { drifted } = diffContainerConfig(
      reqBase(),
      liveBase({
        extraHosts: new Map([["host.containers.internal", "host-gateway"]]),
      }),
      docker,
    );
    assert.deepEqual(drifted, []);
  });

  it("treats podman 'docker.io/' qualified image as equivalent to bare image", () => {
    // qualifyImage prepends docker.io/ for podman; both sides should agree.
    const { drifted } = diffContainerConfig(
      reqBase({ image: "questdb/questdb", tag: "9.0.0" }),
      liveBase({ image: "docker.io/questdb/questdb", tag: "9.0.0" }),
      podman,
    );
    assert.deepEqual(drifted, []);
  });

  it("treats podman's library/ canonical form as equivalent to a bare single-name image", () => {
    // Podman reports `alpine` as `docker.io/library/alpine` in
    // Config.Image. Anything but a match here recreates the container
    // on every ensureRunning call.
    const { drifted } = diffContainerConfig(
      reqBase({ image: "alpine", tag: "3.19" }),
      liveBase({ image: "docker.io/library/alpine", tag: "3.19" }),
      podman,
    );
    assert.deepEqual(drifted, []);
  });
});

describe("diffContainerConfig — image+tag drift", () => {
  it("flags image change", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ image: "other/image" }),
      liveBase(),
      docker,
    );
    assert.ok(drifted.includes("image+tag"));
  });

  it("flags tag change", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ tag: "9.1.0" }),
      liveBase({ tag: "9.0.0" }),
      docker,
    );
    assert.ok(drifted.includes("image+tag"));
  });
});

describe("diffContainerConfig — command", () => {
  it("flags drift when explicit command differs", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ command: ["sleep", "60"] }),
      liveBase({ command: ["sleep", "30"] }),
      docker,
    );
    assert.ok(drifted.includes("command"));
  });

  it("does NOT flag drift when requested.command is undefined (image baked CMD ignored)", () => {
    const { drifted } = diffContainerConfig(
      reqBase(), // command undefined
      liveBase({ command: ["/app/bin/run.sh"] }), // image's CMD
      docker,
    );
    assert.ok(!drifted.includes("command"));
  });

  it("flags drift when requested has explicit empty array but live has values", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ command: [] }),
      liveBase({ command: ["sleep"] }),
      docker,
    );
    assert.ok(drifted.includes("command"));
  });
});

describe("diffContainerConfig — networkMode canonicalization", () => {
  it("treats requested undefined as equivalent to live 'bridge' (docker default)", () => {
    const { drifted } = diffContainerConfig(
      reqBase(), // networkMode undefined
      liveBase({ networkMode: "bridge" }),
      docker,
    );
    assert.ok(!drifted.includes("networkMode"));
  });

  it("treats requested undefined as equivalent to live 'slirp4netns' (podman rootless default)", () => {
    const { drifted } = diffContainerConfig(
      reqBase(),
      liveBase({ networkMode: "slirp4netns" }),
      podman,
    );
    assert.ok(!drifted.includes("networkMode"));
  });

  it("treats requested 'host' vs live 'bridge' as drift", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ networkMode: "host" }),
      liveBase({ networkMode: "bridge" }),
      docker,
    );
    assert.ok(drifted.includes("networkMode"));
  });

  it("treats requested 'host' vs live 'host' as no drift", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ networkMode: "host" }),
      liveBase({ networkMode: "host" }),
      docker,
    );
    assert.ok(!drifted.includes("networkMode"));
  });
});

describe("diffContainerConfig — env", () => {
  it("flags drift when a requested key has a different value live", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ env: { FOO: "1" } }),
      liveBase({ env: new Map([["FOO", "2"]]) }),
      docker,
    );
    assert.ok(drifted.includes("env"));
  });

  it("flags drift when a requested key is missing live", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ env: { FOO: "1" } }),
      liveBase({ env: new Map([["BAR", "x"]]) }),
      docker,
    );
    assert.ok(drifted.includes("env"));
  });

  it("does NOT flag drift when image-baked env keys are not in requested", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ env: { MY_FLAG: "on" } }),
      liveBase({
        env: new Map([
          ["MY_FLAG", "on"],
          ["PATH", "/usr/bin"], // image-baked
          ["JAVA_HOME", "/opt/java"], // image-baked
        ]),
      }),
      docker,
    );
    assert.ok(!drifted.includes("env"));
  });

  it("does NOT flag drift when both env are empty", () => {
    const { drifted } = diffContainerConfig(reqBase(), liveBase(), docker);
    assert.ok(!drifted.includes("env"));
  });

  it("env-key order does not matter (Map lookup is unordered)", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ env: { B: "2", A: "1" } }),
      liveBase({
        env: new Map([
          ["A", "1"],
          ["B", "2"],
        ]),
      }),
      docker,
    );
    assert.ok(!drifted.includes("env"));
  });
});

describe("diffContainerConfig — volumes", () => {
  it("flags drift when host path changes", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ volumes: { "/data": "/host/path-b" } }),
      liveBase({ binds: [{ host: "/host/path-a", container: "/data" }] }),
      docker,
    );
    assert.ok(drifted.includes("volumes"));
  });

  it("flags drift when a mount is added", () => {
    const { drifted } = diffContainerConfig(
      reqBase({
        volumes: { "/data": "/host/data", "/cfg": "/host/cfg" },
      }),
      liveBase({ binds: [{ host: "/host/data", container: "/data" }] }),
      docker,
    );
    assert.ok(drifted.includes("volumes"));
  });

  it("flags drift when a mount is removed", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ volumes: { "/data": "/host/data" } }),
      liveBase({
        binds: [
          { host: "/host/data", container: "/data" },
          { host: "/host/cfg", container: "/cfg" },
        ],
      }),
      docker,
    );
    assert.ok(drifted.includes("volumes"));
  });

  it("treats trailing slashes as equivalent (canonicalization)", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ volumes: { "/data/": "/host/path/" } }),
      liveBase({ binds: [{ host: "/host/path", container: "/data" }] }),
      docker,
    );
    assert.ok(!drifted.includes("volumes"));
  });

  it("does NOT flag drift when matching exactly", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ volumes: { "/data": "/host/path" } }),
      liveBase({ binds: [{ host: "/host/path", container: "/data" }] }),
      docker,
    );
    assert.ok(!drifted.includes("volumes"));
  });

  it("treats named volumes (no leading slash) the same as host paths", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ volumes: { "/data": "my-volume" } }),
      liveBase({ binds: [{ host: "my-volume", container: "/data" }] }),
      docker,
    );
    assert.ok(!drifted.includes("volumes"));
  });
});

describe("diffContainerConfig — ports", () => {
  it("flags drift when host port changes", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ ports: { "9000/tcp": "127.0.0.1:9001" } }),
      liveBase({
        portBindings: new Map([
          ["9000/tcp", [{ hostIp: "127.0.0.1", hostPort: 9000 }]],
        ]),
      }),
      docker,
    );
    assert.ok(drifted.includes("ports"));
  });

  it("treats requested key '9000' (no /tcp) as '9000/tcp'", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ ports: { "9000": "127.0.0.1:9000" } }),
      liveBase({
        portBindings: new Map([
          ["9000/tcp", [{ hostIp: "127.0.0.1", hostPort: 9000 }]],
        ]),
      }),
      docker,
    );
    assert.ok(!drifted.includes("ports"));
  });

  it("treats bare port string '9000' as hostIp='', hostPort=9000", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ ports: { "9000/tcp": "9000" } }),
      liveBase({
        portBindings: new Map([["9000/tcp", [{ hostIp: "", hostPort: 9000 }]]]),
      }),
      docker,
    );
    assert.ok(!drifted.includes("ports"));
  });

  it("compares multiple host bindings as sorted set", () => {
    const { drifted } = diffContainerConfig(
      reqBase({
        ports: { "9000/tcp": "127.0.0.1:9000" },
      }),
      liveBase({
        portBindings: new Map([
          [
            "9000/tcp",
            [
              { hostIp: "::", hostPort: 9000 },
              { hostIp: "127.0.0.1", hostPort: 9000 },
            ],
          ],
        ]),
      }),
      docker,
    );
    // Different cardinality -> drift.
    assert.ok(drifted.includes("ports"));
  });

  it("does NOT flag drift when ports match exactly", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ ports: { "9000/tcp": "127.0.0.1:9000" } }),
      liveBase({
        portBindings: new Map([
          ["9000/tcp", [{ hostIp: "127.0.0.1", hostPort: 9000 }]],
        ]),
      }),
      docker,
    );
    assert.ok(!drifted.includes("ports"));
  });
});

describe("diffContainerConfig — multi-field drift", () => {
  it("reports every drifted field, not just the first", () => {
    const { drifted } = diffContainerConfig(
      reqBase({
        tag: "9.1.0",
        env: { FOO: "2" },
        volumes: { "/data": "/host/new" },
      }),
      liveBase({
        tag: "9.0.0",
        env: new Map([["FOO", "1"]]),
        binds: [{ host: "/host/old", container: "/data" }],
      }),
      docker,
    );
    assert.ok(drifted.includes("image+tag"));
    assert.ok(drifted.includes("env"));
    assert.ok(drifted.includes("volumes"));
  });
});

describe("diffContainerConfig — unset detection via prior config", () => {
  it("flags command drift when prior had command and requested doesn't", () => {
    const { drifted } = diffContainerConfig(
      reqBase(), // command undefined
      liveBase({ command: ["sleep", "60"] }), // image runs whatever was set last
      docker,
      reqBase({ command: ["sleep", "60"] }), // prior had explicit command
    );
    assert.ok(drifted.includes("command"));
  });

  it("does NOT flag command drift when neither prior nor requested set command", () => {
    const { drifted } = diffContainerConfig(
      reqBase(),
      liveBase({ command: ["/app/bin/run.sh"] }), // image-baked CMD
      docker,
      reqBase(), // prior also unset
    );
    assert.ok(!drifted.includes("command"));
  });

  it("flags env drift when prior set a key that is now removed from requested", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ env: { KEEP: "1" } }),
      liveBase({
        env: new Map([
          ["KEEP", "1"],
          ["DROPPED", "old"],
        ]),
      }),
      docker,
      reqBase({ env: { KEEP: "1", DROPPED: "old" } }),
    );
    assert.ok(drifted.includes("env"));
  });

  it("does NOT flag env drift when image-baked keys are absent from prior AND requested", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ env: { MY_FLAG: "on" } }),
      liveBase({
        env: new Map([
          ["MY_FLAG", "on"],
          ["PATH", "/usr/bin"], // image-baked, never ours
          ["JAVA_HOME", "/opt/java"], // image-baked, never ours
        ]),
      }),
      docker,
      reqBase({ env: { MY_FLAG: "on" } }), // prior matches requested
    );
    assert.ok(!drifted.includes("env"));
  });

  it("flags env drift via positive change AND unset in same call", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ env: { CHANGED: "new" } }),
      liveBase({
        env: new Map([
          ["CHANGED", "old"],
          ["DROPPED", "x"],
        ]),
      }),
      docker,
      reqBase({ env: { CHANGED: "old", DROPPED: "x" } }),
    );
    assert.ok(drifted.includes("env"));
  });

  it("works without prior — undefined prior falls back to today's behavior", () => {
    // No prior → only positive drift detectable. Removed env keys not flagged.
    const { drifted } = diffContainerConfig(
      reqBase({ env: { ONE: "1" } }),
      liveBase({
        env: new Map([
          ["ONE", "1"],
          ["GHOST", "x"], // never explicitly tracked, but no prior to compare
        ]),
      }),
      docker,
      // prior omitted
    );
    assert.ok(!drifted.includes("env"));
  });
});

describe("diffContainerConfig — extraHosts", () => {
  it("respects user override of host.containers.internal under docker (no drift)", () => {
    // User explicitly sets host.containers.internal to a custom IP.
    // The auto-inject must NOT overwrite it; live state has the same
    // user-provided mapping, so no drift fires.
    const { drifted } = diffContainerConfig(
      reqBase({ extraHosts: { "host.containers.internal": "192.168.1.50" } }),
      liveBase({
        extraHosts: new Map([["host.containers.internal", "192.168.1.50"]]),
      }),
      docker,
    );
    assert.ok(!drifted.includes("extraHosts"));
  });

  it("flags drift when user override differs from live extraHosts", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ extraHosts: { "host.containers.internal": "192.168.1.50" } }),
      liveBase({
        extraHosts: new Map([["host.containers.internal", "host-gateway"]]),
      }),
      docker,
    );
    assert.ok(drifted.includes("extraHosts"));
  });

  it("no drift on docker under container: netns where the injection is skipped", () => {
    // buildCreateOptions skips the host-gateway injection under a
    // `container:` network mode (Docker rejects the combination), so the
    // live container legitimately has no ExtraHosts. The diff mirror must
    // skip the injection too or every reconcile would recreate the
    // container.
    const { drifted } = diffContainerConfig(
      reqBase({ networkMode: "container:abc123" }),
      liveBase({ networkMode: "container:abc123" }),
      docker,
    );
    assert.ok(!drifted.includes("extraHosts"));
  });

  it("no drift on podman when neither side has extraHosts (podman auto-adds, doesn't record)", () => {
    // Podman auto-adds host.containers.internal natively but doesn't
    // record it in HostConfig.ExtraHosts. The diff code only injects
    // the key on docker, so both sides stay empty and no drift fires.
    const { drifted } = diffContainerConfig(reqBase(), liveBase(), podman);
    assert.ok(!drifted.includes("extraHosts"));
  });
});

describe("diffContainerConfig — ownership (user)", () => {
  // The pinned resolver above maps host UID/GID to 1000:1000.

  it("no drift on docker when live user matches the expected host:host mapping", () => {
    const { drifted } = diffContainerConfig(
      reqBase(),
      liveBase({ user: "1000:1000" }),
      docker,
    );
    assert.ok(!drifted.includes("user"));
  });

  it("flags drift when live user is empty but the request would emit --user", () => {
    // Container was created before this version (no --user); next call
    // would emit `--user 1000:1000`. Recreate so the new ownership
    // semantics take effect.
    const { drifted } = diffContainerConfig(
      reqBase(),
      liveBase({ user: "" }),
      docker,
    );
    assert.ok(drifted.includes("user"));
  });

  it("flags drift when explicit ContainerConfig.user changes the UID:GID", () => {
    // On docker / rootful podman, declaring `user: { inImageUid, inImageGid }`
    // emits --user with that explicit in-image UID:GID (not the host
    // caller's UID). Drift fires when the live Config.User diverges
    // from the resolved expected — here, requesting 1500:1500 against a
    // live 0:0 must be flagged so the container is recreated.
    const { drifted } = diffContainerConfig(
      reqBase({ user: { inImageUid: 1500, inImageGid: 1500 } }),
      liveBase({ user: "0:0" }),
      docker,
    );
    assert.ok(drifted.includes("user"));
  });

  it("no drift when user: false (opt-out) — no expected flag to compare against", () => {
    // Opt-out means the translator emits nothing. Whatever the image's
    // USER directive produced is what we expect; no signal here.
    const { drifted } = diffContainerConfig(
      reqBase({ user: false }),
      liveBase({ user: "" }),
      docker,
    );
    assert.ok(!drifted.includes("user"));
  });

  it("no drift on rootless podman (keep-id doesn't surface in Config.User)", () => {
    // Rootless podman uses --userns=keep-id, not --user. Config.User
    // stays empty even though ownership IS aligned. Drift detection
    // intentionally suppresses the user field in this case.
    const podmanRootless: ContainerRuntimeInfo = {
      runtime: "podman",
      version: "5.4.2",
      isPodmanDockerShim: false,
      isRootless: true,
    };
    const { drifted } = diffContainerConfig(
      reqBase(),
      liveBase({ user: "" }),
      podmanRootless,
    );
    assert.ok(!drifted.includes("user"));
  });
});

describe("diffContainerConfig — recovery path documentation", () => {
  // When `classifyVolumeSources` filters out a 'skip' volume, the
  // requested map shrinks. After the source recovers, the next call
  // passes the (now-larger) requested map; this test documents that
  // diff treats the "missing in requested, present in live" case
  // correctly — when a previously-skipped mount comes back, the diff
  // detects drift and the inner ensureRunning recreates with the
  // mount. The recovery event-emit in the wrapper depends on this
  // pre-existing behaviour.
  it("recovery: requested volume absent from live -> volumes drift", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ volumes: { "/usb": "/media/USB" } }),
      liveBase({ binds: [] }), // live has no /usb mount yet (was previously skipped)
      docker,
    );
    assert.ok(drifted.includes("volumes"));
  });
});

describe("diffContainerConfig — devices", () => {
  // Live shape a docker container created from `devices: ["/dev/snd",
  // "/dev/ttyUSB0"]` reports back: the node in HostConfig.Devices, the
  // class rule in DeviceCgroupRules, the hot-plug directory in Binds.
  const dockerLiveWithDevices = () =>
    liveBase({
      devices: [
        {
          pathOnHost: "/dev/ttyUSB0",
          pathInContainer: "/dev/ttyUSB0",
          cgroupPermissions: "rwm",
        },
      ],
      deviceCgroupRules: ["c 116:* rwm"],
      binds: [{ host: "/dev/snd", container: "/dev/snd" }],
      // Docker auto-injects the host-gateway mapping; mirror it live so
      // the all-fields no-drift assertions stay about devices.
      extraHosts: new Map([["host.containers.internal", "host-gateway"]]),
    });

  it("no drift on docker when the emission matches live (node + directory)", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/snd", "/dev/ttyUSB0"] }),
      dockerLiveWithDevices(),
      docker,
    );
    assert.deepEqual(drifted, []);
  });

  it("no drift across entry-syntax variants (expansion is canonicalized)", () => {
    // Explicitly spelling out the defaults must compare equal to the
    // shorthand the container was created from.
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/snd", "/dev/ttyUSB0:/dev/ttyUSB0:mwr"] }),
      dockerLiveWithDevices(),
      docker,
    );
    assert.deepEqual(drifted, []);
  });

  it("treats live empty CgroupPermissions as the rwm default (podman-style report)", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/ttyUSB0"] }),
      liveBase({
        devices: [
          {
            pathOnHost: "/dev/ttyUSB0",
            pathInContainer: "/dev/ttyUSB0",
            cgroupPermissions: "",
          },
        ],
      }),
      docker,
    );
    assert.ok(!drifted.includes("devices"));
  });

  it("flags drift on docker when a device is added", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/ttyUSB0"] }),
      liveBase(), // live has no devices
      docker,
    );
    assert.ok(drifted.includes("devices"));
  });

  it("flags drift on docker when a previously-set device list is unset (no prior needed)", () => {
    const { drifted } = diffContainerConfig(
      reqBase(), // devices undefined
      dockerLiveWithDevices(),
      docker,
    );
    assert.ok(drifted.includes("devices"));
  });

  it("flags drift on docker when permissions change", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/ttyUSB0:/dev/ttyUSB0:rw"] }),
      dockerLiveWithDevices(),
      docker,
    );
    assert.ok(drifted.includes("devices"));
  });

  it("no drift on docker when a still-missing device was skipped at create time", () => {
    // /dev/ttyACM9 doesn't exist in the pinned host stats: it was
    // skipped from the emission, so live legitimately has no device.
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/ttyACM9"] }),
      liveBase(),
      docker,
    );
    assert.ok(!drifted.includes("devices"));
  });

  it("flags drift on docker when a previously-missing device has appeared (recovery)", () => {
    // Same config as the skip case above, but the device now exists —
    // the emission gains the node, live doesn't have it, recreate picks
    // it up. Mirrors the volumes ifMissing-skip recovery path.
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/ttyUSB0"] }),
      liveBase(),
      docker,
    );
    assert.ok(drifted.includes("devices"));
  });

  it("directory device compares through the volumes axis on podman (no drift when bound)", () => {
    // Podman reports Devices [] and rules null regardless of what the
    // container was created with, so only the bind is comparable —
    // and it must be enough to keep an unchanged config from drifting.
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/snd"] }),
      liveBase({ binds: [{ host: "/dev/snd", container: "/dev/snd" }] }),
      podman,
    );
    assert.deepEqual(drifted, []);
  });

  it("directory device added on podman -> volumes drift via the missing bind", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/snd"] }),
      liveBase({ binds: [] }),
      podman,
    );
    assert.ok(drifted.includes("volumes"));
  });

  it("node devices do NOT live-compare on podman (inspect is blind there)", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/ttyUSB0"] }),
      liveBase(), // podman reports [] even though the node was applied
      podman,
    );
    assert.ok(!drifted.includes("devices"));
  });

  it("flags drift on podman when prior had devices and requested unsets them", () => {
    const { drifted } = diffContainerConfig(
      reqBase(),
      liveBase(),
      podman,
      reqBase({ devices: ["/dev/ttyUSB0"] }),
    );
    assert.ok(drifted.includes("devices"));
  });

  it("flags drift on podman when the node list changed vs prior", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/ttyACM0"] }),
      liveBase(),
      podman,
      reqBase({ devices: ["/dev/ttyUSB0"] }),
    );
    assert.ok(drifted.includes("devices"));
  });

  it("no drift on podman when devices match prior", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ devices: ["/dev/ttyUSB0"] }),
      liveBase(),
      podman,
      reqBase({ devices: ["/dev/ttyUSB0"] }),
    );
    assert.ok(!drifted.includes("devices"));
  });
});

describe("diffContainerConfig — groupAdd", () => {
  it("no drift when the host-resolved GIDs match live (name vs numeric form)", () => {
    // The container was created from `groupAdd: ["audio"]` → live holds
    // the resolved "29". The same config must not drift.
    const { drifted } = diffContainerConfig(
      reqBase({ groupAdd: ["audio"] }),
      liveBase({ groupAdd: ["29"] }),
      docker,
    );
    assert.ok(!drifted.includes("groupAdd"));
  });

  it("compares as an unordered set", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ groupAdd: [995, "audio"] }),
      liveBase({ groupAdd: ["29", "995"] }),
      docker,
    );
    assert.ok(!drifted.includes("groupAdd"));
  });

  it("flags drift when a group is added", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ groupAdd: ["audio", "dialout"] }),
      liveBase({ groupAdd: ["29"] }),
      docker,
    );
    assert.ok(drifted.includes("groupAdd"));
  });

  it("flags drift when a previously-set groupAdd is unset (no prior needed)", () => {
    const { drifted } = diffContainerConfig(
      reqBase(),
      liveBase({ groupAdd: ["29"] }),
      docker,
    );
    assert.ok(drifted.includes("groupAdd"));
  });

  it("no drift when neither side has groups", () => {
    const { drifted } = diffContainerConfig(reqBase(), liveBase(), docker);
    assert.ok(!drifted.includes("groupAdd"));
  });

  it("an unresolvable name is skipped from the transform, matching its skip at create time", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ groupAdd: ["nonexistent", "audio"] }),
      liveBase({ groupAdd: ["29"] }),
      docker,
    );
    assert.ok(!drifted.includes("groupAdd"));
  });

  it("works the same on podman (GroupAdd is reported there, unlike Devices)", () => {
    const { drifted } = diffContainerConfig(
      reqBase({ groupAdd: ["audio"] }),
      liveBase({ groupAdd: ["29"] }),
      podman,
    );
    assert.ok(!drifted.includes("groupAdd"));
    const changed = diffContainerConfig(
      reqBase({ groupAdd: ["dialout"] }),
      liveBase({ groupAdd: ["29"] }),
      podman,
    );
    assert.ok(changed.drifted.includes("groupAdd"));
  });
});
