import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLiveContainerConfig } from "../../containers.js";
import { detectRuntime } from "../../runtime.js";
import containerManagerPlugin from "../../index.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
  VolumeIssue,
} from "../../types.js";

/**
 * Live cover for the per-volume `ifMissing` policy.
 *
 * The classifier is unit-tested against an injected probe, but the
 * consequence of misjudging a source is runtime-dependent: Docker creates
 * an absent bind source rather than refusing to start, so there is no loud
 * failure to fall back on. Exercise the API against a real runtime to
 * verify that neither `skip` nor `abort` ever hands an absent source to
 * it.
 */

const IMAGE = "alpine";
const TAG = "3.19";
const CONTAINER_NAME = "volume-policy-test";
/** Long enough that the container outlives every assertion against it. */
const CONTAINER_WAIT_SECONDS = 60;
/** Written into the mounted source and read back from inside the container. */
const MARKER_NAME = "marker";
const MARKER_CONTENT = "mounted-source-is-readable";
const TRAP_AND_WAIT_CMD = [
  "sh",
  "-c",
  `trap exit TERM; sleep ${CONTAINER_WAIT_SECONDS} & wait`,
];

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

/**
 * The ifMissing policy is applied by the plugin's `ensureRunning` wrapper,
 * not by the module-level function — the classifier and the bind-mount
 * coverage probe both live there. Driving the API is the only way to
 * exercise it.
 */
async function bootPlugin(): Promise<{
  api: ContainerManagerApi;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-volume-policy-plugin-"));
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

describe("volume ifMissing policy — real runtime", () => {
  let tmp: string;
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
    tmp = mkdtempSync(join(tmpdir(), "skc-volume-policy-"));
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
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("mounts a source that exists", async (t) => {
    const runtime = runtimeInfo;
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    // `tmp` itself is the source: it exists, so it must be bound.
    writeFileSync(join(tmp, MARKER_NAME), MARKER_CONTENT);

    const issues: VolumeIssue[] = [];
    await api.ensureRunning(
      CONTAINER_NAME,
      {
        image: IMAGE,
        tag: TAG,
        command: TRAP_AND_WAIT_CMD,
        volumes: { "/mnt/data": { source: tmp, ifMissing: "skip" } },
      },
      {
        onVolumeIssue: (i) => {
          issues.push(i);
        },
      },
    );

    const live = await getLiveContainerConfig(runtime, CONTAINER_NAME);
    assert.ok(live);
    assert.ok(
      live.binds.some((b) => b.container === "/mnt/data" && b.host === tmp),
      `expected ${tmp} bound at /mnt/data, got ${JSON.stringify(live.binds)}`,
    );
    assert.equal(issues.length, 0, "an existing source should raise no issue");

    // The bind string alone is not proof the data is reachable: where the
    // manager and the runtime see different filesystems, the daemon can
    // bind a different, empty directory of the same path and the config
    // looks identical. Read the marker from inside to settle it.
    // The container itself decides: exit 0 only when the marker is present
    // with the expected content. Reading stdout back would depend on the
    // job's uid mapping being able to read the file too; the grep exit
    // status answers the reachability question without that coupling.
    const readBack = await api.runJob({
      image: `${IMAGE}:${TAG}`,
      command: [
        "sh",
        "-c",
        `grep -q '${MARKER_CONTENT}' /mnt/data/${MARKER_NAME}`,
      ],
      inputs: { "/mnt/data": tmp },
    });
    assert.equal(
      readBack.exitCode,
      0,
      `the mounted source was not readable from inside (${readBack.status}): ${readBack.error ?? readBack.log.join(" | ")}`,
    );
  });

  it("skips a missing optional source and still starts", async (t) => {
    const runtime = runtimeInfo;
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    const missing = join(tmp, "not-plugged-in");
    assert.equal(existsSync(missing), false, "fixture must not exist");

    await api.remove(CONTAINER_NAME);
    const issues: VolumeIssue[] = [];
    await api.ensureRunning(
      CONTAINER_NAME,
      {
        image: IMAGE,
        tag: TAG,
        command: TRAP_AND_WAIT_CMD,
        volumes: { "/mnt/usb": { source: missing, ifMissing: "skip" } },
      },
      {
        onVolumeIssue: (i) => {
          issues.push(i);
        },
      },
    );

    const live = await getLiveContainerConfig(runtime, CONTAINER_NAME);
    assert.ok(live, "container should still be running without the mount");
    assert.ok(
      !live.binds.some((b) => b.container === "/mnt/usb"),
      "the missing optional source should not have been mounted",
    );
    assert.ok(
      issues.some((i) => i.action === "skipped"),
      `expected a 'skipped' issue, got ${JSON.stringify(issues)}`,
    );

    // The runtime must not have been asked to bind it, so nothing should
    // have been created on the host either. This is the Docker case that
    // would otherwise leave an empty directory behind.
    assert.equal(
      existsSync(missing),
      false,
      "a skipped source must not be created on the host",
    );
  });

  it("refuses to start when a required source is missing", async (t) => {
    const runtime = runtimeInfo;
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    const required = join(tmp, "required-certs");
    assert.equal(existsSync(required), false, "fixture must not exist");

    await api.remove(CONTAINER_NAME);
    const issues: VolumeIssue[] = [];
    await assert.rejects(
      () =>
        api.ensureRunning(
          CONTAINER_NAME,
          {
            image: IMAGE,
            tag: TAG,
            command: TRAP_AND_WAIT_CMD,
            volumes: { "/certs": { source: required, ifMissing: "abort" } },
          },
          {
            onVolumeIssue: (i) => {
              issues.push(i);
            },
          },
        ),
      "a missing required source must abort the start",
    );

    assert.ok(
      issues.some((i) => i.action === "aborted"),
      `expected an 'aborted' issue, got ${JSON.stringify(issues)}`,
    );
    // Rejecting is not enough on its own: a container created and then
    // abandoned would still satisfy the throw.
    assert.equal(
      await getLiveContainerConfig(runtime, CONTAINER_NAME),
      null,
      "aborting must not leave a container behind",
    );

    // Failing closed means the host is untouched — no empty directory
    // standing in for the data the container needed.
    assert.equal(
      existsSync(required),
      false,
      "an aborted source must not be created on the host",
    );
  });
});
