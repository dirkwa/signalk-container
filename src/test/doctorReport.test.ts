import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDoctorReport,
  headlineForStatus,
  isSelfDeploymentResult,
} from "../doctorReport.js";
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
    linger: null,
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
          storagePath: "/var/lib/containers/storage",
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

  it("includes the linger line and advice when linger is not enabled", () => {
    const out = formatDoctorReport(
      baseResult({
        linger: {
          user: "dirk",
          enabled: false,
          advice: ['  sudo loginctl enable-linger "$USER"'],
        },
      }),
    );
    assert.match(out, /systemd linger: NOT enabled for dirk/);
    assert.match(out, /Linger advice:/);
    assert.match(out, /loginctl enable-linger/);
  });

  it("renders linger enabled without an advice block", () => {
    const out = formatDoctorReport(
      baseResult({ linger: { user: null, enabled: true, advice: [] } }),
    );
    assert.match(out, /systemd linger: enabled/);
    assert.doesNotMatch(out, /Linger advice:/);
  });

  it("includes the daemon error line when the daemon is unreachable", () => {
    const out = formatDoctorReport(
      baseResult({
        daemon: {
          reachable: false,
          rootless: null,
          socketPath: null,
          error: "connection refused",
        },
        status: "socket-unreachable",
      }),
    );
    assert.match(out, /daemon error: connection refused/);
  });

  it("notes a kernel-disabled memory controller", () => {
    const out = formatDoctorReport(
      baseResult({
        isContainerized: true,
        cgroupControllers: {
          available: ["cpu", "cpuset", "io", "pids"],
          missing: ["memory"],
          kernelDisabledMemory: true,
        },
        status: "cgroup-controllers-incomplete",
      }),
    );
    assert.match(out, /kernel cmdline disables the memory controller/);
  });

  it("lists only the set env vars", () => {
    const out = formatDoctorReport(
      baseResult({
        env: {
          DOCKER_HOST: "unix:///custom/socket",
          CONTAINER_HOST: null,
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
      }),
    );
    assert.match(out, /DOCKER_HOST=unix:\/\/\/custom\/socket/);
    assert.match(out, /XDG_RUNTIME_DIR=\/run\/user\/1000/);
    assert.doesNotMatch(out, /CONTAINER_HOST/);
  });
});

describe("isSelfDeploymentResult", () => {
  it("accepts a well-formed result", () => {
    assert.equal(isSelfDeploymentResult(baseResult()), true);
  });

  it("rejects non-objects and null", () => {
    assert.equal(isSelfDeploymentResult(null), false);
    assert.equal(isSelfDeploymentResult("nope"), false);
    assert.equal(isSelfDeploymentResult(42), false);
  });

  it("rejects an object missing required fields", () => {
    assert.equal(isSelfDeploymentResult({ status: "ok" }), false);
    assert.equal(
      isSelfDeploymentResult({ ...baseResult(), remediation: "oops" }),
      false,
    );
    assert.equal(
      isSelfDeploymentResult({ ...baseResult(), isContainerized: "yes" }),
      false,
    );
  });

  it("rejects malformed nested shapes the formatter dereferences", () => {
    // daemon without the boolean `reachable` the formatter reads.
    assert.equal(
      isSelfDeploymentResult({ ...baseResult(), daemon: {} }),
      false,
    );
    // env must be an object — formatDoctorReport calls Object.entries on it.
    assert.equal(isSelfDeploymentResult({ ...baseResult(), env: null }), false);
    // cgroupControllers.missing must be an array (it is `.join`-ed/`.length`-ed).
    assert.equal(
      isSelfDeploymentResult({
        ...baseResult(),
        cgroupControllers: { available: null, missing: "memory" },
      }),
      false,
    );
    // available, when present, must be an array.
    assert.equal(
      isSelfDeploymentResult({
        ...baseResult(),
        cgroupControllers: {
          available: "cpu memory",
          missing: [],
          kernelDisabledMemory: false,
        },
      }),
      false,
    );
    // binary / selfId must be objects.
    assert.equal(isSelfDeploymentResult({ ...baseResult(), binary: 5 }), false);
    assert.equal(
      isSelfDeploymentResult({ ...baseResult(), selfId: null }),
      false,
    );
  });

  it("validates linger when present, tolerates it absent or null", () => {
    // Absent entirely (payload from an older server) and null (probe
    // skipped) both pass — the renderers guard on truthiness.
    const withoutLinger: Record<string, unknown> = { ...baseResult() };
    delete withoutLinger.linger;
    assert.equal(isSelfDeploymentResult(withoutLinger), true);
    assert.equal(
      isSelfDeploymentResult({ ...baseResult(), linger: null }),
      true,
    );
    assert.equal(
      isSelfDeploymentResult({
        ...baseResult(),
        linger: { user: "dirk", enabled: true, advice: [] },
      }),
      true,
    );
    // A present object must carry the dereferenced shape: advice is
    // `.join`-ed/`.length`-ed, enabled and user are rendered directly.
    assert.equal(
      isSelfDeploymentResult({ ...baseResult(), linger: {} }),
      false,
    );
    assert.equal(
      isSelfDeploymentResult({ ...baseResult(), linger: "enabled" }),
      false,
    );
    assert.equal(
      isSelfDeploymentResult({
        ...baseResult(),
        linger: { user: 42, enabled: true, advice: [] },
      }),
      false,
    );
    assert.equal(
      isSelfDeploymentResult({
        ...baseResult(),
        linger: { user: null, enabled: true, advice: "do this" },
      }),
      false,
    );
  });
});
