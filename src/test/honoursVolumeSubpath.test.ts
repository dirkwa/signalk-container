import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { honoursVolumeSubpath } from "../runtime.js";

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

  it("fails closed on an unreadable version", () => {
    // Assuming support we cannot confirm would make the canary demand
    // behaviour the daemon may not have; the older expectation is the safe
    // default, matching supportsKeepIdSize.
    for (const v of [null, "", "garbage", "podman"]) {
      assert.equal(honoursVolumeSubpath(v), false, `for ${JSON.stringify(v)}`);
    }
  });
});
