import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  diffContainerConfig,
  type LiveContainerConfig,
} from "../containers.js";
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

// Pin the host UID/GID resolver so user-mapping flags are deterministic
// across CI (often UID 0) and dev machines (often UID 1000).
// `liveBase().user` is set to the same `1000:1000` string so the
// existing no-drift tests stay no-drift; tests asserting `user` drift
// override `user` explicitly.
before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

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
