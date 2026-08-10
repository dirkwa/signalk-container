import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selfDeployment } from "../../doctor.js";
import { detectRuntime } from "../../runtime.js";
import { compareVersions } from "../../updates/semver.js";
import type { ContainerRuntimeInfo } from "../../types.js";

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

// Mirrors PODMAN_MIN_NOFILE_HONORED in doctor.ts. Duplicated rather than
// exported: this test is the independent check that the doctor's verdict
// matches the host's real version, so deriving both from one constant
// would make the assertion circular.
const PODMAN_NOFILE_FIXED = "5.5.0";

const NOFILE_ADVICE_MARKER = "older than 5.5";
const EPIPE_ADVICE_MARKER = "older than 4.5";

const hasMarker = (lines: string[], marker: string): boolean =>
  lines.some((l) => l.includes(marker));

// End-to-end check of the rootless-Podman nofile advisory against the
// REAL host runtime: the unit tests drive `selfDeployment` with a mocked
// `version()`/`info()`, so only this suite proves the advisory fires (or
// stays silent) based on what the actual daemon reports over the socket.
//
// Deliberately asserts the DECISION, not a fixed outcome — the suite has
// to pass on a 5.4 dev box and a 5.5+ CI host alike, so it recomputes the
// expected verdict from the live version and compares.
describe("doctor — rootless Podman nofile advisory (live runtime)", () => {
  it("fires exactly when the live daemon is rootless podman < 5.5", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const result = await selfDeployment("auto");

    // The doctor and the runtime probe must agree about what they are
    // talking to; a mismatch would make the rest of the assertions
    // meaningless rather than failing for the right reason.
    assert.equal(
      result.binary.name,
      runtime.runtime,
      "doctor and detectRuntime must classify the same daemon",
    );

    const isOldRootlessPodman =
      runtime.runtime === "podman" &&
      result.daemon.rootless === true &&
      compareVersions(runtime.version, PODMAN_NOFILE_FIXED) < 0;

    assert.equal(
      hasMarker(result.remediation, NOFILE_ADVICE_MARKER),
      isOldRootlessPodman,
      `nofile advisory presence must match live runtime ${runtime.runtime} ` +
        `${runtime.version} rootless=${String(result.daemon.rootless)}`,
    );
  });

  it("never escalates status for a version-only finding", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const result = await selfDeployment("auto");
    const versionOnly =
      result.remediation.length > 0 &&
      result.remediation.every(
        (l) =>
          l.includes(NOFILE_ADVICE_MARKER) ||
          l.includes(EPIPE_ADVICE_MARKER) ||
          // Continuation lines of the two version advisories.
          l.includes("Containers inherit") ||
          l.includes("Impact:") ||
          l.includes("Upgrade Podman") ||
          l.includes("Workaround without upgrading"),
      );

    if (!versionOnly) {
      t.skip("host carries non-version remediation; status not attributable");
      return;
    }

    // The whole point of the warn-only design: an old-but-working host
    // stays green. If this ever flips, consumer plugins on Debian Trixie
    // (podman 5.4.x) would start reporting a degraded deployment.
    assert.equal(
      result.status,
      "ok",
      "a version advisory alone must never degrade deployment status",
    );
  });
});
