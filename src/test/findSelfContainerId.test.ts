import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSelfContainerIdFromCgroup,
  parseSelfContainerIdsFromCgroupFile,
  parseSelfContainerIdsFromMountinfo,
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

describe("parseSelfContainerIdsFromMountinfo", () => {
  // mountinfo-based detection is the 4th cascade step in
  // findSelfContainerId. It's the one that rescues Quadlet
  // `Network=host` rootless-Podman setups where the previous three
  // steps (env override, HOSTNAME, /proc/self/cgroup) all fail. See
  // the docstring on parseSelfContainerIdsFromMountinfo for context.

  it("extracts the id from a real Podman Quadlet /etc/hostname bindfs entry", () => {
    // Captured verbatim from the signalk-server running under a
    // Quadlet with `Network=host` and split cgroups.
    const line =
      "476 504 0:48 /containers/overlay-containers/49f02ce44e62f776d9c528ef9a71b7bb10ddb7b02a07e4e0902b355a881c9428/userdata/.containerenv /run/.containerenv rw,nosuid,nodev,relatime - tmpfs tmpfs rw";
    assert.deepEqual(parseSelfContainerIdsFromMountinfo(line), [
      "49f02ce44e62f776d9c528ef9a71b7bb10ddb7b02a07e4e0902b355a881c9428",
    ]);
  });

  it("extracts the id from a real Docker bindfs entry under /<id>/hostname", () => {
    // Docker writes its bindfs files under /var/lib/docker/containers/<id>/...
    // which appears in mountinfo as /<id>/hostname etc.
    const id =
      "3338a90a8e88c5d7b6a1f7b8b9c1234567890abcdef0123456789abcdef01234";
    assert.equal(id.length, 64);
    const line = `100 200 0:42 /${id}/hostname /etc/hostname rw,relatime - tmpfs tmpfs rw`;
    assert.deepEqual(parseSelfContainerIdsFromMountinfo(line), [id]);
  });

  it("dedupes when the same id appears across hostname / resolv.conf / hosts entries", () => {
    // A real /proc/self/mountinfo from a Podman container contains
    // four lines under the same /containers/overlay-containers/<id>/userdata/
    // prefix. Dedup means findSelfContainerId only validates the id
    // once via inspect.
    const id =
      "49f02ce44e62f776d9c528ef9a71b7bb10ddb7b02a07e4e0902b355a881c9428";
    const content = [
      `476 504 0:48 /containers/overlay-containers/${id}/userdata/.containerenv /run/.containerenv rw`,
      `479 504 0:48 /containers/overlay-containers/${id}/userdata/hostname /etc/hostname rw`,
      `480 504 0:48 /containers/overlay-containers/${id}/userdata/resolv.conf /etc/resolv.conf rw`,
      `498 504 0:48 /containers/overlay-containers/${id}/userdata/hosts /etc/hosts rw`,
    ].join("\n");
    assert.deepEqual(parseSelfContainerIdsFromMountinfo(content), [id]);
  });

  it("ignores overlay layer hashes that share the 64-hex shape", () => {
    // The overlay /rootfs mount line embeds upperdir / lowerdir paths
    // whose components are 64-char hex but are NOT the container id.
    // Without the bindfs file-name anchor (hostname / resolv.conf /
    // containerenv / userdata), these would false-positive.
    const layerId =
      "3db769c35ef3c90f13623fdf6b0f14b653573b6d8f65249454b1d04694ee52a0";
    const line = `504 380 0:50 / / rw,relatime - overlay overlay rw,lowerdir=/foo,upperdir=/home/dirk/.local/share/containers/storage/overlay/${layerId}/diff,workdir=/x`;
    assert.deepEqual(parseSelfContainerIdsFromMountinfo(line), []);
  });

  it("returns [] for bare-metal mountinfo (no container-shaped paths)", () => {
    const content = [
      "23 28 0:21 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw",
      "24 28 0:5 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw",
      "25 28 0:6 / /dev rw,nosuid shared:3 - devtmpfs devtmpfs rw,size=4k",
    ].join("\n");
    assert.deepEqual(parseSelfContainerIdsFromMountinfo(content), []);
  });

  it("returns [] for empty content", () => {
    assert.deepEqual(parseSelfContainerIdsFromMountinfo(""), []);
  });

  it("requires exactly 64 hex chars (short ids in this path are not standard)", () => {
    // Unlike /proc/self/cgroup, where Docker historically wrote
    // 12-char short ids, mountinfo's bindfs paths always use the
    // long form. Tightening the regex avoids picking up partial
    // matches inside unrelated 12+ hex spans.
    const shortInPodmanPath =
      "476 504 0:48 /containers/overlay-containers/49f02ce44e62/userdata/.containerenv /run/.containerenv rw";
    assert.deepEqual(parseSelfContainerIdsFromMountinfo(shortInPodmanPath), []);
    const shortInDockerPath =
      "100 200 0:42 /49f02ce44e62/hostname /etc/hostname rw";
    assert.deepEqual(parseSelfContainerIdsFromMountinfo(shortInDockerPath), []);
  });
});
