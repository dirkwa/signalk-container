import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDashboardDeploymentError } from "../doctor.js";
import type { SelfDeploymentStatus } from "../types.js";

/**
 * Decides whether a doctor status reached after successful runtime
 * detection should still light up a dashboard error. The two
 * degraded-but-running statuses escalate; everything else does not —
 * `no-runtime`/`socket-unreachable`/`permission-denied` are surfaced on
 * the detection-failed path and `ok` is the healthy case.
 */
describe("isDashboardDeploymentError", () => {
  it("escalates cgroup-controllers-incomplete (memory limits silently dropped)", () => {
    assert.equal(
      isDashboardDeploymentError("cgroup-controllers-incomplete"),
      true,
    );
  });

  it("escalates self-id-unresolved (sibling-container mounts/network fail)", () => {
    assert.equal(isDashboardDeploymentError("self-id-unresolved"), true);
  });

  it("does not escalate ok", () => {
    assert.equal(isDashboardDeploymentError("ok"), false);
  });

  it("does not escalate the detection-failed statuses (already surfaced elsewhere)", () => {
    const detectionFailed: SelfDeploymentStatus[] = [
      "no-runtime",
      "socket-unreachable",
      "permission-denied",
    ];
    for (const status of detectionFailed) {
      assert.equal(isDashboardDeploymentError(status), false, status);
    }
  });
});
