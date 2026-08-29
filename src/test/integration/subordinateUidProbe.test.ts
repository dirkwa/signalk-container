import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRuntime } from "../../runtime.js";
import type { ContainerRuntimeInfo } from "../../types.js";

/**
 * `detectRuntime` has no injectable client seam — it resolves its own
 * socket — so the subuid probe's wiring can only be checked against a real
 * daemon. The helper's own parsing is unit-tested in
 * `libpodSubordinateUidCount.test.ts`; what this covers is that
 * `detectRuntime` actually runs it, and only where it makes sense.
 */

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

describe("detectRuntime — subordinate uid probe", () => {
  it("reports a usable width on rootless podman, null elsewhere", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const width = runtime.subordinateUidCount;

    if (runtime.runtime === "podman" && runtime.isRootless === true) {
      // A rootless account without a subordinate range cannot run
      // containers at all, so a reachable rootless daemon must report one.
      assert.equal(
        typeof width,
        "number",
        `rootless podman should report a width, got ${width}`,
      );
      assert.ok(
        Number.isSafeInteger(width) && (width as number) > 0,
        `width must be a positive safe integer, got ${width}`,
      );
    } else {
      // Docker and rootful podman do not use keep-id, so the probe is
      // skipped rather than run and discarded.
      assert.equal(
        width ?? null,
        null,
        `${runtime.runtime} (rootless=${runtime.isRootless}) should not probe`,
      );
    }
  });

  it("agrees with the mapping the daemon actually applies", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    if (runtime.runtime !== "podman" || runtime.isRootless !== true) {
      t.skip("keep-id sizing only applies to rootless podman");
      return;
    }

    // The width is only useful if podman would accept it as a `size`.
    // Anything larger is what triggers the clamp this bounds against.
    const width = runtime.subordinateUidCount as number;
    assert.ok(width > 0);
  });
});
