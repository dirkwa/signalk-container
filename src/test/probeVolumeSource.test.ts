import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeVolumeSource } from "../index.js";

/** Filesystem stub: only the listed paths are visible to this process. */
function fs(visible: string[]) {
  const set = new Set(visible);
  return (p: string) => set.has(p);
}

describe("probeVolumeSource — bare metal", () => {
  // This process's filesystem IS the host's, so both answers are final and
  // `skip` / `abort` keep working exactly as they did before the tri-state.
  it("answers definitively in both directions", () => {
    const exists = fs(["/host/present"]);
    assert.equal(probeVolumeSource("/host/present", false, exists), true);
    assert.equal(probeVolumeSource("/host/absent", false, exists), false);
  });

  it("never returns unknown", () => {
    const exists = fs([]);
    assert.notEqual(probeVolumeSource("/anything", false, exists), "unknown");
  });
});

describe("probeVolumeSource — containerized", () => {
  // The reported bug. The runtime resolves the bind against the host, which
  // this process cannot see, so "not here" proves nothing and must not be
  // reported as absent.
  it("reports a path it cannot see as unknown, not missing", () => {
    const exists = fs([]);
    assert.equal(
      probeVolumeSource("/home/user/.signalk/charts", true, exists),
      "unknown",
    );
  });

  // A path this container has itself mounted is visible here AND backed by a
  // host source, so a positive result is trustworthy.
  it("trusts a positive result from a mounted path", () => {
    const exists = fs(["/data/visible"]);
    assert.equal(probeVolumeSource("/data/visible", true, exists), true);
  });

  it("never returns a bare false", () => {
    // False would mean "proven absent on the host", which this process is not
    // in a position to establish.
    const exists = fs(["/seen"]);
    for (const p of ["/seen", "/unseen"]) {
      assert.notEqual(probeVolumeSource(p, true, exists), false);
    }
  });
});
