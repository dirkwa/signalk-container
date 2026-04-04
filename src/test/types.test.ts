import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ContainerConfig,
  ContainerManagerApi,
  ContainerRuntimeInfo,
  ContainerState,
} from "../types";

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
    ];
    assert.equal(methods.length, 10);
  });
});
