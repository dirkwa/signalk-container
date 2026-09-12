import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSurfaceDetectStatus } from "../index.js";

/**
 * The runtime boot-race re-probe polls once a minute in its steady state.
 * Two failure modes bracket what this rule has to get right:
 * repeating identical remediation buries the server log, while never
 * repeating leaves the operator reading advice for a problem they no longer
 * have.
 */
describe("shouldSurfaceDetectStatus", () => {
  it("surfaces the first failure of a start", () => {
    assert.equal(shouldSurfaceDetectStatus("no-runtime", null), true);
  });

  it("stays quiet while the reason is unchanged", () => {
    // The common case: a host with no runtime at all, polling every minute.
    assert.equal(shouldSurfaceDetectStatus("no-runtime", "no-runtime"), false);
  });

  it("surfaces again when a retrying host changes reason", () => {
    // The sequence this rule exists for. A machine coming up from boot has
    // nothing answering (no-runtime); once podman.socket exists but its
    // service is still starting, the same host reports socket-unreachable —
    // and the earlier "install a runtime" text is now actively misleading.
    assert.equal(
      shouldSurfaceDetectStatus("socket-unreachable", "no-runtime"),
      true,
    );
  });

  it("surfaces a terminal status reached from a retryable one", () => {
    // A socket that appears and then refuses this uid: the operator needs the
    // group_add remediation, not the one telling them to wait.
    assert.equal(
      shouldSurfaceDetectStatus("permission-denied", "socket-unreachable"),
      true,
    );
  });
});
