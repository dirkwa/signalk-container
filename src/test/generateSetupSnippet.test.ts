import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSetupSnippet } from "../doctor.js";
import type { SelfDeploymentResult } from "../types.js";

/**
 * Synthesize a SelfDeploymentResult for snippet-generation tests.
 * Defaults to a bare-metal/no-runtime baseline; tests override the
 * specific fields they care about.
 */
function fakeResult(
  overrides: Partial<SelfDeploymentResult> = {},
): SelfDeploymentResult {
  return {
    isContainerized: false,
    binary: { name: null, path: null, version: null },
    daemon: {
      reachable: false,
      rootless: null,
      socketPath: null,
      error: null,
    },
    env: { DOCKER_HOST: null, CONTAINER_HOST: null, XDG_RUNTIME_DIR: null },
    selfId: { value: null, source: null },
    status: "ok",
    remediation: [],
    ...overrides,
  };
}

describe("generateSetupSnippet — runtime + rootless variants", () => {
  it("podman + rootless + compose: CONTAINER_HOST + user as 1000:1000", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
        daemon: {
          reachable: true,
          rootless: true,
          socketPath: null,
          error: null,
        },
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    assert.equal(r.format, "compose");
    assert.equal(r.runtime, "podman");
    assert.equal(r.rootless, true);
    assert.match(r.snippet, /user: "1000:1000"/);
    assert.match(
      r.snippet,
      /\/run\/user\/1000\/podman\/podman\.sock:\/run\/user\/1000\/podman\/podman\.sock/,
    );
    assert.match(
      r.snippet,
      /CONTAINER_HOST=unix:\/\/\/run\/user\/1000\/podman\/podman\.sock/,
    );
  });

  it("podman + rootless + run: same fields in backslash-continued shell form", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
        daemon: {
          reachable: true,
          rootless: true,
          socketPath: null,
          error: null,
        },
      }),
      "run",
      { uid: 1000, gid: 1000 },
    );
    assert.equal(r.format, "run");
    assert.ok(r.snippet.startsWith("podman run -d"));
    assert.match(r.snippet, /--user 1000:1000/);
    assert.match(r.snippet, /-e CONTAINER_HOST=unix:\/\/\/run\/user\/1000/);
    // Line continuations exist (multi-line shell invocation).
    assert.match(r.snippet, /\\\n {2}/);
  });

  it("podman + rootful + compose: system socket, no user remap", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
        daemon: {
          reachable: true,
          rootless: false,
          socketPath: null,
          error: null,
        },
      }),
      "compose",
      { uid: 0, gid: 0 },
    );
    assert.equal(r.rootless, false);
    assert.match(r.snippet, /\/run\/podman\/podman\.sock/);
    assert.doesNotMatch(r.snippet, /\/run\/user\//);
  });

  it("docker + compose: docker.sock bind + group_add line", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "docker", path: "/usr/bin/docker", version: "26.1.4" },
        daemon: {
          reachable: true,
          rootless: false,
          socketPath: null,
          error: null,
        },
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    assert.equal(r.runtime, "docker");
    assert.equal(r.rootless, false);
    assert.match(
      r.snippet,
      /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/,
    );
    assert.match(r.snippet, /group_add:/);
    assert.match(r.snippet, /\$\{DOCKER_GID\}/);
  });

  it("docker + run: --group-add fragment", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "docker", path: "/usr/bin/docker", version: "26.1.4" },
        daemon: {
          reachable: true,
          rootless: false,
          socketPath: null,
          error: null,
        },
      }),
      "run",
      { uid: 1000, gid: 1000 },
    );
    assert.match(r.snippet, /--group-add "\$\(getent group docker/);
  });
});

describe("generateSetupSnippet — hostUser handling", () => {
  it("hostUser null (Windows) → no literal uid, ${UID}/${GID} placeholders + note", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
        daemon: {
          reachable: true,
          rootless: true,
          socketPath: null,
          error: null,
        },
      }),
      "compose",
      null,
    );
    assert.match(r.snippet, /\$\{UID\}:\$\{GID\}/);
    assert.match(r.snippet, /\$\{UID\}/);
    assert.ok(
      r.notes.some((n) => /host UID\/GID could not be determined/i.test(n)),
      "should include a note about UID resolution",
    );
    // Dockerfile sidecar is suppressed when running on Windows/non-POSIX
    // because operators there don't typically rebuild the SK image.
    assert.equal(r.dockerfile, "");
  });

  it("hostUser provided → literal uid/gid in snippet", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
      }),
      "compose",
      { uid: 1500, gid: 1500 },
    );
    assert.match(r.snippet, /user: "1500:1500"/);
    assert.match(r.snippet, /\/run\/user\/1500\/podman/);
  });
});

