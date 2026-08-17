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

async function bootPlugin(config: Partial<PluginConfig>): Promise<{
  api: ContainerManagerApi;
  runtime: ContainerRuntimeInfo;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-cpu-tier-test-"));
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
    // lowest = 128 shares → weight 5
    assert.equal(tierWeight, 5);

    const ownLines: string[] = [];
    const ownJob = await api.runJob({
      image: JOB_IMAGE,
      command: ["sh", "-c", READ_WEIGHT],
      resources: { cpuShares: 5120 },
      onStdoutLine: (line) => ownLines.push(line),
    });
    assert.equal(ownJob.status, "completed", ownJob.error);
    // high = 5120 shares → weight 196; the caller's own value wins.
    assert.equal(weightFromLines(ownLines), 196);
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
    // ...and the kernel scheduled it: low = 512 shares → weight 20. The
    // container prints the weight on start; give the log a moment to land.
    let logs: string[] = [];
    let weight: number | null = null;
    for (let i = 0; i < 20 && weight === null; i++) {
      logs = await api.getLogs(CONTAINER_NAME, { tail: 5 });
      weight = weightFromLines(logs);
      if (weight === null) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(weight, 20, `logs: ${JSON.stringify(logs)}`);

    // A per-container override to another tier applies live.
    const result = await api.updateResources(CONTAINER_NAME, {
      cpuShares: 5120,
    });
    assert.equal(result.method, "live");
    const updated = await getLiveResources(runtime, CONTAINER_NAME);
    assert.equal(updated.cpuShares, 5120);
    assert.equal(api.getResources(CONTAINER_NAME).cpuShares, 5120);
  });
});
