import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRunning,
  getLiveContainerConfig,
  removeContainer,
} from "../../containers.js";
import { detectRuntime } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerConfig,
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

/**
 * A recreate replaces a container whose data the new one takes over, so
 * the old one must get SIGTERM and its stop timeout, not SIGKILL. The
 * container here touches a file in its bind mount from a TERM trap: the
 * file exists after the old container is gone only if SIGTERM reached it.
 *
 * What a plain `removeContainer` (`stop` with `t: 0`) leaves differs by
 * runtime, so it is reported, not asserted: podman 5.8.6 kills without
 * SIGTERM and leaves no file, while docker 28.0.4 sends SIGTERM and kills
 * right after, and the trap can still win that race.
 */

// detectRuntime() resolves AND caches the dockerode client singleton, so
// the bare container-function calls below have a live client.
async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const DRIFT_CONTAINER = "graceful-recreate-drift";
const KILL_CONTAINER = "graceful-recreate-kill";
const API_CONTAINER = "graceful-recreate-api";
const MARK_DIR = "/mark";
const MARK_FILE = "terminated";
const MARK_ON_TERM = [
  "sh",
  "-c",
  `trap 'touch ${MARK_DIR}/${MARK_FILE}; exit 0' TERM; sleep 600 & wait`,
];

function configFor(hostDir: string, generation: string): ContainerConfig {
  return {
    image: "docker.io/library/alpine",
    tag: "3.19",
    command: MARK_ON_TERM,
    env: { GENERATION: generation },
    volumes: { [MARK_DIR]: hostDir },
    restart: "no",
  };
}

describe("a recreate stops the old container with SIGTERM", () => {
  let runtime: ContainerRuntimeInfo | null = null;
  const hostDirs: string[] = [];

  function newHostDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "skc-graceful-recreate-"));
    hostDirs.push(dir);
    return dir;
  }

  before(async () => {
    runtime = await hasContainerRuntime();
  });

  after(async () => {
    if (runtime) {
      for (const name of [DRIFT_CONTAINER, KILL_CONTAINER]) {
        try {
          await removeContainer(runtime, name);
        } catch {
          // best-effort cleanup
        }
      }
    }
    for (const dir of hostDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("ensureRunning's drift recreate lets the old container trap TERM", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    const hostDir = newHostDir();
    await removeContainer(runtime, DRIFT_CONTAINER);
    await ensureRunning(
      runtime,
      DRIFT_CONTAINER,
      configFor(hostDir, "1"),
      () => {},
    );

    const debugLines: string[] = [];
    await ensureRunning(
      runtime,
      DRIFT_CONTAINER,
      configFor(hostDir, "2"),
      (m) => debugLines.push(m),
    );

    assert.ok(
      debugLines.some((l) => /config drift detected \([^)]*\benv\b/.test(l)),
      `expected an env drift recreate, got: ${debugLines.join(" | ")}`,
    );
    const live = await getLiveContainerConfig(runtime, DRIFT_CONTAINER);
    assert.equal(live?.env.get("GENERATION"), "2");
    assert.ok(
      existsSync(join(hostDir, MARK_FILE)),
      "the replaced container never received SIGTERM",
    );
  });

  it("reports whether a plain removeContainer let the trap run", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    const hostDir = newHostDir();
    await removeContainer(runtime, KILL_CONTAINER);
    await ensureRunning(
      runtime,
      KILL_CONTAINER,
      configFor(hostDir, "1"),
      () => {},
    );
    await removeContainer(runtime, KILL_CONTAINER);
    t.diagnostic(
      `${runtime.runtime} ${runtime.version}: stop with t: 0 ` +
        (existsSync(join(hostDir, MARK_FILE))
          ? "let the TERM trap run"
          : "killed before the TERM trap ran"),
    );
  });
});

describe("recreate() stops the old container with SIGTERM", () => {
  let api: ContainerManagerApi | undefined;
  let stopPlugin: (() => Promise<void>) | undefined;
  let hostDir: string | undefined;

  before(async () => {
    if (!(await hasContainerRuntime())) return;
    const dataDir = mkdtempSync(join(tmpdir(), "skc-graceful-recreate-api-"));
    const noop = () => {};
    const plugin = containerManagerPlugin({
      debug: noop,
      error: noop,
      setPluginStatus: noop,
      setPluginError: noop,
      getDataDirPath: () => dataDir,
      config: { configPath: dataDir },
    });
    // disableUserNamespaceRemap keeps the test off host idmap support, as
    // recreate.test.ts does; it is not what this test is about.
    await plugin.start({ disableUserNamespaceRemap: true } as PluginConfig);
    api = (globalThis as { __signalk_containerManager?: ContainerManagerApi })
      .__signalk_containerManager;
    if (!api) throw new Error("plugin did not expose containerManager API");
    await api.whenReady();
    stopPlugin = async () => {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    };
    hostDir = mkdtempSync(join(tmpdir(), "skc-graceful-recreate-mark-"));
  });

  after(async () => {
    if (api) {
      try {
        await api.remove(API_CONTAINER);
      } catch {
        // best-effort cleanup
      }
    }
    if (stopPlugin) await stopPlugin();
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  });

  it("lets the old container trap TERM before the new one starts", async (t) => {
    if (!api || !hostDir) {
      t.skip("no container runtime available");
      return;
    }
    try {
      await api.remove(API_CONTAINER);
    } catch {
      // OK if it didn't exist.
    }
    await api.ensureRunning(API_CONTAINER, configFor(hostDir, "1"));
    await api.recreate(API_CONTAINER, configFor(hostDir, "2"));

    assert.equal(await api.getState(API_CONTAINER), "running");
    assert.ok(
      existsSync(join(hostDir, MARK_FILE)),
      "the replaced container never received SIGTERM",
    );
  });
});
