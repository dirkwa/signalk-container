import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntime, isContainerized } from "../../runtime.js";
import { getContainerState } from "../../containers.js";
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

// A capturing mock of the server's managed-notification API.
interface RaiseCall {
  state: string;
  message: string;
  path: string;
}
function makeNotificationSink() {
  const raised: RaiseCall[] = [];
  const cleared: string[] = [];
  const byId = new Map<string, RaiseCall>();
  let seq = 0;
  return {
    raised,
    cleared,
    notifications: {
      raise: (o: RaiseCall & { idInPath?: boolean; data?: unknown }) => {
        raised.push(o);
        const id = `nid-${seq++}`;
        byId.set(id, o);
        return id;
      },
      clear: (id: string) => {
        cleared.push(id);
      },
    },
    // helper: the paths currently "live" (raised and not yet cleared)
    clearedPaths(): string[] {
      return this.cleared.map((id) => byId.get(id)?.path ?? id);
    },
  };
}

const CONTAINER_NAME = "degradation-test";
const TRAP_AND_WAIT = ["sh", "-c", "trap exit TERM; sleep 60 & wait"];

async function bootPlugin(
  sink: ReturnType<typeof makeNotificationSink>,
): Promise<{
  api: ContainerManagerApi;
  stop: () => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "skc-degradation-test-"));
  const noop = () => {};
  const app = {
    debug: noop,
    error: noop,
    setPluginStatus: noop,
    setPluginError: noop,
    getDataDirPath: () => dataDir,
    config: { configPath: dataDir },
    notifications: sink.notifications,
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
      await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("degradation notifications — e2e against a real runtime", () => {
  let runtime: ContainerRuntimeInfo | null = null;
  let sink: ReturnType<typeof makeNotificationSink>;
  let booted: { api: ContainerManagerApi; stop: () => Promise<void> } | null =
    null;

  before(async () => {
    runtime = await hasContainerRuntime();
  });

  after(async () => {
    if (runtime && booted) {
      try {
        await booted.api.remove(CONTAINER_NAME);
      } catch {
        /* best effort */
      }
      await booted.stop();
    }
  });

  it("raises volumeAborted (alert) when a required volume source is missing, then clears on recovery", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    // The optimistic-emit path treats a missing required volume as present
    // when Signal K is containerized (it can't see the host fs), which
    // would change the assertion. Only run the strict host-fs assertion
    // when not containerized.
    if (isContainerized()) {
      t.skip("volume-abort semantics differ under a containerized manager");
      return;
    }

    sink = makeNotificationSink();
    booted = await bootPlugin(sink);
    try {
      await booted.api.remove(CONTAINER_NAME);
    } catch {
      /* ok if absent */
    }

    const missingSource = join(
      tmpdir(),
      `skc-does-not-exist-${process.pid}-${Date.now()}`,
    );

    // ensureRunning with a required (ifMissing: "abort") volume whose
    // source does not exist must throw AND raise volumeAborted (alert).
    await assert.rejects(
      booted.api.ensureRunning(CONTAINER_NAME, {
        image: "docker.io/library/alpine",
        tag: "3.19",
        command: TRAP_AND_WAIT,
        restart: "no",
        volumes: {
          "/required": { source: missingSource, ifMissing: "abort" },
        },
      }),
      /required host paths missing|does not exist/i,
      "ensureRunning must reject when a required volume source is missing",
    );

    const abortedRaise = sink.raised.find(
      (r) =>
        r.path === `notifications.container.${CONTAINER_NAME}.volumeAborted`,
    );
    assert.ok(
      abortedRaise,
      `expected a volumeAborted notification, got: ${JSON.stringify(sink.raised)}`,
    );
    assert.equal(abortedRaise.state, "alert");
    assert.equal(
      sink.cleared.length,
      0,
      "nothing should have cleared yet while the source is still missing",
    );

    // Recovery: same container, now with the required source present (use
    // the temp data dir, which exists). A successful ensureRunning must
    // clear the volumeAborted alert.
    const presentSource = mkdtempSync(join(tmpdir(), "skc-present-"));
    await booted.api.ensureRunning(CONTAINER_NAME, {
      image: "docker.io/library/alpine",
      tag: "3.19",
      command: TRAP_AND_WAIT,
      restart: "no",
      volumes: { "/required": { source: presentSource, ifMissing: "abort" } },
    });
    assert.equal(
      await getContainerState(runtime, CONTAINER_NAME),
      "running",
      "container should be running after the source reappears",
    );
    assert.ok(
      sink
        .clearedPaths()
        .includes(`notifications.container.${CONTAINER_NAME}.volumeAborted`),
      `expected the volumeAborted notification to be cleared on recovery, cleared=${JSON.stringify(
        sink.clearedPaths(),
      )}`,
    );

    rmSync(presentSource, { recursive: true, force: true });
  });

  it("clears all outstanding notifications on plugin stop()", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    if (isContainerized()) {
      t.skip("volume-abort semantics differ under a containerized manager");
      return;
    }
    const localSink = makeNotificationSink();
    const local = await bootPlugin(localSink);
    const missingSource = join(
      tmpdir(),
      `skc-gone-${process.pid}-${Date.now()}`,
    );
    await assert.rejects(
      local.api.ensureRunning("stop-clear-test", {
        image: "docker.io/library/alpine",
        tag: "3.19",
        command: TRAP_AND_WAIT,
        restart: "no",
        volumes: { "/req": { source: missingSource, ifMissing: "abort" } },
      }),
    );
    assert.ok(localSink.raised.length >= 1, "a notification should be raised");
    const outstanding = localSink.raised.length - localSink.cleared.length;
    assert.ok(outstanding >= 1, "notification should still be outstanding");
    await local.stop(); // stop() must clear it
    assert.ok(
      localSink.cleared.length >= 1,
      "stop() must clear outstanding notifications",
    );
  });
});
