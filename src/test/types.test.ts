import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ContainerConfig,
  ContainerManagerApi,
  ContainerRuntimeInfo,
  ContainerState,
  EnsureRunningOptions,
} from "../types.js";

describe("type contracts", () => {
  it("ContainerConfig accepts valid config", () => {
    const config: ContainerConfig = {
      image: "questdb/questdb",
      tag: "9.2.0",
      ports: { "9000/tcp": "127.0.0.1:9000" },
      volumes: {
        "/var/lib/questdb": "/tmp/plugin-config-data/questdb",
      },
      env: { QDB_TELEMETRY_ENABLED: "false" },
      restart: "unless-stopped",
    };
    assert.equal(config.image, "questdb/questdb");
    assert.equal(config.tag, "9.2.0");
    assert.equal(config.restart, "unless-stopped");
  });

  it("ContainerConfig accepts signalkDataMount and signalkConfigRootMount together", () => {
    const config: ContainerConfig = {
      image: "example/tool",
      tag: "latest",
      signalkDataMount: "/data",
      signalkConfigRootMount: "/signalk",
      signalkAccessiblePorts: [3010],
    };
    assert.equal(config.signalkDataMount, "/data");
    assert.equal(config.signalkConfigRootMount, "/signalk");
  });

  it("ContainerState enum values are correct", () => {
    const states: ContainerState[] = [
      "running",
      "stopped",
      "missing",
      "no-runtime",
    ];
    assert.equal(states.length, 4);
  });

  it("ContainerRuntimeInfo has required fields", () => {
    const info: ContainerRuntimeInfo = {
      runtime: "podman",
      version: "5.2.1",
      isPodmanDockerShim: false,
    };
    assert.equal(info.runtime, "podman");
    assert.equal(info.isPodmanDockerShim, false);
  });

  it("ContainerManagerApi shape is complete", () => {
    const methods: (keyof ContainerManagerApi)[] = [
      "getRuntime",
      "pullImage",
      "imageExists",
      "ensureRunning",
      "stop",
      "remove",
      "getState",
      "runJob",
      "prune",
      "listContainers",
      "resolveSignalkDataMount",
      "resolveHostPath",
      "manifest",
    ];
    assert.equal(methods.length, 13);
  });

  it("ContainerConfig accepts digest and updateChannel", () => {
    const config: ContainerConfig = {
      image: "questdb/questdb",
      tag: "9.0.0",
      digest: "sha256:" + "a".repeat(64),
      updateChannel: "digest:explicit",
    };
    assert.equal(config.updateChannel, "digest:explicit");
  });

  it("EnsureRunningOptions accepts pluginId and pluginVersion", () => {
    const opts: EnsureRunningOptions = {
      pluginId: "signalk-questdb",
      pluginVersion: "1.0.0",
    };
    assert.equal(opts.pluginId, "signalk-questdb");
  });
});
