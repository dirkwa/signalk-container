import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * The self-healthcheck scheduler keeps two per-container markers — a setup
 * claim and an in-flight poll marker — and both are keyed by container name.
 * Names are reused across remove+recreate, so an operation from an old
 * lifecycle can complete after a new one has claimed the same key.
 *
 * Each entry therefore stores the generation that created it, and cleanup
 * releases only its own. This models that contract directly: the scheduler
 * lives inside the plugin factory in index.ts and cannot be imported, and the
 * bug is in the ownership arithmetic rather than in any timer behaviour.
 *
 * Three iterations of this guard were wrong before it was scoped this way, so
 * the cases below are the ones each iteration missed.
 */
type Markers = {
  generation: Map<string, number>;
  marker: Map<string, number>;
};

function claim(m: Markers, name: string): number {
  const gen = m.generation.get(name) ?? 0;
  m.marker.set(name, gen);
  return gen;
}

/** Cleanup as the scheduler does it: release only our own claim. */
function release(m: Markers, name: string, token: number): void {
  if (m.marker.get(name) === token) m.marker.delete(name);
}

function teardown(m: Markers, name: string): void {
  m.marker.delete(name);
  m.generation.set(name, (m.generation.get(name) ?? 0) + 1);
}

function fresh(): Markers {
  return { generation: new Map(), marker: new Map() };
}

describe("self-healthcheck marker ownership", () => {
  it("releases its own claim", () => {
    const m = fresh();
    const token = claim(m, "a");
    release(m, "a", token);
    assert.equal(m.marker.has("a"), false);
  });

  it("does not release a claim made by a later lifecycle", () => {
    // The reported bug: an old operation completing after remove+recreate
    // would clear the new lifecycle's marker, letting its next tick run
    // concurrently with the old one still in flight.
    const m = fresh();
    const oldToken = claim(m, "a");
    teardown(m, "a");
    const newToken = claim(m, "a");
    release(m, "a", oldToken);
    assert.equal(
      m.marker.get("a"),
      newToken,
      "stale release cleared the new lifecycle's marker",
    );
  });

  it("keeps containers independent", () => {
    // The previous iteration's bug: a global counter let removing one
    // container invalidate an in-flight operation for another.
    const m = fresh();
    const aToken = claim(m, "a");
    teardown(m, "b");
    assert.equal(
      aToken,
      m.generation.get("a") ?? 0,
      "removing b invalidated a's claim",
    );
  });

  it("invalidates a claim across its own container's teardown", () => {
    const m = fresh();
    const token = claim(m, "a");
    teardown(m, "a");
    assert.notEqual(token, m.generation.get("a") ?? 0);
  });

  it("survives repeated recreate cycles without leaking a marker", () => {
    const m = fresh();
    let stale = claim(m, "a");
    for (let i = 0; i < 5; i += 1) {
      teardown(m, "a");
      const token = claim(m, "a");
      release(m, "a", stale); // old operation lands late
      assert.equal(m.marker.get("a"), token, `cycle ${i}`);
      stale = token;
    }
  });
});
