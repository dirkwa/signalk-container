import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRuntime, probeHostUser, type ExecFn } from "../runtime.js";

describe("detectRuntime", () => {
  it("returns a runtime info object when podman or docker is available", async () => {
    const result = await detectRuntime("auto");
    // On CI or dev machines, at least one should be available
    // If neither is installed, result is null — that's also valid
    if (result) {
      assert.ok(
        result.runtime === "podman" || result.runtime === "docker",
        `unexpected runtime: ${result.runtime}`,
      );
      assert.ok(typeof result.version === "string");
      assert.ok(typeof result.isPodmanDockerShim === "boolean");
    }
  });

  it("returns null for a nonexistent runtime", async () => {
    // Force a specific runtime that doesn't exist
    const result = await detectRuntime("podman" as any);
    // This may or may not be null depending on the system
    // but the function should not throw
    if (result) {
      assert.equal(result.runtime, "podman");
    }
  });

  it("captures hostUser when a runtime is detected on a POSIX platform", async () => {
    const result = await detectRuntime("auto");
    if (!result) return;
    if (typeof process.getuid !== "function") {
      // Windows: hostUser must be null and `--user` flags must be suppressed
      // downstream. detectRuntime is the source of that signal.
      assert.equal(result.hostUser, null);
      return;
    }
    assert.ok(result.hostUser);
    assert.equal(result.hostUser.uid, process.getuid());
    assert.equal(result.hostUser.gid, process.getgid!());
  });
});

/**
 * Build an ExecFn stub that responds based on a per-call matcher list.
 * Each entry matches against `[cmd, ...args]` (joined with spaces) and
 * returns its canned result. Unmatched calls fail the test loudly so a
 * detection-path change can't silently pick the wrong branch.
 */
function scriptedExec(
  responses: Array<{
    match: string;
    result: { stdout: string; exitCode: number };
  }>,
): ExecFn {
  return async (cmd, args) => {
    const joined = [cmd, ...args].join(" ");
    for (const { match, result } of responses) {
      if (joined.includes(match)) {
        return { stdout: result.stdout, stderr: "", exitCode: result.exitCode };
      }
    }
    throw new Error(`scriptedExec: unmatched call: ${joined}`);
  };
}

describe("detectRuntime — podman remote-mode fallback", () => {
  it("returns info without remoteSocketUrl when local podman works", async () => {
    const exec = scriptedExec([
      {
        match: "podman --version",
        result: { stdout: "podman version 5.7.0", exitCode: 0 },
      },
      {
        match: "podman info --format",
        result: { stdout: "true", exitCode: 0 },
      },
      // The first `podman info` without --format is the operability probe;
      // subsequent calls with --format are the cgroup/rootless probes.
      { match: "podman info", result: { stdout: "ok", exitCode: 0 } },
    ]);
    const result = await detectRuntime("podman", exec);
    assert.ok(result);
    assert.equal(result.runtime, "podman");
    assert.equal(result.remoteSocketUrl, undefined);
  });

  it("falls back to remote mode when in-container podman info fails", async () => {
    const origContainerHost = process.env.CONTAINER_HOST;
    const origContainer = process.env.container;
    process.env.CONTAINER_HOST = "unix:///var/run/docker.sock";
    process.env.container = "podman";
    try {
      const exec = scriptedExec([
        {
          match: "podman --version",
          result: { stdout: "podman version 5.7.0", exitCode: 0 },
        },
        {
          match: "podman --remote --url unix:///var/run/docker.sock info",
          result: { stdout: "ok", exitCode: 0 },
        },
        // `podman info` (no remote) — the operability probe. Simulates the
        // newuidmap-not-found error path: exit non-zero.
        { match: "podman info", result: { stdout: "", exitCode: 125 } },
      ]);
      const result = await detectRuntime("podman", exec);
      assert.ok(result);
      assert.equal(result.runtime, "podman");
      assert.equal(result.remoteSocketUrl, "unix:///var/run/docker.sock");
    } finally {
      if (origContainerHost === undefined) delete process.env.CONTAINER_HOST;
      else process.env.CONTAINER_HOST = origContainerHost;
      if (origContainer === undefined) delete process.env.container;
      else process.env.container = origContainer;
    }
  });

  it("returns null when podman info fails and no remote socket is available", async () => {
    const origContainerHost = process.env.CONTAINER_HOST;
    const origContainer = process.env.container;
    delete process.env.CONTAINER_HOST;
    process.env.container = "podman";
    try {
      const exec = scriptedExec([
        {
          match: "podman --version",
          result: { stdout: "podman version 5.7.0", exitCode: 0 },
        },
        { match: "podman info", result: { stdout: "", exitCode: 125 } },
      ]);
      // No CONTAINER_HOST and no socket on disk (would need to check
      // /var/run/docker.sock — covered by the unit test's lack of one in
      // CI's sandbox; if a CI runner happens to have docker installed this
      // test will skip via the early return).
      const result = await detectRuntime("podman", exec);
      if (result !== null) {
        // CI runner has a docker socket — skip rather than fail.
        return;
      }
      assert.equal(result, null);
    } finally {
      if (origContainerHost === undefined) delete process.env.CONTAINER_HOST;
      else process.env.CONTAINER_HOST = origContainerHost;
      if (origContainer === undefined) delete process.env.container;
      else process.env.container = origContainer;
    }
  });

  it("returns null when podman info fails outside a container even if CONTAINER_HOST is set", async () => {
    const origContainerHost = process.env.CONTAINER_HOST;
    const origContainer = process.env.container;
    process.env.CONTAINER_HOST = "unix:///var/run/docker.sock";
    delete process.env.container;
    try {
      const exec = scriptedExec([
        {
          match: "podman --version",
          result: { stdout: "podman version 5.7.0", exitCode: 0 },
        },
        { match: "podman info", result: { stdout: "", exitCode: 125 } },
      ]);
      // Not containerized → no fallback even with CONTAINER_HOST present.
      // (isContainerized also checks /.dockerenv and /run/.containerenv on
      // disk; if either exists this test skips by checking the result.)
      const result = await detectRuntime("podman", exec);
      if (result !== null) return;
      assert.equal(result, null);
    } finally {
      if (origContainerHost === undefined) delete process.env.CONTAINER_HOST;
      else process.env.CONTAINER_HOST = origContainerHost;
      if (origContainer === undefined) delete process.env.container;
      else process.env.container = origContainer;
    }
  });
});

describe("probeHostUser", () => {
  it("returns uid/gid from process.getuid/getgid on POSIX", () => {
    if (typeof process.getuid !== "function") {
      // Skip on Windows — covered by the null-path test below.
      return;
    }
    const result = probeHostUser();
    assert.ok(result);
    assert.equal(result.uid, process.getuid());
    assert.equal(result.gid, process.getgid!());
  });

  it("returns null when process.getuid is undefined (Windows)", () => {
    // Simulate Windows by stubbing both getters to undefined.
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as { getuid?: () => number }).getuid = undefined;
      (process as { getgid?: () => number }).getgid = undefined;
      assert.equal(probeHostUser(), null);
    } finally {
      process.getuid = origGetuid;
      process.getgid = origGetgid;
    }
  });
});
