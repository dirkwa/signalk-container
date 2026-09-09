import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  healthcheckIsUnscheduled,
  healthIntervalMs,
  UNSCHEDULED_INTERVAL_MARGIN,
} from "../containers.js";

/**
 * The deferred probe must fire *after* the window `healthcheckIsUnscheduled`
 * needs, or it always answers "too early" and no fallback timer is installed.
 *
 * That is not hypothetical: the first version probed inline at container
 * create, ~2s old, and shipped a feature that never engaged. Unit tests
 * passed because each half was correct on its own. These pin the relationship
 * between them.
 */
const PROBE_DELAY_MS = 90_000;

function containerAged(ageMs: number, interval: unknown) {
  return {
    Created: new Date(Date.now() - ageMs).toISOString(),
    Config: { Healthcheck: { Test: ["CMD-SHELL", "x"], Interval: interval } },
    State: { Health: { Status: "starting", Log: [] } },
  };
}

/** The window the predicate requires, as the probe computes it. */
function detectionWindowMs(interval: unknown): number {
  return (healthIntervalMs(interval) ?? 30_000) * UNSCHEDULED_INTERVAL_MARGIN;
}

describe("deferred probe timing", () => {
  it("answers at the first delay for podman's default interval", () => {
    assert.equal(
      healthcheckIsUnscheduled(containerAged(PROBE_DELAY_MS, "30s")),
      true,
    );
  });

  it("does not answer at create time — the original bug", () => {
    // Probing inline gave this, every time, for every interval.
    assert.equal(healthcheckIsUnscheduled(containerAged(2_000, "30s")), false);
  });

  it("needs longer than the first delay for a slower interval", () => {
    // Why the probe re-arms rather than firing once: a fixed delay cannot
    // cover an interval it has not yet inspected.
    // "45s" is excluded here: its window is exactly the probe delay, so
    // `Date.now()` advancing between building the fixture and reading it
    // decides a strict `>`. Measured flaky at ~1 in 200.
    for (const interval of ["1m", "2m"]) {
      assert.equal(
        healthcheckIsUnscheduled(containerAged(PROBE_DELAY_MS, interval)),
        false,
        `${interval} should not be answerable at ${PROBE_DELAY_MS}ms`,
      );
    }
  });

  it("answers once the container reaches its own window", () => {
    for (const interval of ["45s", "1m", "2m"]) {
      const window = detectionWindowMs(interval);
      assert.equal(
        healthcheckIsUnscheduled(containerAged(window + 1_000, interval)),
        true,
        `${interval} should be answerable after ${window}ms`,
      );
    }
  });

  it("computes a window that grows with the declared interval", () => {
    // The re-arm waits this, so a wrong unit here reintroduces the bug in a
    // quieter form.
    assert.equal(detectionWindowMs("30s"), 60_000);
    assert.equal(detectionWindowMs("1m"), 120_000);
    assert.equal(detectionWindowMs("1m30s"), 180_000);
  });

  it("falls back to the default window for an unreadable interval", () => {
    assert.equal(detectionWindowMs("nonsense"), 60_000);
    assert.equal(detectionWindowMs(undefined), 60_000);
  });
});
