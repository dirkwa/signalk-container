import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import containerManagerPlugin from "../index.js";
import { _setClientForTesting } from "../client.js";
import {
  _setCurrentHostIdsForTesting,
  _setDetectRuntimeForTesting,
} from "../runtime.js";
import {
  INTERNET_PLUGIN_ID,
  INTERNET_STATE_PATH,
  InternetState,
  type InternetStateApp,
} from "../internetState.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type {
  ContainerManagerApi,
  ContainerRuntimeInfo,
  PluginConfig,
} from "../types.js";

/**
 * A server whose subscription manager replays `cached` at subscribe, as Signal
 * K does with the last value, and `publish` delivers the next one.
 */
function fakeServer(
  cached: unknown,
  plugin: { enabled: boolean } | null = { enabled: true },
) {
  let deliver: ((value: unknown) => void) | null = null;
  const counts = { pluginListReads: 0, unsubscribed: 0 };
  const app: InternetStateApp = {
    error: () => {},
    subscriptionmanager: {
      subscribe: (subscription, unsubscribes, _onError, onDelta) => {
        assert.deepEqual(subscription.subscribe, [
          { path: INTERNET_STATE_PATH, policy: "instant" },
        ]);
        deliver = (value) =>
          onDelta({
            updates: [{ values: [{ path: INTERNET_STATE_PATH, value }] }],
          });
        unsubscribes.push(() => {
          deliver = null;
          counts.unsubscribed++;
        });
        if (cached !== undefined) deliver(cached);
      },
    },
    getPluginsList: async () => {
      counts.pluginListReads++;
      return [
        { id: "signalk-container", enabled: true },
        ...(plugin ? [{ id: INTERNET_PLUGIN_ID, ...plugin }] : []),
      ];
    },
  };
  return { app, counts, publish: (value: unknown) => deliver?.(value) };
}

function started(app: InternetStateApp): InternetState {
  const state = new InternetState(app);
  state.start();
  return state;
}

