import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { healthcheckIsUnscheduled } from "../containers.js";

/**
 * Detection is behavioural because podman offers nothing else: it creates the
 * container, silently skips the systemd timer when there is no user session,
 * and reports no capability flag to ask beforehand.
 *
 * The bias is deliberate. A false negative leaves a stale `starting`; a false
 * positive runs checks against a daemon already running them. Only the second
 * is harmful, so anything ambiguous answers `false`.
 */
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const NOW = new Date().toISOString();
const INTERVAL_30S_NS = 30_000_000_000;

function info(over: Record<string, unknown> = {}) {
  return {
    Created: HOUR_AGO,
    Config: {
      Healthcheck: { Test: ["CMD-SHELL", "true"], Interval: INTERVAL_30S_NS },
    },
    State: { Health: { Status: "starting", Log: [] } },
    ...over,
  };
}

describe("healthcheckIsUnscheduled", () => {
  it("detects a healthcheck that has never run", () => {
    assert.equal(healthcheckIsUnscheduled(info()), true);
  });

  it("is false once the check has produced results", () => {
    assert.equal(
      healthcheckIsUnscheduled(
        info({
          State: { Health: { Status: "starting", Log: [{ ExitCode: 0 }] } },
        }),
      ),
      false,
    );
  });

  it("is false when the daemon already reached a verdict", () => {
    for (const Status of ["healthy", "unhealthy"]) {
      assert.equal(
        healthcheckIsUnscheduled(
          info({ State: { Health: { Status, Log: [] } } }),
        ),
        false,
        `for ${Status}`,
      );
    }
  });

  it("is false when the container declares no healthcheck", () => {
    assert.equal(healthcheckIsUnscheduled(info({ Config: {} })), false);
    assert.equal(
      healthcheckIsUnscheduled(info({ Config: { Healthcheck: { Test: [] } } })),
      false,
    );
  });

  it("treats an explicit NONE as no healthcheck", () => {
    assert.equal(
      healthcheckIsUnscheduled(
        info({ Config: { Healthcheck: { Test: ["NONE"] } } }),
      ),
      false,
    );
  });

  it("waits out the interval before concluding", () => {
    // Seconds old: the timer may simply not have fired yet, and calling that
    // unscheduled would have us polling a healthy daemon's containers.
    assert.equal(healthcheckIsUnscheduled(info({ Created: NOW })), false);
  });

  it("uses podman's default interval when the image declares none", () => {
    // Podman's default is 30s and the margin is 2 intervals, so 60s is the
    // threshold: 5s is comfortably inside it, 120s comfortably past.
    const WITHIN_DEFAULT_WINDOW_MS = 5_000;
    const PAST_DEFAULT_WINDOW_MS = 120_000;
    const justNow = new Date(
      Date.now() - WITHIN_DEFAULT_WINDOW_MS,
    ).toISOString();
    const old = new Date(Date.now() - PAST_DEFAULT_WINDOW_MS).toISOString();
    const noInterval = { Test: ["CMD-SHELL", "true"] };
    assert.equal(
      healthcheckIsUnscheduled(
        info({ Created: justNow, Config: { Healthcheck: noInterval } }),
      ),
      false,
    );
    assert.equal(
      healthcheckIsUnscheduled(
        info({ Created: old, Config: { Healthcheck: noInterval } }),
      ),
      true,
    );
  });

  it("is false on an unreadable payload rather than guessing", () => {
    assert.equal(
      healthcheckIsUnscheduled(info({ Created: "not-a-date" })),
      false,
    );
    assert.equal(healthcheckIsUnscheduled({}), false);
  });
});
