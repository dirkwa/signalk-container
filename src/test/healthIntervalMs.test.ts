import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { healthIntervalMs } from "../containers.js";

/**
 * Inspect returns a healthcheck interval in two shapes, and only reading one
 * of them is how the deferred probe was mistimed in the field: podman's own
 * formatter renders `"30s"`, where `Number("30s")` is `NaN`.
 */
const THIRTY_SECONDS_NS = 30_000_000_000;

describe("healthIntervalMs", () => {
  it("reads the nanosecond integer the compat API returns", () => {
    assert.equal(healthIntervalMs(THIRTY_SECONDS_NS), 30_000);
  });

  it("reads the same value arriving as a numeric string", () => {
    assert.equal(healthIntervalMs(String(THIRTY_SECONDS_NS)), 30_000);
  });

  it("reads the Go duration string podman renders", () => {
    // The shape observed on Venus OS, which the original code read as NaN.
    assert.equal(healthIntervalMs("30s"), 30_000);
  });

  it("sums a compound duration", () => {
    // Go renders these unprefixed, so reading only the first part would
    // understate the interval and probe too early.
    assert.equal(healthIntervalMs("1m30s"), 90_000);
  });

  it("treats a bare digit string as nanoseconds, not seconds", () => {
    // Consistent with the numeric form: the compat API's unit is ns, so "30"
    // is 30ns rather than 30s. Reading it as seconds would defer the probe by
    // a billion times too long.
    assert.equal(healthIntervalMs("30"), 30 / 1_000_000);
  });

  it("handles each unit it can be given", () => {
    assert.equal(healthIntervalMs("500ms"), 500);
    assert.equal(healthIntervalMs("2m"), 120_000);
    assert.equal(healthIntervalMs("1h"), 3_600_000);
  });

  it("returns null rather than a wrong number when unreadable", () => {
    // The caller substitutes podman's default; a bogus number would mistime
    // the probe silently, which is the failure this replaces.
    for (const v of ["", "abc", "s", "30x", null, undefined, 0, -1, {}, []]) {
      assert.equal(healthIntervalMs(v), null, `for ${JSON.stringify(v)}`);
    }
  });
});
