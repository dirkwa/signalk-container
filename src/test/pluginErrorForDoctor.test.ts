import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pluginErrorForDoctor } from "../index.js";
import type { SelfDeploymentResult } from "../types.js";

function result(
  over: Partial<SelfDeploymentResult> = {},
): SelfDeploymentResult {
  return {
    isContainerized: true,
    platform: null,
    binary: { name: "docker", path: null, version: "27.0" },
    daemon: {
      reachable: false,
      rootless: null,
      socketPath: "/var/run/docker.sock",
      error: "connect EACCES",
    },
    env: { DOCKER_HOST: null, CONTAINER_HOST: null, XDG_RUNTIME_DIR: null },
    selfId: { value: null, source: null },
    cgroupControllers: {
      available: null,
      missing: [],
      kernelDisabledMemory: false,
    },
    containerStorage: null,
    linger: null,
    networkDns: null,
    status: "permission-denied",
    remediation: [],
    ...over,
  };
}

describe("pluginErrorForDoctor", () => {
  const HEADLINE = "Runtime socket: permission denied";

  it("uses the HaLOS-specific lead for permission-denied on HaLOS", () => {
    const msg = pluginErrorForDoctor(
      result({ platform: "halos", status: "permission-denied" }),
      HEADLINE,
    );
    assert.match(msg, /HaLOS: Signal K is not yet allowed to use docker/);
    assert.match(msg, /click Doctor/);
    assert.doesNotMatch(msg, new RegExp(HEADLINE));
  });

  it("keeps the generic headline for permission-denied off HaLOS", () => {
    const msg = pluginErrorForDoctor(
      result({ platform: null, status: "permission-denied" }),
      HEADLINE,
    );
    assert.match(msg, new RegExp(HEADLINE));
    assert.doesNotMatch(msg, /HaLOS:/);
  });

  it("keeps the generic headline for a non-permission failure on HaLOS", () => {
    // HaLOS host, but the failure is socket-unreachable, not a refused ACL —
    // the compose-group fix does not apply, so no HaLOS lead.
    const msg = pluginErrorForDoctor(
      result({ platform: "halos", status: "socket-unreachable" }),
      "Runtime socket unreachable",
    );
    assert.match(msg, /Runtime socket unreachable/);
    assert.doesNotMatch(msg, /HaLOS:/);
  });
});
