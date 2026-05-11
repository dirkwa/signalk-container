import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffContainerConfig, type LiveContainerConfig } from "../containers";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types";

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

function liveBase(
  overrides: Partial<LiveContainerConfig> = {},
): LiveContainerConfig {
  return {
    image: "questdb/questdb",
    tag: "9.0.0",
    command: null,
    networkMode: "bridge",
    env: new Map(),
    binds: [],
    portBindings: new Map(),
    ...overrides,
  };
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
    const { drifted } = diffContainerConfig(reqBase(), liveBase(), docker);
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
