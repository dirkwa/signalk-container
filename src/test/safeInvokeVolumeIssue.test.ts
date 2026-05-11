import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeInvokeVolumeIssue } from "../containers";
import type { VolumeIssue } from "../types";

const baseEvent: VolumeIssue = {
  containerPath: "/usb",
  source: "/media/USB",
  action: "skipped",
  reason: "test",
};

function captureErrors() {
  const errors: unknown[] = [];
  return {
    errors,
    report: (err: unknown) => errors.push(err),
  };
}

describe("safeInvokeVolumeIssue — no handler", () => {
  it("returns without crashing when handler is undefined", () => {
    const { errors, report } = captureErrors();
    safeInvokeVolumeIssue(undefined, baseEvent, report);
    assert.equal(errors.length, 0);
  });
});

describe("safeInvokeVolumeIssue — synchronous handler", () => {
  it("invokes the handler once with the event", () => {
    const { errors, report } = captureErrors();
    const received: VolumeIssue[] = [];
    safeInvokeVolumeIssue(
      (e) => {
        received.push(e);
      },
      baseEvent,
      report,
    );
    assert.equal(received.length, 1);
    assert.equal(received[0], baseEvent);
    assert.equal(errors.length, 0);
  });

  it("captures a synchronous throw via reportError, does not propagate", () => {
    const { errors, report } = captureErrors();
    const err = new Error("sync boom");
    safeInvokeVolumeIssue(
      () => {
        throw err;
      },
      baseEvent,
      report,
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0], err);
  });

  it("captures a non-Error synchronous throw (string, undefined, etc.)", () => {
    const { errors, report } = captureErrors();
    safeInvokeVolumeIssue(
      () => {
        // Non-Error throws are legal in JS; reportError gets them verbatim.

        throw "string boom";
      },
      baseEvent,
      report,
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0], "string boom");
  });
});

describe("safeInvokeVolumeIssue — async handler", () => {
  it("invokes an async handler and resolves on success", async () => {
    const { errors, report } = captureErrors();
    let invoked = false;
    safeInvokeVolumeIssue(
      async () => {
        invoked = true;
      },
      baseEvent,
      report,
    );
    // Drain the microtask queue so the .catch() chain settles.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(invoked);
    assert.equal(errors.length, 0);
  });

  it("captures a rejected promise via reportError (the bug that motivated this fix)", async () => {
    const { errors, report } = captureErrors();
    const err = new Error("async boom");
    safeInvokeVolumeIssue(
      async () => {
        throw err;
      },
      baseEvent,
      report,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1, "rejected promise must reach reportError");
    assert.equal(errors[0], err);
  });

  it("does not block ensureRunning on a slow async handler (fire-and-forget)", async () => {
    const { errors, report } = captureErrors();
    let resolveHandler!: () => void;
    safeInvokeVolumeIssue(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
      baseEvent,
      report,
    );
    // safeInvokeVolumeIssue returns synchronously even though the handler
    // is still pending — the wrapper doesn't await it.
    assert.equal(errors.length, 0);
    resolveHandler();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 0);
  });

  it("handler that rejects with a non-Error value still reaches reportError", async () => {
    const { errors, report } = captureErrors();
    safeInvokeVolumeIssue(
      async () => {
        throw "rejected with string";
      },
      baseEvent,
      report,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.equal(errors[0], "rejected with string");
  });
});

describe("safeInvokeVolumeIssue — exotic handlers", () => {
  it("does NOT call the handler when undefined is passed explicitly", () => {
    const { errors, report } = captureErrors();
    safeInvokeVolumeIssue(undefined, baseEvent, report);
    assert.equal(errors.length, 0);
  });

  it("handler that returns a non-Promise non-void value (e.g. a number) still works", () => {
    // The declared signature is void | Promise<void>, but a handler that
    // accidentally returns a number won't crash — Promise.resolve wraps it.
    const { errors, report } = captureErrors();
    safeInvokeVolumeIssue(
      // @ts-expect-error — intentionally violating the declared return type
      () => 42,
      baseEvent,
      report,
    );
    assert.equal(errors.length, 0);
  });
});
