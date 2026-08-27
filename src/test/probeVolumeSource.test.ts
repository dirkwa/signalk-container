import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeVolumeSource } from "../index.js";

function visibleTo(paths: string[]) {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

describe("probeVolumeSource — bare metal", () => {
  // This process's filesystem IS the host's, so both answers are final and
  // `skip` / `abort` keep working exactly as they did before the tri-state.
  it("answers definitively in both directions", () => {
    const exists = visibleTo(["/host/present"]);
    assert.equal(probeVolumeSource("/host/present", false, exists), true);
    assert.equal(probeVolumeSource("/host/absent", false, exists), false);
  });

  it("never returns unknown", () => {
    const exists = visibleTo([]);
    assert.notEqual(probeVolumeSource("/anything", false, exists), "unknown");
  });
});

describe("probeVolumeSource — containerized", () => {
  // The reported bug. The runtime resolves the bind against the host, which
  // this process cannot see, so "not here" proves nothing and must not be
  // reported as absent.
  it("reports a path it cannot see as unknown, not missing", () => {
    const exists = visibleTo([]);
    assert.equal(
      probeVolumeSource("/home/user/.signalk/charts", true, exists),
      "unknown",
    );
  });

  // Visibility alone proves nothing: a path can exist in the container's own
  // image layer while the host has nothing there. Verified against a real
  // runtime -- `mkdir /data` inside a container on a host with no /data.
  it("does not trust a visible path that is not a bind mount", () => {
    const exists = visibleTo(["/data/in-image-layer"]);
    assert.equal(
      probeVolumeSource("/data/in-image-layer", true, exists),
      "unknown",
    );
  });

  // A bind mount makes this container's view of the path the host's view, so
  // both answers become trustworthy again.
  it("answers definitively for a path under one of its own bind mounts", () => {
    const exists = visibleTo(["/data/bound"]);
    const bound = (p: string) => p.startsWith("/data/");
    assert.equal(probeVolumeSource("/data/bound", true, exists, bound), true);
    assert.equal(
      probeVolumeSource("/data/gone", true, exists, bound),
      false,
    );
  });

  it("never returns a bare false without a covering mount", () => {
    // False would mean "proven absent on the host", which this process cannot
    // establish without a bind mount to look through.
    const exists = visibleTo(["/seen"]);
    for (const p of ["/seen", "/unseen"]) {
      assert.notEqual(probeVolumeSource(p, true, exists), false);
    }
  });
});
