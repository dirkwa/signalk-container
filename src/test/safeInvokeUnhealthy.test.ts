import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeInvokeUnhealthy } from "../containers.js";

function captureErrors() {
  const errors: unknown[] = [];
  return {
    errors,
    report: (err: unknown) => errors.push(err),
  };
}

describe("safeInvokeUnhealthy — no handler", () => {
  it("returns without crashing when handler is undefined", () => {
    const { errors, report } = captureErrors();
    safeInvokeUnhealthy(
      undefined,
      "questdb",
      "Health check returned false",
      report,
    );
    assert.equal(errors.length, 0);
  });
});

describe("safeInvokeUnhealthy — synchronous handler", () => {
  it("invokes the handler once with name and reason", () => {
    const { errors, report } = captureErrors();
    const received: Array<[string, string]> = [];
    safeInvokeUnhealthy(
      (name, reason) => {
        received.push([name, reason]);
      },
      "questdb",
      "boom-reason",
      report,
    );
    assert.deepEqual(received, [["questdb", "boom-reason"]]);
    assert.equal(errors.length, 0);
  });

  it("captures a synchronous throw via reportError, does not propagate", () => {
    const { errors, report } = captureErrors();
    const err = new Error("sync boom");
    // If this threw instead of being captured, the assertion below (and the
    // health-check catch that would re-enter surfaceUnhealthy) would never
    // run — that re-entry double-log is the bug this isolation prevents.
    safeInvokeUnhealthy(
      () => {
        throw err;
      },
      "questdb",
      "reason",
      report,
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0], err);
  });

  it("captures a non-Error synchronous throw", () => {
    const { errors, report } = captureErrors();
    safeInvokeUnhealthy(
      () => {
        throw "string boom";
      },
      "questdb",
      "reason",
      report,
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0], "string boom");
  });
});

describe("safeInvokeUnhealthy — async handler", () => {
  it("invokes an async handler and resolves on success", async () => {
    const { errors, report } = captureErrors();
    let invoked = false;
    safeInvokeUnhealthy(
      async () => {
        invoked = true;
      },
      "questdb",
      "reason",
      report,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(invoked);
    assert.equal(errors.length, 0);
  });

  it("captures a rejected promise via reportError (no unhandled rejection)", async () => {
    const { errors, report } = captureErrors();
    const err = new Error("async boom");
    safeInvokeUnhealthy(
      async () => {
        throw err;
      },
      "questdb",
      "reason",
      report,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1, "rejected promise must reach reportError");
    assert.equal(errors[0], err);
  });

  it("does not block on a slow async handler (fire-and-forget)", async () => {
    const { errors, report } = captureErrors();
    let resolveHandler!: () => void;
    safeInvokeUnhealthy(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
      "questdb",
      "reason",
      report,
    );
    // Returns synchronously even though the handler is still pending.
    assert.equal(errors.length, 0);
    resolveHandler();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 0);
  });
});
