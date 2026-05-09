import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSelfContainerIdFromCgroup } from "../containers";

describe("parseSelfContainerIdFromCgroup", () => {
  // Real-world cgroup entries collected from various deployments.
  // Each test pins one shape so a future refactor of the regex
  // can't silently break a class of hosts.

  it("cgroup v1 + Docker: '12:cpuset:/docker/<id>' yields the id", () => {
    const id = parseSelfContainerIdFromCgroup(
      "12:cpuset:/docker/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assert.equal(
      id,
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
  });

  it("cgroup v2 + Docker on systemd: '0::/system.slice/docker-<id>.scope'", () => {
    const id = parseSelfContainerIdFromCgroup(
      "0::/system.slice/docker-fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210.scope",
    );
    assert.equal(
      id,
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    );
  });

  it("cgroup v2 + Podman rootless: '0::/user.slice/.../libpod-<id>.scope'", () => {
    const id = parseSelfContainerIdFromCgroup(
      "0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-abc123def456abc123def456abc123def456abc123def456abc123def456ab.scope",
    );
    assert.equal(
      id,
      "abc123def456abc123def456abc123def456abc123def456abc123def456ab",
    );
  });

  it("Kubernetes / containerd: 'cri-containerd-<id>.scope'", () => {
    const id = parseSelfContainerIdFromCgroup(
      "0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod1234.slice/cri-containerd-1111111111111111111111111111111111111111111111111111111111111111.scope",
    );
    assert.equal(
      id,
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
  });

  it("short (12-char) container id is accepted", () => {
    // Both Docker and Podman tolerate the short form on `inspect`,
    // so accepting it from cgroup paths is fine.
    const id = parseSelfContainerIdFromCgroup("12:cpuset:/docker/abc123def456");
    assert.equal(id, "abc123def456");
  });

  it("returns null for a host-side bare-metal cgroup line", () => {
    // What `/proc/self/cgroup` looks like outside any container.
    assert.equal(
      parseSelfContainerIdFromCgroup(
        "0::/user.slice/user-1000.slice/session-2.scope",
      ),
      null,
    );
  });

  it("returns null for an empty line", () => {
    assert.equal(parseSelfContainerIdFromCgroup(""), null);
  });

  it("returns null when the path has no hex run of >=12 chars", () => {
    // Non-container systemd slices on a busy host shouldn't false-positive.
    assert.equal(parseSelfContainerIdFromCgroup("0::/init.scope"), null);
    assert.equal(
      parseSelfContainerIdFromCgroup("11:freezer:/system.slice/cron.service"),
      null,
    );
  });

  it("matches the cgroup v1 ':' separator after the id", () => {
    // Some runtimes write `/docker/<id>` with no trailing slash;
    // accept both forms.
    const idEol = parseSelfContainerIdFromCgroup(
      "1:name=systemd:/docker/abcdef0123456789",
    );
    assert.equal(idEol, "abcdef0123456789");
    const idTrailing = parseSelfContainerIdFromCgroup(
      "1:name=systemd:/docker/abcdef0123456789/",
    );
    assert.equal(idTrailing, "abcdef0123456789");
  });
});
