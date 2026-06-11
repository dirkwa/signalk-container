import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDoctorReport, headlineForStatus } from "../doctorReport.js";
import type { SelfDeploymentResult, SelfDeploymentStatus } from "../types.js";

const ALL_STATUSES: SelfDeploymentStatus[] = [
  "ok",
  "no-runtime",
  "socket-unreachable",
  "permission-denied",
  "self-id-unresolved",
  "cgroup-controllers-incomplete",
];

function baseResult(
  over: Partial<SelfDeploymentResult> = {},
): SelfDeploymentResult {
  return {
    isContainerized: false,
    binary: { name: "podman", path: null, version: "5.4.2" },
    daemon: {
      reachable: true,
      rootless: true,
      socketPath: "/run/user/1000/podman/podman.sock",
      error: null,
    },
    env: { DOCKER_HOST: null, CONTAINER_HOST: null, XDG_RUNTIME_DIR: null },
    selfId: { value: null, source: null },
    cgroupControllers: {
      available: ["cpu", "cpuset", "io", "memory", "pids"],
      missing: [],
      kernelDisabledMemory: false,
    },
    containerStorage: null,
    status: "ok",
    remediation: [],
    ...over,
  };
}

describe("headlineForStatus", () => {
  it("returns a distinct, non-empty headline for every status", () => {
    const seen = new Set<string>();
    for (const status of ALL_STATUSES) {
      const h = headlineForStatus(status);
      assert.ok(h.length > 0, `empty headline for ${status}`);
      assert.ok(!seen.has(h), `duplicate headline "${h}" for ${status}`);
      seen.add(h);
    }
  });
});

describe("formatDoctorReport", () => {
  it("reports an ok deployment with the runtime line and no-action note", () => {
    const out = formatDoctorReport(baseResult());
    assert.match(out, /Runtime ready/);
    assert.match(out, /status: ok/);
    assert.match(out, /podman 5\.4\.2/);
    assert.match(out, /No action needed/);
  });

  it("surfaces missing cgroup controllers and the remediation block", () => {
    const out = formatDoctorReport(
      baseResult({
        isContainerized: true,
        cgroupControllers: {
          available: ["cpu", "cpuset", "io", "pids"],
          missing: ["memory"],
          kernelDisabledMemory: false,
        },
        status: "cgroup-controllers-incomplete",
        remediation: ["Add Delegate=memory to the user@.service drop-in."],
      }),
    );
    assert.match(out, /cgroup controllers MISSING: memory/);
    assert.match(out, /Add Delegate=memory/);
    assert.doesNotMatch(out, /No action needed/);
  });

  it("includes the self-id row for a containerized self-id-unresolved result", () => {
    const out = formatDoctorReport(
      baseResult({
        isContainerized: true,
        selfId: { value: null, source: null },
        status: "self-id-unresolved",
        remediation: ["Set SIGNALK_CONTAINER_ID."],
      }),
    );
    assert.match(out, /self container id:/);
    assert.match(out, /Set SIGNALK_CONTAINER_ID/);
  });

  it("includes storage advice when the filesystem is an idmap hazard", () => {
    const out = formatDoctorReport(
      baseResult({
        containerStorage: {
          storagePath: "/home/dirk/.local/share/containers",
          fstype: "zfs",
          idmapHazard: true,
          advice: ["Switch the rootless storage driver to fuse-overlayfs."],
        },
      }),
    );
    assert.match(out, /storage: zfs/);
    assert.match(out, /idmap hazard/);
    assert.match(out, /fuse-overlayfs/);
  });
});
