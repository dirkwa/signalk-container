import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProcLimitsNofile, prefixedName } from "../../containers.js";
import { getClient } from "../../client.js";
import { detectRuntime } from "../../runtime.js";
import { compareVersions } from "../../updates/semver.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
  UlimitClamp,
} from "../../types.js";

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const CONTAINER_NAME = "nofile-probe-test";

// Well under any host's nofile ceiling so the create is never clamped —
// this suite verifies the probe against the real runtime, not the clamp.
const REQUESTED_NOFILE = 4096;

// Rootless podman below this version ignores the compat API's ulimit
// request at container create (containers/podman#25881, fixed by #25908):
// the container inherits the podman service's limits instead. On such
// runtimes only the probe's internal consistency can be asserted, not
// that the requested value was applied.
const PODMAN_API_ULIMITS_FIXED = "5.5.0";

function runtimeHonorsApiUlimits(runtime: ContainerRuntimeInfo): boolean {
  if (runtime.runtime === "docker") return true;
  return compareVersions(runtime.version, PODMAN_API_ULIMITS_FIXED) >= 0;
}

const TRAP_AND_WAIT_CMD = ["sh", "-c", "trap exit TERM; sleep 60 & wait"];

async function bootPlugin(): Promise<{
  api: ContainerManagerApi;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-nofile-probe-test-"));
  const noop = () => {};
  const app = {
    debug: noop,
    error: noop,
    setPluginStatus: noop,
    setPluginError: noop,
    getDataDirPath: () => dataDir,
    config: { configPath: dataDir },
  };
  const plugin = containerManagerPlugin(app);
  // Same rationale as recreate.test.ts: keep the test independent of
  // host-UID idmap support — we're testing the nofile probe, not userns.
  await plugin.start({ disableUserNamespaceRemap: true } as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  return {
    api,
    stop: async () => {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function inspectContainer(): Promise<{
  Id?: string;
  State?: { Pid?: number };
}> {
  return (await getClient()
    .getContainer(prefixedName(CONTAINER_NAME))
    .inspect()) as { Id?: string; State?: { Pid?: number } };
}

// Verifies the nofile probe against the REAL runtime: (1) the probe agrees
// with the kernel's /proc truth for a running container, (2) the runtime
// echoes nofile limits through inspect for a stopped container (the
// "asked" source the regrant bound reads), and (3) a repeated
// ensureRunning with an identical, satisfied config never recreates. On
// runtimes that honor the API ulimit request (docker, podman >= 5.5.0) it
// additionally pins the probed values to the requested ones — the canary
// for containers/podman#25881-style silent drops.
describe("getContainerNofile — live runtime probe", () => {
  let api: ContainerManagerApi;
  let stopPlugin: () => Promise<void>;

  /**
   * Resolved once in `before()` and read by every test. Re-probing per test
   * would let a test proceed on a runtime `before()` never saw, calling
   * through an `api` that was consequently never booted.
   */
  let runtimeInfo: ContainerRuntimeInfo | null = null;
  before(async () => {
    runtimeInfo = await hasContainerRuntime();
    if (!runtimeInfo) return;
    const booted = await bootPlugin();
    api = booted.api;
    stopPlugin = booted.stop;
  });

  after(async () => {
    if (api) {
      try {
        await api.remove(CONTAINER_NAME);
      } catch {
        // best-effort cleanup
      }
    }
    if (stopPlugin) await stopPlugin();
  });

  it("agrees with /proc, echoes when stopped, and never recreates a satisfied container", async (t) => {
    const runtime = runtimeInfo;
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    try {
      await api.remove(CONTAINER_NAME);
    } catch {
      // OK if it didn't exist.
    }

    const clamps: UlimitClamp[] = [];
    const config = {
      image: "docker.io/library/alpine",
      tag: "3.19",
      command: TRAP_AND_WAIT_CMD,
      restart: "no" as const,
      ulimits: { nofile: REQUESTED_NOFILE },
    };
    const options = {
      onUlimitClamped: (e: UlimitClamp) => {
        clamps.push(e);
      },
    };
    await api.ensureRunning(CONTAINER_NAME, config, options);

    // The probe must agree with the kernel's truth, whatever the runtime
    // actually granted.
    const running = await api.getContainerNofile(CONTAINER_NAME);
    const inspectBefore = await inspectContainer();
    const pid = inspectBefore.State?.Pid;
    assert.ok(running, "probe must return limits for a running container");
    assert.ok(typeof pid === "number" && pid > 0, "inspect must expose a pid");
    const procTruth = parseProcLimitsNofile(
      readFileSync(`/proc/${pid}/limits`, "utf8"),
    );
    assert.deepEqual(running, procTruth, "probe must match /proc");

    if (runtimeHonorsApiUlimits(runtime)) {
      assert.deepEqual(
        running,
        { soft: REQUESTED_NOFILE, hard: REQUESTED_NOFILE },
        "runtime must apply the requested ulimit",
      );
      assert.deepEqual(clamps, [], "a request this small must never clamp");
    }

    // A second identical ensureRunning must not recreate: either the
    // request is satisfied (asked == grantable) or the runtime dropped it
    // (asked == effective >= request on any sane host) — in both shapes
    // the regrant has nothing to improve.
    await api.ensureRunning(CONTAINER_NAME, config, options);
    const inspectAfter = await inspectContainer();
    assert.equal(
      inspectAfter.Id,
      inspectBefore.Id,
      "repeated ensureRunning must not recreate",
    );

    // Stopped: no pid to probe, so this exercises the inspect echo — the
    // "asked" source the regrant bound depends on. The echo must agree
    // with what the container ran with.
    await api.stop(CONTAINER_NAME);
    const stopped = await api.getContainerNofile(CONTAINER_NAME);
    assert.deepEqual(
      stopped,
      running,
      "stopped-container echo must report the limits the container ran with",
    );
  });
});
