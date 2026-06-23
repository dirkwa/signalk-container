import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detectRuntime } from "../../runtime.js";
import { execInContainer, getContainerState } from "../../containers.js";
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

const CONTAINER_NAME = "remove-managed-data-test";

// Disk-backed scratch root (gitignored `.scratch/`, NOT /tmp which is tmpfs).
const SCRATCH_ROOT = join(process.cwd(), ".scratch", "remove-managed-data-int");

async function bootPlugin(dataDir: string): Promise<{
  api: ContainerManagerApi;
  stop: () => Promise<void>;
}> {
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
  // Default config: keep-id is ON, which is exactly the mapping that
  // produces subuid-owned bind-mount files under rootless Podman — the
  // condition this feature exists to clean up.
  await plugin.start({} as PluginConfig);
  const api = (
    globalThis as { __signalk_containerManager?: ContainerManagerApi }
  ).__signalk_containerManager;
  if (!api) throw new Error("plugin did not expose containerManager API");
  await api.whenReady();
  return {
    api,
    stop: async () => {
      if (plugin.stop) await plugin.stop();
    },
  };
}

describe("removeManagedData() — public API (rootless-Podman subuid trap)", () => {
  let api: ContainerManagerApi;
  let stopPlugin: () => Promise<void>;
  let bootDir: string;

  before(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
  });

  after(async () => {
    if (api) {
      try {
        await api.remove(CONTAINER_NAME);
      } catch {
        // best-effort
      }
      // A failed run can leave subuid-owned files the host user can't
      // delete; wipe the scratch root from inside the same userns first.
      try {
        await api.runJob({
          image: "docker.io/library/alpine:3.19",
          command: ["sh", "-c", "rm -rf /scratch/* /scratch/.[!.]* || true"],
          outputs: { "/scratch": SCRATCH_ROOT },
        });
      } catch {
        // best-effort
      }
    }
    if (stopPlugin) await stopPlugin();
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  it("removes the container and subuid-owned data the host user cannot delete", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    if (runtime.runtime !== "podman" || runtime.isRootless !== true) {
      t.skip("subuid trap only exists under rootless Podman");
      return;
    }

    bootDir = mkdtempSync(join(SCRATCH_ROOT, "boot-"));
    const booted = await bootPlugin(bootDir);
    api = booted.api;
    stopPlugin = booted.stop;

    // A bind-mount data dir owned by the host user, mounted into a container
    // that runs (in-image) as root → writes inside it land owned by a host
    // SUBUID under the default keep-id mapping.
    const dataDir = mkdtempSync(join(SCRATCH_ROOT, "data-"));

    try {
      await api.remove(CONTAINER_NAME);
    } catch {
      // OK if absent.
    }

    await api.ensureRunning(CONTAINER_NAME, {
      image: "docker.io/library/alpine",
      tag: "3.19",
      command: ["sh", "-c", "trap exit TERM; sleep 120 & wait"],
      restart: "no",
      // Image runs as root by default; this is the keep-id:uid=0 case.
      volumes: { "/managed": dataDir },
    });
    assert.equal(await getContainerState(runtime, CONTAINER_NAME), "running");

    // Write data inside the container owned by a NON-root in-container uid.
    // Under keep-id:uid=0,gid=0, in-image uid 0 maps to the host caller, but a
    // non-zero uid maps to a host SUBUID (e.g. 999 → 100998) the host user
    // cannot delete — the exact QuestDB failure mode. chowning the parent dir
    // too makes even host-owned children undeletable from the host.
    const exec = await execInContainer(runtime, CONTAINER_NAME, [
      "sh",
      "-c",
      "mkdir -p /managed/sub && echo hi > /managed/sub/file && chown -R 999:999 /managed/sub",
    ]);
    assert.equal(
      exec.exitCode,
      0,
      `write inside container failed: ${exec.stderr}`,
    );

    // Sanity: the file is now owned by a uid that is NOT the host user, so a
    // plain host-side rm would EACCES (the bug being fixed). We don't assert
    // the EACCES directly (would leave the dir behind); we just confirm the
    // ownership skew so the test is meaningful.
    const ownerUid = statSync(join(dataDir, "sub", "file")).uid;
    assert.notEqual(
      ownerUid,
      process.getuid?.(),
      "expected subuid ownership skew; got host-owned file (keep-id not active?)",
    );

    // The call under test: removes the container AND the subuid-owned data.
    await api.removeManagedData(CONTAINER_NAME, dataDir, {
      ownerPluginId: "signalk-container-test",
    });

    assert.equal(await getContainerState(runtime, CONTAINER_NAME), "missing");
    assert.equal(existsSync(dataDir), false, "data dir should be gone");
  });
});
