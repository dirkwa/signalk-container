import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { honoursVolumeSubpath, supportsKeepIdSize } from "../runtime.js";

/**
 * The bound is measured, not read from a changelog: podman 5.4.2 accepts a
 * compat-API volume subpath and ignores it, 6.1.0 applies it and echoes it
 * back through inspect. Those two points are what pin this.
 */
describe("honoursVolumeSubpath", () => {
  it("is false for versions measured to ignore the subpath", () => {
    assert.equal(honoursVolumeSubpath("5.4.2"), false);
  });

  it("is true for versions measured to apply it", () => {
    assert.equal(honoursVolumeSubpath("6.1.0"), true);
  });

  it("treats a later major as supporting it", () => {
    assert.equal(honoursVolumeSubpath("7.0.0"), true);
  });

  it("does not credit an earlier minor of the same major", () => {
    assert.equal(honoursVolumeSubpath("6.0.9"), false);
  });

  it("accepts the shapes a daemon actually reports", () => {
    // Both measured daemons report three components, but a two-component
    // version is legal and a prerelease of a supported minor carries the
    // change this gates on.
    assert.equal(honoursVolumeSubpath("6.1"), true);
    assert.equal(honoursVolumeSubpath("6.1.0-rc.1"), true);
  });

  it("accepts a SemVer prerelease or build suffix", () => {
    assert.equal(honoursVolumeSubpath("6.1.0-rc.1"), true);
    assert.equal(honoursVolumeSubpath("6.1.0+build.5"), true);
  });

  it("rejects a malformed suffix rather than reading the prefix", () => {
    // Each of these starts with a supported version, so a loose parser
    // credits the capability on a string the daemon never produced.
    for (const v of ["6.1.0garbage", "6.1.0-", "6.1.0+", "6.1.0.1"]) {
      assert.equal(honoursVolumeSubpath(v), false, `for ${JSON.stringify(v)}`);
    }
  });

  it("holds supportsKeepIdSize to the same parsing", () => {
    // The two helpers share one parser, and this one gates real plugin
    // behaviour rather than a test expectation — a version it misreads
    // emits `keep-id:size=` to a daemon that may reject the whole option.
    assert.equal(supportsKeepIdSize("5.4.2"), true);
    assert.equal(supportsKeepIdSize("5.4.2-rc.1"), true);
    for (const v of ["5.4garbage", "5.4.2garbage", "5.4.2-", "garbage"]) {
      assert.equal(supportsKeepIdSize(v), false, `for ${JSON.stringify(v)}`);
    }
  });

  it("fails closed on an unreadable version", () => {
    // Assuming support we cannot confirm would make the canary demand
    // behaviour the daemon may not have; the older expectation is the safe
    // default, matching supportsKeepIdSize.
    for (const v of [null, "", "garbage", "podman", "6.1garbage", "6"]) {
      assert.equal(honoursVolumeSubpath(v), false, `for ${JSON.stringify(v)}`);
    }
  });
});
