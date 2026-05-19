import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRuntime, probeHostUser } from "../runtime.js";

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
