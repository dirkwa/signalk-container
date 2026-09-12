import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextDetectRetryDelay } from "../index.js";

/**
 * The re-probe ladder that carries a host from "Signal K started before the
 * runtime socket existed" to a working runtime without an operator restart.
 * Doubling keeps the early attempts close together (a socket-activated
 * rootless podman socket usually appears within seconds of boot) while the
 * ceiling keeps the steady state cheap.
 */
describe("nextDetectRetryDelay", () => {
  it("doubles until it reaches the ceiling", () => {
    assert.equal(nextDetectRetryDelay(5_000), 10_000);
    assert.equal(nextDetectRetryDelay(10_000), 20_000);
    assert.equal(nextDetectRetryDelay(20_000), 40_000);
    assert.equal(nextDetectRetryDelay(40_000), 60_000);
  });

  it("holds at the ceiling rather than giving up", () => {
    // A host that gains a runtime long after boot still heals on its own;
    // the poll is a stat plus one version() call, so a steady minute costs
    // nothing.
    assert.equal(nextDetectRetryDelay(60_000), 60_000);
    assert.equal(nextDetectRetryDelay(600_000), 60_000);
  });
});
