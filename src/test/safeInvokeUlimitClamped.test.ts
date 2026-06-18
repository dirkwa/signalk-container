import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeInvokeUlimitClamped } from "../containers.js";
import type { UlimitClamp } from "../types.js";

const baseEvent: UlimitClamp = {
  ulimit: "nofile",
  requested: 1048576,
  granted: 524288,
  reason: "test",
};

function captureErrors() {
  const errors: unknown[] = [];
  return {
    errors,
    report: (err: unknown) => errors.push(err),
  };
}

describe("safeInvokeUlimitClamped — no handler", () => {
  it("returns without crashing when handler is undefined", () => {
    const { errors, report } = captureErrors();
    safeInvokeUlimitClamped(undefined, baseEvent, report);
    assert.equal(errors.length, 0);
  });
});

describe("safeInvokeUlimitClamped — synchronous handler", () => {
  it("invokes the handler once with the event", () => {
    const { errors, report } = captureErrors();
    const received: UlimitClamp[] = [];
    safeInvokeUlimitClamped(
      (e) => {
        received.push(e);
      },
      baseEvent,
      report,
    );
    assert.deepEqual(received, [baseEvent]);
    assert.equal(errors.length, 0);
  });

  it("routes a synchronous throw to reportError", () => {
    const { errors, report } = captureErrors();
    safeInvokeUlimitClamped(
      () => {
        throw new Error("boom");
      },
      baseEvent,
      report,
    );
    assert.equal(errors.length, 1);
  });
});

describe("safeInvokeUlimitClamped — async handler", () => {
  it("routes a rejected promise to reportError", async () => {
    const { errors, report } = captureErrors();
    safeInvokeUlimitClamped(
      async () => {
        throw new Error("async boom");
      },
      baseEvent,
      report,
    );
    // Let the microtask queue drain so the .catch fires.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(errors.length, 1);
  });
});
