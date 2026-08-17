import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLiveResources } from "../../containers.js";
import { detectRuntime } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

/**
 * End-to-end check of the CPU priority tiers against a real runtime. Each
 * container reads its own cgroup v2 `cpu.weight` from inside — that is the
 * value the kernel schedules by, so it proves the tier was applied, not
 * just accepted. Skipped when the runtime is missing, and the weight
 * assertions are skipped when the host is not on cgroup v2 with the `cpu`
 * controller delegated (the file is then absent or unreadable).
 *
 * The shares → weight translation belongs to the OCI runtime and differs:
 * crun and runc < 1.3.2 use a linear formula, runc >= 1.3.2 a quadratic
 * one (measured: 128 shares → 5 on crun 1.21, 21 on runc 1.4.3). A weight
 * is accepted when it matches either; both preserve the tier order.
 */

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const IMAGE = "docker.io/library/alpine";
const TAG = "3.19";
const JOB_IMAGE = `${IMAGE}:${TAG}`;
const CONTAINER_NAME = "cpu-tier-test";
const READ_WEIGHT = "cat /sys/fs/cgroup/cpu.weight";
// Print the weight once, then wait, exiting promptly on SIGTERM.
const REPORT_WEIGHT_AND_WAIT = [
  "sh",
  "-c",
  `${READ_WEIGHT}; trap exit TERM; sleep 60 & wait`,
];

function weightFromLines(lines: string[]): number | null {
  const n = Number(lines.find((l) => l.trim() !== "")?.trim());
  return Number.isFinite(n) ? n : null;
}

/** crun / runc < 1.3.2 */
function linearWeight(shares: number): number {
  return 1 + Math.floor(((shares - 2) * 9999) / 262142);
}

/** runc >= 1.3.2 (CHANGELOG 1.3.2, "improved to better fit default v1 and v2 values") */
function quadraticWeight(shares: number): number {
  const l = Math.log2(shares);
  return Math.ceil(10 ** ((l * l + 125 * l) / 612 - 7 / 34));
}

function assertWeightForShares(
  actual: number | null,
  shares: number,
  what: string,
) {
  const expected = [linearWeight(shares), quadraticWeight(shares)];
  assert.ok(
    actual !== null && expected.includes(actual),
    `${what}: cpu.weight ${actual} is neither ${expected[0]} (linear) nor ${expected[1]} (quadratic) for ${shares} shares`,
  );
}

