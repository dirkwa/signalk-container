import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { doctorSurfacing } from "../doctor.js";

// The startup path's surfacing decision. The live-runtime integration
// test only exercises the advisory branch on a host that HAS an advisory
// (old rootless podman), so on a 5.5+ or Docker CI runner it skips —
// these cases are what keep the branch covered everywhere.
describe("doctorSurfacing", () => {
  it("degraded status → error, regardless of remediation count", () => {
    assert.equal(doctorSurfacing("cgroup-controllers-incomplete", 0), "error");
    assert.equal(doctorSurfacing("cgroup-controllers-incomplete", 3), "error");
    assert.equal(doctorSurfacing("self-id-unresolved", 2), "error");
  });

  it("healthy status with remediation → advisory, never error", () => {
    // The regression this guards: remediation on an `ok` status used to
    // be computed and then silently dropped.
    assert.equal(doctorSurfacing("ok", 5), "advisory");
    assert.equal(doctorSurfacing("ok", 1), "advisory");
  });

  it("healthy status with no remediation → none", () => {
    assert.equal(doctorSurfacing("ok", 0), "none");
  });

  it("advisory never applies to a status that warrants a dashboard error", () => {
    // Guards the ordering: a degraded host with advice must still set a
    // plugin error rather than degrading to the log-only path.
    for (const status of [
      "cgroup-controllers-incomplete",
      "self-id-unresolved",
    ] as const) {
      assert.notEqual(doctorSurfacing(status, 4), "advisory");
    }
  });
});