describe("generateSetupSnippet — fallback when no binary detected", () => {
  it("binary.name null + compose → falls back to rootless-podman shape", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        // No binary detected, no daemon reachable; the generator's job
        // is still to produce something useful (the recommended default).
        binary: { name: null, path: null, version: null },
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    assert.equal(r.runtime, "podman");
    assert.equal(r.rootless, true);
    assert.match(r.snippet, /podman\.sock/);
  });
});

describe("generateSetupSnippet — selfId handling", () => {
  it("isContainerized + selfId via env → snippet omits SIGNALK_CONTAINER_ID line (operator already set it)", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        isContainerized: true,
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
        daemon: {
          reachable: true,
          rootless: true,
          socketPath: null,
          error: null,
        },
        selfId: { value: "signalk-host", source: "env" },
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    // selfId came from the operator's own env — we don't need to add a
    // defensive line, and we don't need to emit a note about it.
    assert.doesNotMatch(r.snippet, /SIGNALK_CONTAINER_ID/);
    assert.ok(
      !r.notes.some((n) => /SIGNALK_CONTAINER_ID/.test(n)),
      "no SIGNALK_CONTAINER_ID note when source is env",
    );
  });

  it("isContainerized + selfId via cgroup → defensive SIGNALK_CONTAINER_ID + note", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        isContainerized: true,
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
        daemon: {
          reachable: true,
          rootless: true,
          socketPath: null,
          error: null,
        },
        selfId: { value: "abc123", source: "cgroup" },
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    assert.match(r.snippet, /SIGNALK_CONTAINER_ID=signalk/);
    assert.ok(
      r.notes.some((n) => /SIGNALK_CONTAINER_ID is set defensively/.test(n)),
    );
  });

  it("isContainerized + selfId unresolved → includes SIGNALK_CONTAINER_ID line + actionable note", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        isContainerized: true,
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
        daemon: {
          reachable: true,
          rootless: true,
          socketPath: null,
          error: null,
        },
        selfId: { value: null, source: null },
        status: "self-id-unresolved",
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    assert.match(r.snippet, /SIGNALK_CONTAINER_ID=signalk/);
    assert.ok(
      r.notes.some((n) => /Self-id detection failed/.test(n)),
      "should explain why the line was added",
    );
  });
});

describe("generateSetupSnippet — Dockerfile sidecar", () => {
  it("podman → installs podman, mentions podman-remote alternative", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    assert.match(r.dockerfile, /apt-get install -y podman/);
    assert.match(r.dockerfile, /podman-remote/);
  });

  it("docker → installs docker-ce-cli", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "docker", path: "/usr/bin/docker", version: "26.1.4" },
        daemon: {
          reachable: true,
          rootless: false,
          socketPath: null,
          error: null,
        },
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    assert.match(r.dockerfile, /docker-ce-cli/);
  });
});

describe("generateSetupSnippet — notes for security/SELinux", () => {
  it("docker rootful → warns about /var/run/docker.sock granting host root", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "docker", path: "/usr/bin/docker", version: "26.1.4" },
        daemon: {
          reachable: true,
          rootless: false,
          socketPath: null,
          error: null,
        },
      }),
      "compose",
      { uid: 1000, gid: 1000 },
    );
    assert.ok(
      r.notes.some((n) => /root-equivalent access to/i.test(n)),
      "should warn about docker.sock root exposure",
    );
  });

  it("rootful podman → mentions SELinux :Z flag concern", async () => {
    const r = generateSetupSnippet(
      fakeResult({
        binary: { name: "podman", path: "/usr/bin/podman", version: "5.4.2" },
        daemon: {
          reachable: true,
          rootless: false,
          socketPath: null,
          error: null,
        },
      }),
      "compose",
      { uid: 0, gid: 0 },
    );
    assert.ok(
      r.notes.some((n) => /SELinux/i.test(n)),
      "should mention SELinux for rootful podman",
    );
  });
});
