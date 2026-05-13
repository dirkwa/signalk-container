import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSelfContainerIdFromCgroup,
  parseSelfContainerIdsFromCgroupFile,
} from "../containers.js";

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

describe("parseSelfContainerIdsFromCgroupFile", () => {
  // Multi-line / dedup behaviour.  `findSelfContainerId` walks every
  // returned candidate against `docker inspect` and uses the first
  // that validates — so returning all candidates (instead of just
  // the first) means a permissive-regex false positive on an early
  // cgroup line can't short-circuit detection of a real id later
  // in the file.

  it("dedups the cgroup v1 same-id-per-controller pattern to a single candidate", () => {
    // Inside a Docker container, every cgroup v1 controller line ends
    // with `/docker/<same-id>`.
    const content = [
      "12:cpuset:/docker/abcdef012345abcdef012345abcdef012345abcdef012345abcdef012345ab",
      "11:cpu,cpuacct:/docker/abcdef012345abcdef012345abcdef012345abcdef012345abcdef012345ab",
      "10:freezer:/docker/abcdef012345abcdef012345abcdef012345abcdef012345abcdef012345ab",
      "0::/docker/abcdef012345abcdef012345abcdef012345abcdef012345abcdef012345ab",
    ].join("\n");
    const ids = parseSelfContainerIdsFromCgroupFile(content);
    assert.deepEqual(ids, [
      "abcdef012345abcdef012345abcdef012345abcdef012345abcdef012345ab",
    ]);
  });

  it("preserves source-line order when ids differ", () => {
    // Theoretical: multiple distinct ids in the same cgroup file (rare,
    // but constructible if controllers are split across nested cgroups).
    // Order matters because `findSelfContainerId` validates against
    // `inspect` in order — the first that succeeds wins.
    const content = [
      "12:cpuset:/docker/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "11:cpu:/docker/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ].join("\n");
    const ids = parseSelfContainerIdsFromCgroupFile(content);
    assert.deepEqual(ids, [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("returns the v2 single-line case as a one-element array", () => {
    const content =
      "0::/system.slice/docker-fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210.scope\n";
    const ids = parseSelfContainerIdsFromCgroupFile(content);
    assert.deepEqual(ids, [
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    ]);
  });

  it("skips lines without a parseable id (host-side bare metal)", () => {
    const content = [
      "0::/user.slice/user-1000.slice/session-2.scope",
      "11:freezer:/system.slice/cron.service",
      "",
    ].join("\n");
    assert.deepEqual(parseSelfContainerIdsFromCgroupFile(content), []);
  });

  it("returns mixed-runtime ids in order (defence-in-depth: the first that inspects wins)", () => {
    // Pretend a future hybrid setup writes multiple runtime prefixes
    // into the same cgroup file.  Ordering is irrelevant for
    // correctness as long as inspect-validation downstream picks the
    // real one — but we lock the parse-order in so a future regex
    // refactor can't silently flip it.
    const content = [
      "12:cpuset:/kubepods.slice/kubepods-pod0000.slice/cri-containerd-1111111111111111111111111111111111111111111111111111111111111111.scope",
      "0::/system.slice/docker-2222222222222222222222222222222222222222222222222222222222222222.scope",
    ].join("\n");
    const ids = parseSelfContainerIdsFromCgroupFile(content);
    assert.deepEqual(ids, [
      "1111111111111111111111111111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222222222222222222222222222",
    ]);
  });

  it("returns [] for empty content", () => {
    assert.deepEqual(parseSelfContainerIdsFromCgroupFile(""), []);
  });
});
