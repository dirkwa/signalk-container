import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SelfHealthOwnership } from "../index.js";

/**
 * The self-healthcheck scheduler keeps two markers per container — a setup
 * claim and an in-flight poll marker — both keyed by container name. Names
 * are reused across remove+recreate, so an operation belonging to an old
 * lifecycle can land after a new one has claimed the same key.
 *
 * The invariant: a claim is released only by the operation that made it, and
 * a token taken before a teardown never acts afterwards.
 */
const SETUP = "setup";
const IN_FLIGHT = "inFlight";
const RECREATE_CYCLES = 5;

describe("SelfHealthOwnership", () => {
  it("releases a claim made by the current operation", () => {
    const o = new SelfHealthOwnership();
    const token = o.tokenFor("a");
    o.claim(SETUP, "a", token.generation);
    assert.equal(o.held(SETUP, "a"), true);
    o.release(SETUP, "a", token.generation);
    assert.equal(o.held(SETUP, "a"), false);
  });

  it("ignores a release from a superseded lifecycle", () => {
    // A stale operation landing after remove+recreate must not clear the new
    // lifecycle's marker, which would let its next tick run concurrently.
    const o = new SelfHealthOwnership();
    const stale = o.tokenFor("a");
    o.claim(IN_FLIGHT, "a", stale.generation);
    o.forget("a");
    const fresh = o.tokenFor("a");
    o.claim(IN_FLIGHT, "a", fresh.generation);
    o.release(IN_FLIGHT, "a", stale.generation);
    assert.equal(o.held(IN_FLIGHT, "a"), true, "stale release cleared it");
  });

  it("keeps the two marker kinds independent", () => {
    const o = new SelfHealthOwnership();
    const t = o.tokenFor("a");
    o.claim(SETUP, "a", t.generation);
    o.release(IN_FLIGHT, "a", t.generation);
    assert.equal(o.held(SETUP, "a"), true);
  });

  it("invalidates a token across its own container's teardown", () => {
    const o = new SelfHealthOwnership();
    const token = o.tokenFor("a");
    o.forget("a");
    assert.equal(o.isCurrent("a", token), false);
  });

  it("leaves other containers' tokens valid when one is removed", () => {
    // Removing one container must not cancel an in-flight probe for another,
    // which would silently leave it without its fallback timer.
    const o = new SelfHealthOwnership();
    const a = o.tokenFor("a");
    o.forget("b");
    assert.equal(o.isCurrent("a", a), true);
  });

  it("drops the removed container's markers", () => {
    const o = new SelfHealthOwnership();
    const t = o.tokenFor("a");
    o.claim(SETUP, "a", t.generation);
    o.claim(IN_FLIGHT, "a", t.generation);
    o.forget("a");
    assert.equal(o.held(SETUP, "a"), false);
    assert.equal(o.held(IN_FLIGHT, "a"), false);
  });

  it("invalidates every outstanding token on reset", () => {
    // stop() resets the client, so an interval firing afterwards would throw
    // in getClient() before its .catch() is attached.
    const o = new SelfHealthOwnership();
    const a = o.tokenFor("a");
    const b = o.tokenFor("b");
    o.claim(SETUP, "a", a.generation);
    o.reset();
    assert.equal(o.isCurrent("a", a), false);
    assert.equal(o.isCurrent("b", b), false);
    assert.equal(o.held(SETUP, "a"), false);
  });

  it("survives repeated recreate cycles without stranding a marker", () => {
    const o = new SelfHealthOwnership();
    let stale = o.tokenFor("a");
    for (let i = 0; i < RECREATE_CYCLES; i += 1) {
      o.forget("a");
      const fresh = o.tokenFor("a");
      o.claim(IN_FLIGHT, "a", fresh.generation);
      o.release(IN_FLIGHT, "a", stale.generation);
      assert.equal(o.held(IN_FLIGHT, "a"), true, `cycle ${i}`);
      o.release(IN_FLIGHT, "a", fresh.generation);
      assert.equal(o.held(IN_FLIGHT, "a"), false, `cycle ${i} cleanup`);
      stale = fresh;
    }
  });
});
