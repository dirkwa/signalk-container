import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLiveResources, prefixedName } from "../../containers.js";
import { getClient } from "../../client.js";
import { detectRuntime } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
  ResourceClamp,
} from "../../types.js";

/**
 * Real-runtime check of the `cpus` clamp (dirkwa/signalk-questdb#147).
 * Docker rejects a container whose CPU cap exceeds the daemon's core count
 * at create and update ("range of CPUs is from 0.01 to N.00, as there are
 * only N CPUs available"); podman accepts it. Either way the plugin must
 * lower the request to what the daemon reports, tell the consumer, and
 * keep the container on that value across reconciles and updateResources.
 *
 * Runs against whichever runtime `detectRuntime` picks — set `DOCKER_HOST`
 * to a Docker socket to exercise the rejecting runtime — and skips when
 * no runtime answers or the daemon does not report a CPU count.
 */

const IMAGE = "docker.io/library/alpine";
const TAG = "3.19";
const CONTAINER_NAME = "cpus-clamp-test";
const TRAP_AND_WAIT = ["sh", "-c", "trap exit TERM; sleep 60 & wait"];

async function bootPlugin(errors: string[]): Promise<{
  api: ContainerManagerApi;
  runtime: ContainerRuntimeInfo;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-cpus-clamp-test-"));
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
  await plugin.start({ disableUserNamespaceRemap: true } as PluginConfig);
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

async function inspectId(): Promise<string | undefined> {
  const info = (await getClient()
    .getContainer(prefixedName(CONTAINER_NAME))
    .inspect()) as { Id?: string };
  return info.Id;
}

describe("cpus clamp — real runtime", () => {
  let api: ContainerManagerApi;
  let runtime: ContainerRuntimeInfo;
  let stopPlugin: () => Promise<void>;
  const errors: string[] = [];

  before(async () => {
    if (process.platform === "win32") return;
    if (!(await detectRuntime("auto"))) return;
    const booted = await bootPlugin(errors);
    api = booted.api;
    runtime = booted.runtime;
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

  it("caps an over-request to the daemon's CPU count and holds it there", async (t) => {
    if (!api) {
      t.skip("no container runtime available");
      return;
    }
    const host = runtime.hostCpus;
    if (!host) {
      t.skip("daemon did not report a CPU count");
      return;
    }
    if (
      runtime.cgroupControllers &&
      !runtime.cgroupControllers.includes("cpu")
    ) {
      t.skip("cpu cgroup controller not delegated");
      return;
    }
    try {
      await api.remove(CONTAINER_NAME);
    } catch {
      // OK if it didn't exist.
    }

    const requested = host + 2;
    const clamps: ResourceClamp[] = [];
    const config = {
      image: IMAGE,
      tag: TAG,
      command: TRAP_AND_WAIT,
      restart: "no" as const,
      resources: { cpus: requested },
    };
    const options = {
      onResourceClamped: (e: ResourceClamp) => {
        clamps.push(e);
      },
    };

    // Without the clamp, Docker refuses this create outright.
    await api.ensureRunning(CONTAINER_NAME, config, options);
    const idBefore = await inspectId();
    assert.ok(idBefore, "container must exist after ensureRunning");

    assert.equal(clamps.length, 1, "exactly one clamp advisory on create");
    assert.equal(clamps[0].resource, "cpus");
    assert.equal(clamps[0].requested, requested);
    assert.equal(clamps[0].granted, host);
    assert.match(clamps[0].reason, /capped/);

    // What we asked the runtime for, and what it reports back, is the
    // capped value.
    assert.equal(api.getResources(CONTAINER_NAME).cpus, host);
    const live = await getLiveResources(runtime, CONTAINER_NAME);
    assert.equal(live.cpus, host, "runtime must run the container at the cap");

    // A second identical ensureRunning must be a no-op: same container,
    // no live-update attempt against a value the daemon cannot grant.
    errors.length = 0;
    await api.ensureRunning(CONTAINER_NAME, config, options);
    assert.equal(await inspectId(), idBefore, "reconcile must not recreate");
    assert.deepEqual(
      errors.filter((e) => /resource update failed|cannot live-unset/.test(e)),
      [],
      "reconcile must not fight the clamp",
    );
    assert.equal((await getLiveResources(runtime, CONTAINER_NAME)).cpus, host);

    // The advisory is fire-and-forget: a handler that never settles must not
    // hold up reconciliation (same contract as onUlimitClamped).
    const started = Date.now();
    await api.ensureRunning(CONTAINER_NAME, config, {
      onResourceClamped: () => new Promise<void>(() => {}),
    });
    assert.ok(
      Date.now() - started < 10_000,
      "a pending onResourceClamped handler must not delay ensureRunning",
    );
    assert.equal(await inspectId(), idBefore, "still the same container");

    // updateResources goes through the same cap: the request is lowered,
    // the caller is told, and the live value stays at the daemon's count.
    const result = await api.updateResources(CONTAINER_NAME, {
      cpus: host + 3,
    });
    assert.ok(
      (result.warnings ?? []).some((w) => /capped to/.test(w)),
      `updateResources must warn about the cap, got ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(
      (await getLiveResources(runtime, CONTAINER_NAME)).cpus,
      host,
      "updateResources must not push the container above the daemon's count",
    );
  });
});