async function bootPlugin(
  config: Partial<PluginConfig>,
  errors: string[] = [],
): Promise<{
  api: ContainerManagerApi;
  runtime: ContainerRuntimeInfo;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-cpu-tier-test-"));
  const noop = () => {};
  const app = {
    debug: noop,
    error: (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
    setPluginStatus: noop,
    setPluginError: noop,
    getDataDirPath: () => dataDir,
    config: { configPath: dataDir },
  };
  const plugin = containerManagerPlugin(app);
  await plugin.start({
    disableUserNamespaceRemap: true,
    ...config,
  } as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  const runtime = api.getRuntime();
  if (!runtime) throw new Error("plugin did not detect a runtime");
  return {
    api,
    runtime,
    stop: async () => {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("CPU priority tiers — real runtime", () => {
  let api: ContainerManagerApi;
  let runtime: ContainerRuntimeInfo;
  let stopPlugin: () => Promise<void>;
  let cpuDelegated = true;

  before(async () => {
    if (!(await hasContainerRuntime())) return;
    const booted = await bootPlugin({
      containerCpuPriority: "low",
      jobCpuPriority: "lowest",
    });
    api = booted.api;
    runtime = booted.runtime;
    stopPlugin = booted.stop;
    cpuDelegated =
      !runtime.cgroupControllers || runtime.cgroupControllers.includes("cpu");
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

  it("runs jobs at the job tier unless the caller sets cpuShares", async (t) => {
    if (!api) {
      t.skip("no container runtime available");
      return;
    }
    if (!cpuDelegated) {
      t.skip("cpu cgroup controller not delegated");
      return;
    }
    const tierLines: string[] = [];
    const tierJob = await api.runJob({
      image: JOB_IMAGE,
      command: ["sh", "-c", READ_WEIGHT],
      onStdoutLine: (line) => tierLines.push(line),
    });
    assert.equal(tierJob.status, "completed", tierJob.error);
    const tierWeight = weightFromLines(tierLines);
    if (tierWeight === null) {
      t.skip("container cannot read its cgroup v2 cpu.weight");
      return;
    }
    // lowest = 128 shares (weight 5 on crun, 21 on runc >= 1.3.2)
    assertWeightForShares(tierWeight, 128, "job at tier lowest");

    const ownLines: string[] = [];
    const ownJob = await api.runJob({
      image: JOB_IMAGE,
      command: ["sh", "-c", READ_WEIGHT],
      resources: { cpuShares: 5120 },
      onStdoutLine: (line) => ownLines.push(line),
    });
    assert.equal(ownJob.status, "completed", ownJob.error);
    // The caller's own 5120 shares win over the tier and outrank unset (100).
    const ownWeight = weightFromLines(ownLines);
    assertWeightForShares(ownWeight, 5120, "job with own cpuShares");
    assert.ok(ownWeight! > 100 && tierWeight < 100);
  });

  it("applies the container tier and live-updates when overridden", async (t) => {
    if (!api) {
      t.skip("no container runtime available");
      return;
    }
    if (!cpuDelegated) {
      t.skip("cpu cgroup controller not delegated");
      return;
    }
    try {
      await api.remove(CONTAINER_NAME);
    } catch {
      // OK if it didn't exist.
    }

    await api.ensureRunning(CONTAINER_NAME, {
      image: IMAGE,
      tag: TAG,
      command: REPORT_WEIGHT_AND_WAIT,
      restart: "no",
    });
    // The tier is part of the effective request...
    assert.equal(api.getResources(CONTAINER_NAME).cpuShares, 512);
    // ...and of what the runtime reports back.
    const live = await getLiveResources(runtime, CONTAINER_NAME);
    assert.equal(live.cpuShares, 512);
    // ...and the kernel scheduled it: low = 512 shares (20 on crun, 59 on
    // runc >= 1.3.2). The container prints the weight on start; give the
    // log a moment to land.
    let logs: string[] = [];
    let weight: number | null = null;
    for (let i = 0; i < 20 && weight === null; i++) {
      logs = await api.getLogs(CONTAINER_NAME, { tail: 5 });
      weight = weightFromLines(logs);
      if (weight === null) await new Promise((r) => setTimeout(r, 250));
    }
    assertWeightForShares(
      weight,
      512,
      `container at tier low (logs: ${JSON.stringify(logs)})`,
    );
    assert.ok(weight! < 100);

    // A per-container override to another tier applies live.
    const result = await api.updateResources(CONTAINER_NAME, {
      cpuShares: 5120,
    });
    assert.equal(result.method, "live");
    const updated = await getLiveResources(runtime, CONTAINER_NAME);
    assert.equal(updated.cpuShares, 5120);
    assert.equal(api.getResources(CONTAINER_NAME).cpuShares, 5120);

    // Back to normal (no request) cannot be done in place — the runtime
    // ignores `--cpu-shares 0` — so it must recreate, and the fresh
    // container must come up at the unset weight even though the
    // create-time provenance label never carried cpuShares.
    const revert = await api.updateResources(CONTAINER_NAME, {
      cpuShares: null,
    });
    assert.equal(revert.method, "recreated");
    const reverted = await getLiveResources(runtime, CONTAINER_NAME);
    assert.equal(reverted.cpuShares, undefined);
    let revertedWeight: number | null = null;
    let revertedLogs: string[] = [];
    for (let i = 0; i < 20 && revertedWeight === null; i++) {
      revertedLogs = await api.getLogs(CONTAINER_NAME, { tail: 5 });
      revertedWeight = weightFromLines(revertedLogs);
      if (revertedWeight === null) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(
      revertedWeight,
      100,
      `logs after revert: ${JSON.stringify(revertedLogs)}`,
    );
  });

  it("tier lowered via config then raised back: warns, and the panel path recreates", async (t) => {
    if (!api) {
      t.skip("no container runtime available");
      return;
    }
    if (!cpuDelegated) {
      t.skip("cpu cgroup controller not delegated");
      return;
    }
    // Container created at normal (label carries no cpuShares), then the
    // plugin is restarted with the tier at low: the next ensureRunning
    // live-applies 512.
    await stopPlugin();
    const first = await bootPlugin({ containerCpuPriority: "normal" });
    api = first.api;
    stopPlugin = first.stop;
    try {
      await api.remove(CONTAINER_NAME);
    } catch {
      // OK if it didn't exist.
    }
    const cfg = {
      image: IMAGE,
      tag: TAG,
      command: REPORT_WEIGHT_AND_WAIT,
      restart: "no" as const,
    };
    await api.ensureRunning(CONTAINER_NAME, cfg);
    assert.equal(
      (await getLiveResources(runtime, CONTAINER_NAME)).cpuShares,
      undefined,
    );
    await stopPlugin();
    const second = await bootPlugin({ containerCpuPriority: "low" });
    api = second.api;
    stopPlugin = second.stop;
    await api.ensureRunning(CONTAINER_NAME, cfg);
    assert.equal(
      (await getLiveResources(runtime, CONTAINER_NAME)).cpuShares,
      512,
    );

    // Back to normal via config: the restart cannot un-set shares in
    // place and must say so instead of reporting a live update that
    // changed nothing.
    await stopPlugin();
    const errors: string[] = [];
    const third = await bootPlugin({ containerCpuPriority: "normal" }, errors);
    api = third.api;
    stopPlugin = third.stop;
    await api.ensureRunning(CONTAINER_NAME, cfg);
    assert.equal(
      (await getLiveResources(runtime, CONTAINER_NAME)).cpuShares,
      512,
      "shares cannot be live-unset; the container keeps them",
    );
    assert.ok(
      errors.some((e) => /cannot live-unset fields cpuShares/.test(e)),
      `expected a cannot-live-unset warning, got: ${JSON.stringify(errors)}`,
    );
    // ...and the documented remedy — Normal in the panel — recreates.
    const revert = await api.updateResources(CONTAINER_NAME, {
      cpuShares: null,
    });
    assert.equal(revert.method, "recreated");
    assert.equal(
      (await getLiveResources(runtime, CONTAINER_NAME)).cpuShares,
      undefined,
    );
  });
});
