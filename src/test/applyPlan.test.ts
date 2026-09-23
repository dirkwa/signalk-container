import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planUpdateApply } from "../updates/applyPlan.js";
import type { ContainerConfig } from "../types.js";
import type { UpdateCheckResult } from "../updates/types.js";

const cfg = (tag: string): ContainerConfig => ({
  image: "ghcr.io/dirkwa/signalk-backup-server",
  tag,
});

const result = (over: Partial<UpdateCheckResult> = {}): UpdateCheckResult =>
  ({
    pluginId: "signalk-backup",
    containerName: "signalk-backup-server",
    runningTag: "latest",
    tagKind: "floating",
    currentVersion: "1.0.0",
    latestVersion: "1.0.1",
    updateAvailable: true,
    ...over,
  }) as UpdateCheckResult;

describe("planUpdateApply", () => {
  it("names the image and config to recreate on", () => {
    const plan = planUpdateApply("signalk-backup", result(), () =>
      cfg("latest"),
    );

    assert.equal(plan.containerName, "signalk-backup-server");
    assert.equal(plan.imageRef, "ghcr.io/dirkwa/signalk-backup-server:latest");
    assert.equal(plan.version, "1.0.1");
  });

  it("refuses a plugin that never registered", () => {
    assert.throws(
      () => planUpdateApply("nope", null, () => cfg("latest")),
      /No registration for plugin nope/,
    );
  });

  // Recreating restarts the container, so applying nothing is an outage for
  // no reason rather than a harmless no-op.
  it("refuses when the last check found nothing", () => {
    assert.throws(
      () =>
        planUpdateApply(
          "signalk-backup",
          result({ updateAvailable: false }),
          () => cfg("latest"),
        ),
      /No update available/,
    );
  });

  it("refuses a container the process has no config for", () => {
    assert.throws(
      () => planUpdateApply("signalk-backup", result(), () => undefined),
      /restart the plugin that owns it/,
    );
  });

  // Pulling a pinned tag reinstalls the version already running, so reporting
  // the newer one would be a false claim rather than a partial success.
  it("refuses a pinned tag and names the tag to change", () => {
    assert.throws(
      () => planUpdateApply("signalk-backup", result(), () => cfg("1.0.0")),
      /pinned to 1\.0\.0 — set its image tag to 1\.0\.1/,
    );
  });

  // ensureRunning recreates on image@digest regardless of the tag, so a
  // digest-pinned container passes the floating-tag check while never
  // moving — the same false success the semver refusal exists to prevent.
  it("refuses a digest pin even when the tag is floating", () => {
    assert.throws(
      () =>
        planUpdateApply("signalk-backup", result(), () => ({
          ...cfg("latest"),
          digest: `sha256:${"a".repeat(64)}`,
        })),
      /is pinned to sha256:a{64}/,
    );
  });

  it("refuses a bare-major tag, which pins no more than a floating one resolves", () => {
    // classifyTag calls "3" floating; "3.0" is a pin. Guard the boundary.
    assert.doesNotThrow(() =>
      planUpdateApply("signalk-backup", result(), () => cfg("3")),
    );
    assert.throws(
      () => planUpdateApply("signalk-backup", result(), () => cfg("3.0")),
      /pinned to 3\.0/,
    );
  });
});
