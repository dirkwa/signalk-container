import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRunning,
  getContainerStateDetail,
  getLiveContainerConfig,
  removeContainer,
} from "../../containers.js";
import { requestedConfigLabel } from "../../namespace.js";
import { detectRuntime } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../../types.js";

/**
 * End-to-end coverage for requested-config provenance and container state
 * detail against a real runtime.
 *
 * The provenance label has to survive a real create and come back through
 * a real inspect for cold-start unset drift to work at all, and the state
 * detail reads inspect fields whose placement only a real runtime can
 * confirm — neither is establishable against a fixture.
 */

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

const IMAGE = "alpine";
const TAG = "3.19";
const CONTAINER_NAME = "state-detail-test";

/** Exit status the crash case asserts is surfaced verbatim. */
const EXPECTED_EXIT_CODE = 3;
/** Long enough that the container outlives every assertion against it. */
const TRAP_WAIT_SECONDS = 60;
/** 5s total, ample for a container whose command is `exit`. */
const EXIT_POLL_MAX_ATTEMPTS = 50;
const EXIT_POLL_INTERVAL_MS = 100;
/**
 * Distinctive enough that finding it anywhere in the label proves a leak.
 * A short value like "1" could match incidentally and would make the
 * leak assertion pass by luck rather than by construction.
 */
const SECRET_SENTINEL = "s3cr3t-must-not-persist";

// Trap-and-wait so `stop` does not fall back to its 10s SIGKILL.
const TRAP_AND_WAIT_CMD = [
  "sh",
  "-c",
  `trap exit TERM; sleep ${TRAP_WAIT_SECONDS} & wait`,
];

async function bootPlugin(): Promise<{
  api: ContainerManagerApi;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-state-detail-test-"));
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
  // Same rationale as recreate.test.ts: rootless Podman on CI rejects
  // --userns=keep-id, and user-namespace mapping is not what this covers.
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

describe("state detail and config provenance — real runtime", () => {
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

  it("round-trips the provenance label through a real create and inspect", async (t) => {
    const runtime = runtimeInfo;
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: IMAGE,
        tag: TAG,
        command: TRAP_AND_WAIT_CMD,
        env: { SKC_KEEP: SECRET_SENTINEL, SKC_DROPPED: SECRET_SENTINEL },
      },
      () => {},
    );

    const live = await getLiveContainerConfig(runtime, CONTAINER_NAME);
    assert.ok(live, "expected a live config for the created container");
    const raw = live.labels[requestedConfigLabel()];
    assert.ok(raw, "provenance label missing from a real container");

    const parsed = JSON.parse(raw) as {
      envKeys?: string[];
      command?: string[];
    };
    assert.deepEqual(parsed.envKeys, ["SKC_DROPPED", "SKC_KEEP"]);
    assert.deepEqual(parsed.command, TRAP_AND_WAIT_CMD);

    // The security property, verified against a real runtime rather than
    // a mock: the values never reach the label. Both keys carry the same
    // sentinel, so a single check covers them.
    assert.ok(
      !raw.includes(SECRET_SENTINEL),
      `env value leaked into the label: ${raw}`,
    );
  });

  it("recreates on cold-start unset drift with no in-memory prior", async (t) => {
    const runtime = runtimeInfo;
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    // Create with both keys, so this test stands alone under a
    // --test-name-pattern filter rather than inheriting the previous
    // test's container.
    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: IMAGE,
        tag: TAG,
        command: TRAP_AND_WAIT_CMD,
        env: { SKC_KEEP: "1", SKC_DROPPED: "2" },
      },
      () => {},
    );
    assert.equal(
      (await getContainerStateDetail(CONTAINER_NAME)).state,
      "running",
    );

    // Calling the module-level ensureRunning with no `prior` models a
    // fresh server process: only the create-time label can reveal that
    // SKC_DROPPED was ours rather than baked into the image.
    const debugLines: string[] = [];
    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: IMAGE,
        tag: TAG,
        command: TRAP_AND_WAIT_CMD,
        env: { SKC_KEEP: "1" },
      },
      (m) => debugLines.push(m),
    );

    assert.ok(
      debugLines.some((l) => l.includes("config drift detected")),
      `expected drift on the dropped env key, got: ${debugLines.join(" | ")}`,
    );

    const live = await getLiveContainerConfig(runtime, CONTAINER_NAME);
    assert.ok(live);
    assert.equal(
      live.env.has("SKC_DROPPED"),
      false,
      "dropped key survived the recreate",
    );
  });

  it("reports the real exit code and restart count of a stopped container", async (t) => {
    const runtime = runtimeInfo;
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    // Exit non-zero on purpose: the point is that a crashed container is
    // distinguishable from a cleanly stopped one, which `getContainerState`
    // alone cannot do.
    await removeContainer(runtime, CONTAINER_NAME);
    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: IMAGE,
        tag: TAG,
        command: ["sh", "-c", `exit ${EXPECTED_EXIT_CODE}`],
        restart: "no",
      },
      () => {},
    );

    // Poll until the container has actually exited.
    let detail = await getContainerStateDetail(CONTAINER_NAME);
    for (
      let i = 0;
      i < EXIT_POLL_MAX_ATTEMPTS && detail.state === "running";
      i++
    ) {
      await new Promise((r) => setTimeout(r, EXIT_POLL_INTERVAL_MS));
      detail = await getContainerStateDetail(CONTAINER_NAME);
    }

    assert.equal(detail.state, "stopped");
    assert.equal(
      detail.exitCode,
      EXPECTED_EXIT_CODE,
      "real runtime exit code not surfaced",
    );
    assert.equal(typeof detail.restartCount, "number");
    assert.equal(detail.oomKilled, false);
  });

  it("reports missing for a container that does not exist", async (t) => {
    const runtime = runtimeInfo;
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    const detail = await getContainerStateDetail("no-such-container-abc123");
    assert.deepEqual(detail, { state: "missing" });
  });
});