describe("InternetState", () => {
  it("holds back on a metered, offline or captive uplink", async () => {
    for (const value of ["metered", "offline", "captive"]) {
      assert.equal(
        await started(fakeServer(value).app).isRestricted(),
        true,
        value,
      );
    }
  });

  it("lets traffic through when the uplink is online", async () => {
    assert.equal(await started(fakeServer("online").app).isRestricted(), false);
  });

  it("follows each new state without asking the server again", async () => {
    const server = fakeServer("online");
    const state = started(server.app);
    server.publish("metered");
    assert.equal(await state.isRestricted(), true);
    server.publish("online");
    assert.equal(await state.isRestricted(), false);
    assert.equal(server.counts.pluginListReads, 0);
  });

  it("holds back while the enabled plugin has not published yet", async () => {
    const server = fakeServer(undefined);
    const state = started(server.app);
    assert.equal(await state.isRestricted(), true);
    server.publish("online");
    assert.equal(await state.isRestricted(), false);
    assert.equal(server.counts.pluginListReads, 1);
  });

  it("asks the plugin list at the check, not at start", async () => {
    const server = fakeServer(undefined, null);
    const state = started(server.app);
    assert.equal(await state.isRestricted(), false);
    // signalk-internet registered after this plugin started
    server.app.getPluginsList = async () => [
      { id: INTERNET_PLUGIN_ID, enabled: true },
    ];
    assert.equal(await state.isRestricted(), true);
  });

  it("lets traffic through once signalk-internet clears its state on stop", async () => {
    const plugin = { enabled: true };
    const server = fakeServer("metered", plugin);
    const state = started(server.app);
    plugin.enabled = false;
    server.publish(null);
    assert.equal(await state.isRestricted(), false);
  });

  it("holds back after signalk-internet restarts, until it publishes again", async () => {
    const server = fakeServer("online");
    const state = started(server.app);
    server.publish(null);
    assert.equal(await state.isRestricted(), true);
    server.publish("online");
    assert.equal(await state.isRestricted(), false);
  });

  it("changes nothing without signalk-internet enabled", async () => {
    assert.equal(
      await started(
        fakeServer(undefined, { enabled: false }).app,
      ).isRestricted(),
      false,
    );
    assert.equal(
      await started(fakeServer(undefined, null).app).isRestricted(),
      false,
    );
  });

  it("changes nothing on a server that cannot tell which plugins run", async () => {
    const { app } = fakeServer(undefined);
    assert.equal(
      await started({ ...app, getPluginsList: undefined }).isRestricted(),
      false,
    );
    assert.equal(
      await started({
        ...app,
        getPluginsList: () => Promise.reject(new Error("boom")),
      }).isRestricted(),
      false,
    );
  });

  it("waits for the first state of an enabled signalk-internet", async () => {
    const server = fakeServer(undefined);
    const state = started(server.app);
    const t0 = Date.now();
    const answer = state.isRestricted({ waitMs: 5000 });
    setTimeout(() => server.publish("online"), 20);
    assert.equal(await answer, false);
    // Woken by the state, not by the end of the wait.
    assert.ok(Date.now() - t0 < 2500);
  });

  it("holds back when no state comes within the wait", async () => {
    const state = started(fakeServer(undefined).app);
    const t0 = Date.now();
    assert.equal(await state.isRestricted({ waitMs: 50 }), true);
    assert.ok(Date.now() - t0 >= 40);
  });

  it("keeps waiting through the null of a restart", async () => {
    const server = fakeServer(undefined);
    const state = started(server.app);
    const t0 = Date.now();
    const answer = state.isRestricted({ waitMs: 5000 });
    setTimeout(() => server.publish(null), 20);
    setTimeout(() => server.publish("online"), 40);
    assert.equal(await answer, false);
    assert.ok(Date.now() - t0 < 2500);
  });

  it("lets traffic through once signalk-internet is disabled during the wait", async () => {
    const plugin = { enabled: true };
    const server = fakeServer(undefined, plugin);
    const state = started(server.app);
    const t0 = Date.now();
    const answer = state.isRestricted({ waitMs: 5000 });
    setTimeout(() => {
      plugin.enabled = false;
      server.publish(null);
    }, 20);
    assert.equal(await answer, false);
    assert.ok(Date.now() - t0 < 2500);
  });

  it("stops waiting when it stops while the plugin list is read", async () => {
    const server = fakeServer(undefined);
    const list = server.app.getPluginsList!;
    const state: InternetState = started({
      ...server.app,
      getPluginsList: async () => {
        state.stop();
        return list();
      },
    });
    const t0 = Date.now();
    assert.equal(await state.isRestricted({ waitMs: 5000 }), true);
    assert.ok(Date.now() - t0 < 2500);
  });

  it("waits past the largest timer delay", async () => {
    const state = started(fakeServer(undefined).app);
    const abort = new AbortController();
    const answer = state.isRestricted({
      waitMs: Infinity,
      signal: abort.signal,
    });
    const pending = new Promise((resolve) =>
      setTimeout(() => resolve("pending"), 30),
    );
    assert.equal(await Promise.race([answer, pending]), "pending");
    abort.abort();
    assert.equal(await answer, true);
  });

  it("holds back at once when the signal aborts or the plugin stops", async () => {
    const state = started(fakeServer(undefined).app);
    const t0 = Date.now();

    const aborted = new AbortController();
    aborted.abort();
    assert.equal(
      await state.isRestricted({ waitMs: 5000, signal: aborted.signal }),
      true,
    );

    const abort = new AbortController();
    const answer = state.isRestricted({ waitMs: 5000, signal: abort.signal });
    setTimeout(() => abort.abort(), 20);
    assert.equal(await answer, true);

    const stopped = state.isRestricted({ waitMs: 5000 });
    setTimeout(() => state.stop(), 20);
    assert.equal(await stopped, true);

    assert.ok(Date.now() - t0 < 2500);
  });

  it("does not wait while stopped, with nothing to wake it", async () => {
    const state = started(fakeServer(undefined).app);
    state.stop();
    const t0 = Date.now();
    assert.equal(await state.isRestricted({ waitMs: 5000 }), true);
    assert.ok(Date.now() - t0 < 2500);
  });

  it("leaves no abort listener or timer behind", async () => {
    const timers = () =>
      process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const server = fakeServer(undefined);
    const state = started(server.app);
    const abort = new AbortController();
    const signal = abort.signal;

    const changed = state.isRestricted({ waitMs: 60_000, signal });
    await new Promise((resolve) => setImmediate(resolve));
    server.publish("online");
    assert.equal(await changed, false);

    server.publish(null);
    const stopped = state.isRestricted({ waitMs: 60_000, signal });
    await new Promise((resolve) => setImmediate(resolve));
    state.stop();
    assert.equal(await stopped, true);

    assert.equal(getEventListeners(signal, "abort").length, 0);
    // Fewer where an earlier test's timer fired meanwhile.
    assert.ok(timers() <= before);
  });

  it("does not wait without signalk-internet enabled", async () => {
    const t0 = Date.now();
    assert.equal(
      await started(fakeServer(undefined, { enabled: false }).app).isRestricted(
        { waitMs: 5000 },
      ),
      false,
    );
    assert.ok(Date.now() - t0 < 2500);
  });

  it("counts reading the plugin list towards the wait", async () => {
    const { app } = fakeServer(undefined);
    const list = app.getPluginsList!;
    let answerList: () => void = () => {};
    const listRead = new Promise<void>((resolve) => (answerList = resolve));
    const state = started({
      ...app,
      getPluginsList: async () => {
        await listRead;
        return list();
      },
    });
    const answer = state.isRestricted({ waitMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    answerList();
    // The wait ran out while the list was read, so no timer is left to run.
    const pending = new Promise((resolve) =>
      setImmediate(() => resolve("pending")),
    );
    assert.equal(await Promise.race([answer, pending]), true);
  });

  it("takes a state that came in while the plugin list was read", async () => {
    for (const [enabled, value, restricted] of [
      [true, "online", false],
      [false, "metered", true],
    ] as const) {
      const server = fakeServer(undefined, { enabled });
      const list = server.app.getPluginsList!;
      const state = started({
        ...server.app,
        getPluginsList: async () => {
          server.publish(value);
          return list();
        },
      });
      const t0 = Date.now();
      assert.equal(await state.isRestricted({ waitMs: 5000 }), restricted);
      assert.ok(Date.now() - t0 < 2500);
    }
  });

  it("unsubscribes and forgets the state on stop", async () => {
    const server = fakeServer("metered", null);
    const state = started(server.app);
    state.stop();
    assert.equal(server.counts.unsubscribed, 1);
    assert.equal(await state.isRestricted(), false);
  });
});

const RUNTIME: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "29.0.0",
  isPodmanDockerShim: false,
};
const IMAGE = "example/app";
const TAG = "latest";

describe("floating-tag auto-update on a restricted uplink", () => {
  const savedContainer = process.env.container;

  before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
  after(() => _setCurrentHostIdsForTesting(null));

  afterEach(() => {
    _setDetectRuntimeForTesting(null);
    _setClientForTesting(null);
    if (savedContainer === undefined) {
      delete process.env.container;
    } else {
      process.env.container = savedContainer;
    }
  });

  // `published` is what signalk-internet sent before the container starts.
  async function pullsOnStart(
    published: unknown[],
    internetPlugin = { enabled: true },
  ): Promise<number> {
    delete process.env.container;
    const calls = new Map<string, unknown[]>();
    _setClientForTesting(
      makeMockClient({
        containers: {
          "sk-app": {
            inspect: () =>
              Promise.resolve({
                Image: "sha256:live",
                State: { Status: "running", Running: true, Pid: 42 },
                // Matches the request, so the floating-tag probe is the only
                // thing ensureRunning has left to do.
                Config: {
                  Image: `${IMAGE}:${TAG}`,
                  Env: [],
                  Labels: {},
                  User: "1000:1000",
                },
                HostConfig: {
                  NetworkMode: "default",
                  ExtraHosts: ["host.containers.internal:host-gateway"],
                },
                Mounts: [],
              }),
          },
        },
        images: { [`${IMAGE}:${TAG}`]: { Id: "sha256:live", Config: {} } },
        calls,
      }),
    );
    _setDetectRuntimeForTesting(() => Promise.resolve(RUNTIME));
    const dataDir = mkdtempSync(join(tmpdir(), "skc-internet-state-"));
    const noop = () => {};
    const server = fakeServer(published[0], internetPlugin);
    const plugin = containerManagerPlugin({
      debug: noop,
      error: noop,
      setPluginStatus: noop,
      setPluginError: noop,
      getDataDirPath: () => dataDir,
      config: { configPath: dataDir },
      subscriptionmanager: server.app.subscriptionmanager,
      getPluginsList: server.app.getPluginsList,
    });
    plugin.start({ backgroundUpdateChecks: false } as PluginConfig);
    for (const value of published.slice(1)) server.publish(value);
    const api = (
      globalThis as { __signalk_containerManager?: ContainerManagerApi }
    ).__signalk_containerManager;
    try {
      if (!api) throw new Error("plugin did not expose containerManager API");
      await api.whenReady();
      await api.ensureRunning("app", {
        image: IMAGE,
        tag: TAG,
        autoUpdateOnFloatingTag: true,
      });
      return (calls.get("pull") ?? []).length;
    } finally {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  it("pulls the tag on start while online", async () => {
    assert.equal(await pullsOnStart(["online"]), 1);
  });

  it("does not pull while metered", async () => {
    assert.equal(await pullsOnStart(["metered"]), 0);
  });

  it("does not pull before an enabled signalk-internet has published", async () => {
    assert.equal(await pullsOnStart([]), 0);
  });

  it("pulls once signalk-internet clears its state on stop", async () => {
    assert.equal(await pullsOnStart(["metered", null], { enabled: false }), 1);
  });
});

describe("the internet API", () => {
  afterEach(() => {
    _setDetectRuntimeForTesting(null);
    _setClientForTesting(null);
  });

  it("answers from signalk-internet's state", async () => {
    _setClientForTesting(makeMockClient({}));
    _setDetectRuntimeForTesting(() => Promise.resolve(RUNTIME));
    const dataDir = mkdtempSync(join(tmpdir(), "skc-internet-api-"));
    const noop = () => {};
    const server = fakeServer(undefined);
    const plugin = containerManagerPlugin({
      debug: noop,
      error: noop,
      setPluginStatus: noop,
      setPluginError: noop,
      getDataDirPath: () => dataDir,
      config: { configPath: dataDir },
      subscriptionmanager: server.app.subscriptionmanager,
      getPluginsList: server.app.getPluginsList,
    });
    plugin.start({ backgroundUpdateChecks: false } as PluginConfig);
    const api = (
      globalThis as { __signalk_containerManager?: ContainerManagerApi }
    ).__signalk_containerManager;
    try {
      if (!api) throw new Error("plugin did not expose containerManager API");
      assert.equal(await api.internet.isRestricted(), true);
      // The wait reaches the plugin's state: without it the answer is true.
      const t0 = Date.now();
      const answer = api.internet.isRestricted({ waitMs: 5000 });
      setTimeout(() => server.publish("online"), 20);
      assert.equal(await answer, false);
      assert.ok(Date.now() - t0 < 2500);
      server.publish("metered");
      assert.equal(await api.internet.isRestricted(), true);
    } finally {
      if (plugin.stop) await plugin.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
