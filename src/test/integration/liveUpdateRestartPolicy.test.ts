import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClient } from "../../client.js";
import { prefixedName } from "../../containers.js";
import { detectRuntime } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerConfig,
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

/**
 * A live resource update must leave a container's restart policy as its
 * config asks. Podman's Docker-compat `/update` handler stores
 * `RestartPolicy.Name` from the body whether or not the body carried one,
 * so a resources-only update turns `unless-stopped` into `no` and the
 * container neither restarts after a crash nor comes back at boot. Docker
 * keeps the stored policy when the field is omitted. `tryLiveUpdate`
 * names the policy on every update, so the guarantee asserted here holds
 * on both runtimes; what the runtime itself does to a body without the
 * field is reported, not asserted — a runtime that preserves the policy
 * makes the field redundant, not wrong.
 */

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const IMAGE = "docker.io/library/alpine";
const TAG = "3.19";
const DEFAULT_POLICY_CONTAINER = "restart-policy-live-default";
const EXPLICIT_POLICY_CONTAINER = "restart-policy-live-explicit";
// Exit promptly on SIGTERM so remove() does not wait out the stop grace.
const WAIT_UNTIL_TERM = ["sh", "-c", "trap exit TERM; sleep 60 & wait"];
const TIER_LOW_SHARES = 512;
const TIER_HIGH_SHARES = 5120;

async function livePolicy(name: string): Promise<string> {
  const info = await getClient().getContainer(prefixedName(name)).inspect();
  const hc = info.HostConfig as { RestartPolicy?: { Name?: string } };
  return hc.RestartPolicy?.Name ?? "";
}

async function bootPlugin(config: Partial<PluginConfig>): Promise<{
  api: ContainerManagerApi;
  runtime: ContainerRuntimeInfo;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-restart-policy-test-"));
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

describe("live resource update — restart policy", () => {
  let api: ContainerManagerApi;
  let runtime: ContainerRuntimeInfo;
  let stopPlugin: () => Promise<void>;
  let cpuDelegated = true;

  before(async () => {
    if (!(await hasContainerRuntime())) return;
    // A tier below normal puts cpuShares in every container's effective
    // request, which is the shape the live-update path fires on.
    const booted = await bootPlugin({ containerCpuPriority: "low" });
    api = booted.api;
    runtime = booted.runtime;
    stopPlugin = booted.stop;
    cpuDelegated =
      !runtime.cgroupControllers || runtime.cgroupControllers.includes("cpu");
  });

  after(async () => {
    if (api) {
      for (const name of [
        DEFAULT_POLICY_CONTAINER,
        EXPLICIT_POLICY_CONTAINER,
      ]) {
        try {
          await api.remove(name);
        } catch {
          // best-effort cleanup
        }
      }
    }
    if (stopPlugin) await stopPlugin();
  });

  function skipUnlessLiveUpdatable(t: {
    skip: (msg: string) => void;
  }): boolean {
    if (!api) {
      t.skip("no container runtime available");
      return true;
    }
    if (!cpuDelegated) {
      // Without the cpu controller cpuShares is filtered out, the update
      // body is empty and no `/update` call is made — nothing to observe.
      t.skip("cpu cgroup controller not delegated");
      return true;
    }
    return false;
  }

  it("keeps the default policy across a live update", async (t) => {
    if (skipUnlessLiveUpdatable(t)) return;
    const config: ContainerConfig = {
      image: IMAGE,
      tag: TAG,
      command: WAIT_UNTIL_TERM,
    };
    await api.ensureRunning(DEFAULT_POLICY_CONTAINER, config);
    assert.equal(await livePolicy(DEFAULT_POLICY_CONTAINER), "unless-stopped");

    // Applied live: a recreate would restore the policy trivially and
    // prove nothing about the update body.
    const result = await api.updateResources(DEFAULT_POLICY_CONTAINER, {
      cpuShares: TIER_HIGH_SHARES,
    });
    assert.equal(result.method, "live", JSON.stringify(result));
    assert.equal(await livePolicy(DEFAULT_POLICY_CONTAINER), "unless-stopped");

    // The premise, reported per runtime.
    await getClient()
      .getContainer(prefixedName(DEFAULT_POLICY_CONTAINER))
      .update({ CpuShares: TIER_LOW_SHARES });
    t.diagnostic(
      `${runtime.runtime} ${runtime.version}: resources-only /update leaves ` +
        `RestartPolicy=${await livePolicy(DEFAULT_POLICY_CONTAINER)}`,
    );

    // Whatever the runtime made of that, the next live update from the
    // plugin puts the configured policy back.
    const healed = await api.updateResources(DEFAULT_POLICY_CONTAINER, {
      cpuShares: TIER_HIGH_SHARES,
    });
    assert.equal(healed.method, "live", JSON.stringify(healed));
    assert.equal(await livePolicy(DEFAULT_POLICY_CONTAINER), "unless-stopped");
  });

  it("keeps an explicit policy across a live update", async (t) => {
    if (skipUnlessLiveUpdatable(t)) return;
    await api.ensureRunning(EXPLICIT_POLICY_CONTAINER, {
      image: IMAGE,
      tag: TAG,
      command: WAIT_UNTIL_TERM,
      restart: "always",
    });
    assert.equal(await livePolicy(EXPLICIT_POLICY_CONTAINER), "always");

    const result = await api.updateResources(EXPLICIT_POLICY_CONTAINER, {
      cpuShares: TIER_HIGH_SHARES,
    });
    assert.equal(result.method, "live", JSON.stringify(result));
    assert.equal(await livePolicy(EXPLICIT_POLICY_CONTAINER), "always");
  });
});
