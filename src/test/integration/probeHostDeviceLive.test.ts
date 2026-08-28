import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntime, isContainerized } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

/**
 * Live cover for `ContainerManagerApi.probeHostDevice`.
 *
 * The probe logic itself is dependency-injected and unit-tested against
 * fixtures; what only a real host can establish is whether the injected
 * implementations — real `readdir`/`stat`/`readFile`, and the containerized
 * fallback that spawns a probe container — agree with the filesystem. The
 * assertions below are derived from the host at run time rather than
 * hardcoded, so the test states a relationship ("the group the kernel
 * reports is the group the probe reports") instead of a machine-specific
 * fact.
 */

/** Device class directories worth probing when the host has them. */
const DEVICE_DIRS = ["/dev/snd", "/dev/input", "/dev/dri"];

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

/** The gid the kernel reports for the first real node in `dir`, or null. */
function firstNodeGid(dir: string): number | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isCharacterDevice()) return st.gid;
    } catch {
      // by-path/by-id symlinks and races are expected; keep looking.
    }
  }
  return null;
}

/** Device node names the kernel reports directly under `dir`. */
function kernelNodes(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isCharacterDevice();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Group name for `gid` per /etc/group, or the numeric gid as a string when
 * nothing names it — the same fallback the probe itself applies.
 */
function groupNameFor(gid: number): string {
  try {
    for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
      const [name, , id] = line.split(":");
      if (id !== undefined && Number(id) === gid) return name;
    }
  } catch {
    // No /etc/group is survivable; fall through to the numeric form.
  }
  return String(gid);
}

async function bootPlugin(): Promise<{
  api: ContainerManagerApi;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-probe-live-test-"));
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

describe("probeHostDevice — live host", () => {
  let api: ContainerManagerApi;
  let stopPlugin: () => Promise<void>;

  before(async () => {
    const runtime = await hasContainerRuntime();
    if (!runtime) return;
    const booted = await bootPlugin();
    api = booted.api;
    stopPlugin = booted.stop;
  });

  after(async () => {
    if (stopPlugin) await stopPlugin();
  });

  it("reports the nodes and owning group the kernel reports", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    // The baseline below reads THIS process's /dev and /etc/group. That is
    // the host's view only on bare metal — a containerized manager sees a
    // different filesystem than the one the runtime resolves device paths
    // against, which is the whole reason probeHostDevice has a
    // container-side fallback. Comparing against a baseline we cannot
    // trust would report a false failure, so skip rather than guess.
    if (isContainerized()) {
      t.skip("containerized: this process's /dev is not the host's");
      return;
    }
    const present = DEVICE_DIRS.filter((d) => kernelNodes(d).length > 0);
    if (present.length === 0) {
      t.skip("host has none of the device-class directories");
      return;
    }

    for (const dir of present) {
      const result = await api.probeHostDevice?.(dir);
      assert.ok(result, `no probe result for ${dir}`);
      assert.equal(result.exists, true, `${dir} should exist`);
      assert.deepEqual(
        result.nodes,
        kernelNodes(dir),
        `${dir}: probed nodes differ from the kernel's`,
      );

      // Group resolution is the point of the directory probe, so assert the
      // name itself rather than merely that some group came back — a wrong
      // group would satisfy a non-empty check.
      const gid = firstNodeGid(dir);
      assert.ok(gid !== null, `${dir} has a character device but no gid`);
      assert.ok(
        result.groups.includes(groupNameFor(gid)),
        `${dir}: expected ${groupNameFor(gid)}, got ${JSON.stringify(result.groups)}`,
      );
    }
  });

  it("tolerates a trailing slash on a directory path", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    const dir = DEVICE_DIRS.find((d) => kernelNodes(d).length > 0);
    if (!dir) {
      t.skip("host has none of the device-class directories");
      return;
    }
    const bare = await api.probeHostDevice?.(dir);
    const slashed = await api.probeHostDevice?.(`${dir}/`);
    assert.deepEqual(slashed, bare, "trailing slash changed the result");
  });

  it("resolves a single device node, not just a directory", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    const dir = DEVICE_DIRS.find((d) => kernelNodes(d).length > 0);
    if (!dir) {
      t.skip("host has none of the device-class directories");
      return;
    }
    if (isContainerized()) {
      t.skip("containerized: this process's /dev is not the host's");
      return;
    }
    const node = join(dir, kernelNodes(dir)[0]);
    const result = await api.probeHostDevice?.(node);
    assert.ok(result, `no probe result for ${node}`);
    assert.equal(result.exists, true, `${node} should exist`);
    assert.deepEqual(
      result.nodes,
      [kernelNodes(dir)[0]],
      "a node probe should name just that node",
    );
  });

  it("reports a nonexistent path as absent rather than throwing", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    const result = await api.probeHostDevice?.("/dev/skc-no-such-device");
    // Absent is expressed either as a null result or exists:false; both are
    // "the caller must not attach this", which is the contract that matters.
    assert.ok(
      !result || result.exists === false,
      `expected absence, got ${JSON.stringify(result)}`,
    );
  });
});
