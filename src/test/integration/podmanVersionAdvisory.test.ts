import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfDeployment } from "../../doctor.js";
import { detectRuntime } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

// Mirrors PODMAN_MIN_NOFILE_HONORED in doctor.ts. Duplicated rather than
// exported: this test is the independent check that the doctor's verdict
// matches the host's real version, so deriving both from one constant
// would make the assertion circular.
const PODMAN_NOFILE_FIXED = { major: 5, minor: 5 };

/**
 * Compare the live version against the floor on major.minor only —
 * the same policy the doctor applies. A semver comparison would rank a
 * prerelease build ("5.5.0-dev") BELOW 5.5.0 and expect an advisory,
 * while the doctor reads its leading major.minor as 5.5 and emits none;
 * such a host would then fail this test despite correct behaviour.
 */
function isBelowNofileFloor(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return (
    major < PODMAN_NOFILE_FIXED.major ||
    (major === PODMAN_NOFILE_FIXED.major && minor < PODMAN_NOFILE_FIXED.minor)
  );
}

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
      isBelowNofileFloor(runtime.version);

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

/**
 * Boot the real plugin against the live runtime with an `app` that
 * records what reached the operator, so the startup path's surfacing
 * decision can be asserted rather than inferred from `selfDeployment`.
 */
async function bootRecordingPlugin(): Promise<{
  errors: string[];
  pluginErrors: string[];
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-version-advisory-test-"));
  const errors: string[] = [];
  const pluginErrors: string[] = [];
  const noop = () => {};
  const app = {
    debug: noop,
    error: (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
    setPluginStatus: noop,
    setPluginError: (...args: unknown[]) => {
      pluginErrors.push(args.map(String).join(" "));
    },
    getDataDirPath: () => dataDir,
    config: { configPath: dataDir },
  };
  const plugin = containerManagerPlugin(app);
  await plugin.start({ disableUserNamespaceRemap: true } as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  return {
    errors,
    pluginErrors,
    stop: async () => {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// The startup path decides how a doctor finding reaches the operator.
// `selfDeployment` returning advice proves nothing on its own — before
// this branch existed, remediation on a healthy host was computed and
// then silently dropped.
describe("plugin startup — advisory surfacing (live runtime)", () => {
  it("logs advisory remediation without flagging the plugin as errored", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const doctor = await selfDeployment("auto");
    if (doctor.status !== "ok" || doctor.remediation.length === 0) {
      t.skip(
        `host carries no advisory on a healthy status (status=${doctor.status}, ` +
          `remediation=${String(doctor.remediation.length)})`,
      );
      return;
    }

    const booted = await bootRecordingPlugin();
    try {
      const advisoryLogged = booted.errors.some((m) =>
        m.includes("deployment doctor — advisory"),
      );
      assert.ok(
        advisoryLogged,
        `advisory remediation must reach the log; saw: ${JSON.stringify(booted.errors)}`,
      );

      // Warn-only contract: the operator learns about the finding, but
      // the dashboard stays green.
      assert.deepEqual(
        booted.pluginErrors,
        [],
        "a healthy host must not be flagged via setPluginError",
      );
    } finally {
      await booted.stop();
    }
  });
});
