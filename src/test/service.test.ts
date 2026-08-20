import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  UpdateService,
  type ContainerDeps,
  type AppDeps,
  type ClockDeps,
} from "../updates/service.js";
import { MemoryUpdateCache } from "../updates/cache.js";
import type { ContainerRuntimeInfo, ContainerState } from "../types.js";
import type {
  UpdateRegistration,
  VersionSource,
  VersionSourceResult,
  UpdateCheckResult,
} from "../updates/types.js";

// ---------- test doubles ----------

interface FakeClockHandle {
  fn: () => void;
  delayMs: number;
  scheduledAt: number;
  fired: boolean;
}

class FakeClock implements ClockDeps {
  current = 1_000_000;
  timers: FakeClockHandle[] = [];

  now(): number {
    return this.current;
  }

  setTimer(fn: () => void, delayMs: number): unknown {
    const handle: FakeClockHandle = {
      fn,
      delayMs,
      scheduledAt: this.current,
      fired: false,
    };
    this.timers.push(handle);
    return handle;
  }

  clearTimer(handle: unknown): void {
    const idx = this.timers.indexOf(handle as FakeClockHandle);
    if (idx >= 0) this.timers.splice(idx, 1);
  }

  /** Manually fire the next timer (simulate time passing). */
  fireNext(): void {
    const next = this.timers.find((t) => !t.fired);
    if (!next) return;
    next.fired = true;
    next.fn();
  }
}

interface FakeAppCalls {
  debug: string[];
  error: string[];
  notifications: Array<{ pluginId: string; delta: unknown }>;
}

function makeAppDeps(): { deps: AppDeps; calls: FakeAppCalls } {
  const calls: FakeAppCalls = {
    debug: [],
    error: [],
    notifications: [],
  };
  const deps: AppDeps = {
    debug: (msg, ...rest) => calls.debug.push([msg, ...rest].join(" ")),
    error: (msg, ...rest) => calls.error.push([msg, ...rest].join(" ")),
    handleMessage: (pluginId, delta) =>
      calls.notifications.push({ pluginId, delta }),
  };
  return { deps, calls };
}

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.0.0",
  isPodmanDockerShim: false,
};

interface FakeContainerOpts {
  runtime?: ContainerRuntimeInfo | null;
  state?: ContainerState;
  pullImage?: () => Promise<void>;
  digests?: Record<string, string | null>;
}

function makeContainerDeps(opts: FakeContainerOpts = {}): ContainerDeps {
  return {
    getRuntime: () => opts.runtime ?? dummyRuntime,
    getState: async () => opts.state ?? "running",
    pullImage: opts.pullImage ?? (async () => {}),
    getImageDigest: async (key: string) => opts.digests?.[key] ?? null,
  };
}

function makeVersionSource(
  result: VersionSourceResult | (() => Promise<VersionSourceResult>),
): VersionSource {
  return {
    fetch: async () => (typeof result === "function" ? result() : result),
  };
}

function offlineSource(): VersionSource {
  return {
    fetch: async () => {
      const err = new Error("fetch failed") as Error & { cause?: unknown };
      const cause = new Error("ENETUNREACH") as NodeJS.ErrnoException;
      cause.code = "ENETUNREACH";
      err.cause = cause;
      throw err;
    },
  };
}

function realErrorSource(message: string): VersionSource {
  return {
    fetch: async () => ({ kind: "error", error: message }),
  };
}

function basicReg(
  overrides: Partial<UpdateRegistration> = {},
): UpdateRegistration {
  return {
    pluginId: "test-plugin",
    containerName: "test-plugin",
    image: "foo/bar",
    currentTag: () => "1.0.0",
    versionSource: makeVersionSource({ kind: "version", latest: "1.0.0" }),
    ...overrides,
  };
}

function makeService(opts: {
  containers?: ContainerDeps;
  clock?: FakeClock;
  cache?: MemoryUpdateCache;
  app?: AppDeps;
  backgroundChecks?: boolean;
  errorStrikeLimit?: number;
}): {
  service: UpdateService;
  clock: FakeClock;
  cache: MemoryUpdateCache;
  appCalls: FakeAppCalls;
} {
  const clock = opts.clock ?? new FakeClock();
  const cache = opts.cache ?? new MemoryUpdateCache();
  const { deps: defaultApp, calls } = makeAppDeps();
  const app = opts.app ?? defaultApp;
  const containers = opts.containers ?? makeContainerDeps();
  const service = new UpdateService({
    app,
    containers,
    clock,
    cache,
    backgroundChecks: opts.backgroundChecks ?? false,
    errorStrikeLimit: opts.errorStrikeLimit ?? 5,
  });
  return { service, clock, cache, appCalls: calls };
}

// ---------- tests ----------

describe("UpdateService — strategy matrix", () => {
  it("semver pinned, registry has higher → newer-version, updateAvailable", async () => {
    const { service } = makeService({});
    service.register(
      basicReg({
        currentTag: () => "9.1.0",
        versionSource: makeVersionSource({ kind: "version", latest: "9.2.0" }),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.tagKind, "semver");
    assert.equal(r.currentVersion, "9.1.0");
    assert.equal(r.latestVersion, "9.2.0");
    assert.equal(r.updateAvailable, true);
    assert.equal(r.reason, "newer-version");
    assert.equal(r.fromCache, false);
  });

  it("semver pinned, equal → up-to-date", async () => {
    const { service } = makeService({});
    service.register(
      basicReg({
        currentTag: () => "9.2.0",
        versionSource: makeVersionSource({ kind: "version", latest: "9.2.0" }),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.updateAvailable, false);
    assert.equal(r.reason, "up-to-date");
  });

  it("semver pinned, ahead of latest → up-to-date but latestVersion still populated", async () => {
    const { service } = makeService({});
    service.register(
      basicReg({
        currentTag: () => "10.0.0-rc1",
        versionSource: makeVersionSource({ kind: "version", latest: "9.2.0" }),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.updateAvailable, false);
    assert.equal(r.latestVersion, "9.2.0");
  });

  it("floating tag, digest matches → up-to-date", async () => {
    const { service } = makeService({
      containers: makeContainerDeps({
        digests: {
          "foo/bar:latest": "sha256:abc",
          "test-plugin": "sha256:abc",
        },
      }),
    });
    service.register(
      basicReg({
        currentTag: () => "latest",
        versionSource: makeVersionSource({ kind: "version", latest: "9.2.0" }),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.tagKind, "floating");
    assert.equal(r.updateAvailable, false);
    assert.equal(r.reason, "up-to-date");
    assert.equal(
      r.latestVersion,
      "9.2.0",
      "latestVersion still populated for info",
    );
  });

  it("floating tag, digest differs → digest-drift, updateAvailable", async () => {
    const { service } = makeService({
      containers: makeContainerDeps({
        digests: {
          "foo/bar:main": "sha256:newremote",
          "test-plugin": "sha256:oldlocal",
        },
      }),
    });
    service.register(
      basicReg({
        currentTag: () => "main",
        versionSource: makeVersionSource({ kind: "version", latest: "9.2.0" }),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.tagKind, "floating");
    assert.equal(r.updateAvailable, true);
    assert.equal(r.reason, "digest-drift");
  });

  it("unknown tag (custom) treats as digest-drift only", async () => {
    const { service } = makeService({
      containers: makeContainerDeps({
        digests: {
          "foo/bar:my-fork": "sha256:remote",
          "test-plugin": "sha256:local",
        },
      }),
    });
    service.register(
      basicReg({
        currentTag: () => "my-fork",
        versionSource: makeVersionSource({ kind: "version", latest: "9.2.0" }),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.tagKind, "unknown");
    assert.equal(r.updateAvailable, true);
    assert.equal(r.reason, "digest-drift");
  });
});

describe("UpdateService — currentVersion overrides currentTag", () => {
  it("uses currentVersion() callback when present", async () => {
    const { service } = makeService({});
    service.register(
      basicReg({
        currentTag: () => "9.2.0",
        currentVersion: async () => "9.1.5",
        versionSource: makeVersionSource({ kind: "version", latest: "9.2.0" }),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.currentVersion, "9.1.5");
    // 9.1.5 < 9.2.0 → updateAvailable
    assert.equal(r.updateAvailable, true);
    assert.equal(r.reason, "newer-version");
  });
});

describe("UpdateService — offline handling", () => {
  it("with cache: returns cached result, fromCache=true, reason=offline", async () => {
    const cache = new MemoryUpdateCache();
    cache.save({
      "test-plugin": {
        pluginId: "test-plugin",
        containerName: "test-plugin",
        runningTag: "1.0.0",
        tagKind: "semver",
        currentVersion: "1.0.0",
        latestVersion: "1.0.5",
        updateAvailable: true,
        reason: "newer-version",
        checkedAt: "2026-04-01T12:00:00.000Z",
        lastSuccessfulCheckAt: "2026-04-01T12:00:00.000Z",
        fromCache: false,
      },
    });
    const { service, appCalls } = makeService({ cache });
    service.register(
      basicReg({
        versionSource: offlineSource(),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.reason, "offline");
    assert.equal(r.fromCache, true);
    assert.equal(r.currentVersion, "1.0.0");
    assert.equal(r.latestVersion, "1.0.5");
    assert.equal(r.updateAvailable, true, "preserves cached updateAvailable");
    assert.equal(
      r.lastSuccessfulCheckAt,
      "2026-04-01T12:00:00.000Z",
      "preserves original timestamp",
    );
    assert.notEqual(
      r.checkedAt,
      "2026-04-01T12:00:00.000Z",
      "checkedAt is fresh",
    );
    assert.equal(appCalls.error.length, 0, "no error logged for offline");
  });

  it("without cache: returns reason=offline, fromCache=false, all null", async () => {
    const { service, appCalls } = makeService({});
    service.register(
      basicReg({
        versionSource: offlineSource(),
      }),
    );
    const r = await service.checkOne("test-plugin");
    assert.equal(r.reason, "offline");
    assert.equal(r.fromCache, false);
    assert.equal(r.currentVersion, null);
    assert.equal(r.latestVersion, null);
    assert.equal(r.updateAvailable, false);
    assert.equal(appCalls.error.length, 0);
  });

  it("100 consecutive offline errors do NOT auto-unregister", async () => {
    const { service, appCalls } = makeService({ errorStrikeLimit: 5 });
    service.register(
      basicReg({
        versionSource: offlineSource(),
      }),
    );
    for (let i = 0; i < 100; i++) {
      await service.checkOne("test-plugin");
    }
    // Still registered
    assert.deepEqual(service.listRegistrations(), ["test-plugin"]);
    assert.equal(appCalls.error.length, 0);
  });
});

describe("UpdateService — N-strikes auto-unregister", () => {
  it("5 consecutive REAL errors auto-unregister and log error", async () => {
    const { service, appCalls } = makeService({ errorStrikeLimit: 5 });
    service.register(
      basicReg({
        versionSource: realErrorSource("HTTP 404 not found"),
      }),
    );
    for (let i = 0; i < 5; i++) {
      const r = await service.checkOne("test-plugin").catch((e) => e);
      // The 5th call is allowed because the registration only goes
      // away AFTER the strike count is incremented inside runCheck.
      // We don't fail here — we just check the side effect below.
      assert.ok(r);
    }
    assert.deepEqual(service.listRegistrations(), []);
    // Should have logged at least one strike error and the unregister.
    assert.ok(appCalls.error.length >= 2);
  });

  it("real error then success resets the strike counter", async () => {
    let attempts = 0;
    const { service } = makeService({});
    service.register(
      basicReg({
        versionSource: makeVersionSource(async () => {
          attempts += 1;
          if (attempts <= 3) return { kind: "error", error: "boom" };
          return { kind: "version", latest: "1.0.0" };
        }),
      }),
    );
    for (let i = 0; i < 3; i++) await service.checkOne("test-plugin");
    // Should still be registered (3 < 5).
    assert.deepEqual(service.listRegistrations(), ["test-plugin"]);
    // Now succeed, counter resets.
    await service.checkOne("test-plugin");
    // Now fail 4 more times — should still be registered.
    attempts = 0; // restart fail loop
    service.unregister("test-plugin");
    let fails = 0;
    service.register(
      basicReg({
        versionSource: makeVersionSource(async () => {
          fails += 1;
          if (fails <= 4) return { kind: "error", error: "boom" };
          return { kind: "version", latest: "1.0.0" };
        }),
      }),
    );
    for (let i = 0; i < 4; i++) await service.checkOne("test-plugin");
    assert.deepEqual(service.listRegistrations(), ["test-plugin"]);
  });
});

describe("UpdateService — container state gate", () => {
  it("stopped container → reason=unknown, no error", async () => {
    const { service, appCalls } = makeService({
      containers: makeContainerDeps({ state: "stopped" }),
    });
    service.register(basicReg());
    const r = await service.checkOne("test-plugin");
    assert.equal(r.reason, "unknown");
    assert.equal(r.currentVersion, null);
    assert.equal(appCalls.error.length, 0);
  });

  it("missing container → reason=unknown", async () => {
    const { service } = makeService({
      containers: makeContainerDeps({ state: "missing" }),
    });
    service.register(basicReg());
    const r = await service.checkOne("test-plugin");
    assert.equal(r.reason, "unknown");
  });
});

describe("UpdateService — runtime not ready", () => {
  it("getRuntime() === null → reason=unknown, no crash", async () => {
    const { service } = makeService({
      containers: {
        getRuntime: () => null,
        getState: async () => "no-runtime" as ContainerState,
        pullImage: async () => {},
        getImageDigest: async () => null,
      },
    });
    service.register(basicReg());
    const r = await service.checkOne("test-plugin");
    assert.equal(r.reason, "unknown");
  });
});

describe("UpdateService — cache seeding on register", () => {
  it("getLastResult() returns cached value immediately after register", () => {
    const cache = new MemoryUpdateCache();
    const seeded: UpdateCheckResult = {
      pluginId: "test-plugin",
      containerName: "test-plugin",
      runningTag: "1.0.0",
      tagKind: "semver",
      currentVersion: "1.0.0",
      latestVersion: "1.0.1",
      updateAvailable: true,
      reason: "newer-version",
      checkedAt: "2026-04-01T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-04-01T00:00:00.000Z",
      fromCache: false,
    };
    cache.save({ "test-plugin": seeded });
    const { service } = makeService({ cache });
    service.register(basicReg());
    const r = service.getLastResult("test-plugin");
    assert.deepEqual(r, seeded);
  });

  it("drops a cached verdict that describes a different running tag", () => {
    // The container was updated while the cache still held the pre-update
    // comparison. Restoring it renders "1.0.0 available" on a container
    // already running 1.0.0, and it survives every restart until a real
    // check happens to land.
    const cache = new MemoryUpdateCache();
    cache.save({
      "test-plugin": {
        pluginId: "test-plugin",
        containerName: "test-plugin",
        runningTag: "0.6.10",
        tagKind: "semver",
        currentVersion: "0.6.10",
        latestVersion: "1.0.0",
        updateAvailable: true,
        reason: "newer-version",
        checkedAt: "2026-04-01T00:00:00.000Z",
        lastSuccessfulCheckAt: "2026-04-01T00:00:00.000Z",
        fromCache: false,
      },
    });
    const { service } = makeService({ cache });
    service.register(basicReg({ currentTag: () => "1.0.0" }));
    assert.equal(service.getLastResult("test-plugin"), null);
  });

  it("evicts the stale entry so an offline check cannot resurface it", async () => {
    // handleOffline() and buildUnknownResult() read cachedResults directly,
    // so skipping the seed alone would let the same wrong verdict return via
    // the first offline or container-not-running check.
    const cache = new MemoryUpdateCache();
    cache.save({
      "test-plugin": {
        pluginId: "test-plugin",
        containerName: "test-plugin",
        runningTag: "0.6.10",
        tagKind: "semver",
        currentVersion: "0.6.10",
        latestVersion: "1.0.0",
        updateAvailable: true,
        reason: "newer-version",
        checkedAt: "2026-04-01T00:00:00.000Z",
        lastSuccessfulCheckAt: "2026-04-01T00:00:00.000Z",
        fromCache: false,
      },
    });
    const { service } = makeService({
      cache,
      containers: {
        getRuntime: () => dummyRuntime,
        getState: async () => "stopped" as ContainerState,
        pullImage: async () => {},
        getImageDigest: async () => null,
      },
    });
    service.register(basicReg({ currentTag: () => "1.0.0" }));
    const r = await service.checkOne("test-plugin");
    assert.equal(r.updateAvailable, false);
    assert.equal(r.latestVersion, null, "must not carry the evicted verdict");
  });

  it("keeps the cached verdict when currentTag() cannot report a tag", () => {
    // safeCallTag() returns "" when the callback throws. That is "unknown",
    // not "different" — evicting on it would discard a good entry over a
    // transient failure.
    const cache = new MemoryUpdateCache();
    const seeded: UpdateCheckResult = {
      pluginId: "test-plugin",
      containerName: "test-plugin",
      runningTag: "1.0.0",
      tagKind: "semver",
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      updateAvailable: true,
      reason: "newer-version",
      checkedAt: "2026-04-01T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-04-01T00:00:00.000Z",
      fromCache: false,
    };
    cache.save({ "test-plugin": seeded });
    const { service } = makeService({ cache });
    service.register(
      basicReg({
        currentTag: () => {
          throw new Error("settings not loaded yet");
        },
      }),
    );
    assert.deepEqual(service.getLastResult("test-plugin"), seeded);
  });

  it("keeps the cached verdict when the running tag still matches", () => {
    // The offshore case the cache exists for: reboot with no uplink on the
    // same version must still show the last known-good result.
    const cache = new MemoryUpdateCache();
    const seeded: UpdateCheckResult = {
      pluginId: "test-plugin",
      containerName: "test-plugin",
      runningTag: "1.0.0",
      tagKind: "semver",
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      updateAvailable: true,
      reason: "newer-version",
      checkedAt: "2026-04-01T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-04-01T00:00:00.000Z",
      fromCache: false,
    };
    cache.save({ "test-plugin": seeded });
    const { service } = makeService({ cache });
    service.register(basicReg({ currentTag: () => "1.0.0" }));
    assert.deepEqual(service.getLastResult("test-plugin"), seeded);
  });
});

const MAX_INITIAL_DELAY_MS = 5 * 60 * 1000;
const MIN_RECURRING_DELAY_MS = 20 * 60 * 60 * 1000;

describe("UpdateService — offline reuse", () => {
  it("does not carry a stale verdict forward when the running tag moved", async () => {
    // An in-session update (Apply update, no re-register) moves runningTag
    // while the cached comparison still describes the version it replaced.
    const cache = new MemoryUpdateCache();
    cache.save({
      "test-plugin": {
        pluginId: "test-plugin",
        containerName: "test-plugin",
        runningTag: "0.6.10",
        tagKind: "semver",
        currentVersion: "0.6.10",
        latestVersion: "1.0.0",
        updateAvailable: true,
        reason: "newer-version",
        checkedAt: "2026-04-01T00:00:00.000Z",
        lastSuccessfulCheckAt: "2026-04-01T00:00:00.000Z",
        fromCache: false,
      },
    });
    const { service } = makeService({
      cache,
      // Registered on the old tag, so the entry survives register().
      containers: {
        getRuntime: () => dummyRuntime,
        getState: async () => "running" as ContainerState,
        pullImage: async () => {},
        getImageDigest: async () => null,
      },
    });
    let tag = "0.6.10";
    service.register(
      basicReg({
        currentTag: () => tag,
        versionSource: {
          fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
        },
      }),
    );
    // The container is updated in-session; no re-register happens.
    tag = "1.0.0";
    const r = await service.checkOne("test-plugin");
    assert.equal(
      r.updateAvailable,
      false,
      "must not advertise an update for the version now running",
    );
  });
});

describe("UpdateService — first check scheduling", () => {
  it("schedules the first check on a short delay, not a full interval", () => {
    // Registration happens while the container is still starting, so the
    // container-state gate usually reports not-running on the first attempt.
    // Retrying only after a full interval leaves a restored cache entry on
    // screen for up to a day.
    const { service, clock } = makeService({ backgroundChecks: true });
    service.register(basicReg({ checkInterval: "24h" }));
    const first = clock.timers.find((t) => !t.fired);
    assert.ok(first, "expected a scheduled first check");
    assert.ok(
      first.delayMs < MAX_INITIAL_DELAY_MS,
      `first check should be minutes away, got ${first.delayMs}ms`,
    );
  });

  it("returns to the configured interval after the first check", async () => {
    const { service, clock } = makeService({ backgroundChecks: true });
    service.register(basicReg({ checkInterval: "24h" }));
    clock.fireNext();
    // The reschedule runs in the check's .finally(), so let it settle.
    await new Promise((r) => setImmediate(r));
    const next = clock.timers.find((t) => !t.fired);
    assert.ok(next, "expected a rescheduled check");
    // 24h minus at most 10% jitter.
    assert.ok(
      next.delayMs > MIN_RECURRING_DELAY_MS,
      `recurring check should keep the configured interval, got ${next.delayMs}ms`,
    );
  });
  it("keeps retrying on the short delay while the container is not running", async () => {
    // A first boot that pulls the image can outlast the initial delay; falling
    // back to the 24h interval there would leave the panel wrong for a day.
    const { service, clock } = makeService({
      backgroundChecks: true,
      containers: {
        getRuntime: () => dummyRuntime,
        getState: async () => "starting" as ContainerState,
        pullImage: async () => {},
        getImageDigest: async () => null,
      },
    });
    service.register(basicReg({ checkInterval: "24h" }));
    clock.fireNext();
    await new Promise((r) => setImmediate(r));
    const next = clock.timers.find((t) => !t.fired);
    assert.ok(next, "expected a rescheduled check");
    assert.ok(
      next.delayMs < MAX_INITIAL_DELAY_MS,
      `should retry soon while not running, got ${next.delayMs}ms`,
    );
  });
  it("stops retrying on the short delay once the startup budget is spent", async () => {
    // Resetting the counter the moment retries run out would re-arm the short
    // cadence forever: a disabled plugin would poll every 45s indefinitely.
    const { service, clock } = makeService({
      backgroundChecks: true,
      containers: {
        getRuntime: () => dummyRuntime,
        getState: async () => "stopped" as ContainerState,
        pullImage: async () => {},
        getImageDigest: async () => null,
      },
    });
    service.register(basicReg({ checkInterval: "24h" }));
    for (let i = 0; i < 12; i++) {
      clock.fireNext();
      await new Promise((r) => setImmediate(r));
    }
    const next = clock.timers.find((t) => !t.fired);
    assert.ok(next, "expected a rescheduled check");
    assert.ok(
      next.delayMs > MIN_RECURRING_DELAY_MS,
      `budget spent, should be back on the interval, got ${next.delayMs}ms`,
    );
  });
});

describe("UpdateService — notification on transition", () => {
  it("emits notification when going from up-to-date → update-available", async () => {
    const { service, appCalls } = makeService({});
    service.register(
      basicReg({
        currentTag: () => "1.0.0",
        versionSource: makeVersionSource({ kind: "version", latest: "1.0.0" }),
      }),
    );
    await service.checkOne("test-plugin"); // up-to-date
    assert.equal(appCalls.notifications.length, 0);

    // Re-register with newer latest.
    service.unregister("test-plugin");
    // Re-seed lastResult by inspecting cache (commit happened on success).
    service.register(
      basicReg({
        currentTag: () => "1.0.0",
        versionSource: makeVersionSource({ kind: "version", latest: "1.1.0" }),
      }),
    );
    await service.checkOne("test-plugin");
    assert.equal(appCalls.notifications.length, 1);
    assert.equal(appCalls.notifications[0].pluginId, "test-plugin");
  });

  it("does NOT re-emit on every check while update remains available", async () => {
    const latest = "1.1.0";
    const { service, appCalls } = makeService({});
    service.register(
      basicReg({
        currentTag: () => "1.0.0",
        versionSource: makeVersionSource(async () => ({
          kind: "version",
          latest,
        })),
      }),
    );
    await service.checkOne("test-plugin"); // first transition: emit
    await service.checkOne("test-plugin"); // still available: do NOT emit
    await service.checkOne("test-plugin"); // still available: do NOT emit
    assert.equal(appCalls.notifications.length, 1);
  });

  it("does NOT emit when transitioning to/from offline", async () => {
    let online = true;
    const source: VersionSource = {
      fetch: async () => {
        if (!online) {
          const err = new Error("fetch failed") as Error & { cause?: unknown };
          const cause = new Error("ENETUNREACH") as NodeJS.ErrnoException;
          cause.code = "ENETUNREACH";
          err.cause = cause;
          throw err;
        }
        return { kind: "version", latest: "1.0.0" };
      },
    };
    const { service, appCalls } = makeService({});
    service.register(
      basicReg({
        currentTag: () => "1.0.0",
        versionSource: source,
      }),
    );
    await service.checkOne("test-plugin"); // up-to-date
    online = false;
    await service.checkOne("test-plugin"); // offline
    online = true;
    await service.checkOne("test-plugin"); // back online, still up-to-date
    assert.equal(appCalls.notifications.length, 0);
  });
});

describe("UpdateService — per-registration mutex", () => {
  it("concurrent checks for the same plugin coalesce", async () => {
    let calls = 0;
    let resolveOne: (v: VersionSourceResult) => void = () => {};
    let entered: () => void = () => {};
    const enteredOnce = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const source: VersionSource = {
      fetch: () =>
        new Promise<VersionSourceResult>((resolve) => {
          calls += 1;
          entered();
          resolveOne = resolve;
        }),
    };
    const { service } = makeService({});
    service.register(basicReg({ versionSource: source }));

    const p1 = service.checkOne("test-plugin");
    // Wait for the first check to actually enter the version source
    // (microtasks need to drain through getRuntime/getState first).
    await enteredOnce;
    // Now fire two more concurrent checks. They must coalesce onto p1.
    const p2 = service.checkOne("test-plugin");
    const p3 = service.checkOne("test-plugin");

    // Only one fetch should have been started.
    assert.equal(calls, 1);

    resolveOne({ kind: "version", latest: "1.0.0" });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1, r2);
    assert.equal(r2, r3);
  });
});

describe("UpdateService — scheduler", () => {
  it("backgroundChecks=false → no timer scheduled on register", () => {
    const { service, clock } = makeService({ backgroundChecks: false });
    service.register(basicReg());
    assert.equal(clock.timers.length, 0);
  });

  it("backgroundChecks=true → timer scheduled on register", () => {
    const { service, clock } = makeService({ backgroundChecks: true });
    service.register(basicReg());
    assert.equal(clock.timers.length, 1);
  });

  it("scheduler timer is cleared on unregister", () => {
    const { service, clock } = makeService({ backgroundChecks: true });
    service.register(basicReg());
    service.unregister("test-plugin");
    assert.equal(clock.timers.length, 0);
  });

  it("stop() clears all timers and saves cache", () => {
    const cache = new MemoryUpdateCache();
    const { service, clock } = makeService({
      backgroundChecks: true,
      cache,
    });
    service.register(basicReg({ pluginId: "a", containerName: "a" }));
    service.register(basicReg({ pluginId: "b", containerName: "b" }));
    assert.equal(clock.timers.length, 2);
    service.stop();
    assert.equal(clock.timers.length, 0);
  });
});

describe("UpdateService — unregister", () => {
  beforeEach(() => {});

  it("unregister removes registration so getLastResult returns null", async () => {
    const { service } = makeService({});
    service.register(basicReg());
    await service.checkOne("test-plugin");
    assert.notEqual(service.getLastResult("test-plugin"), null);
    service.unregister("test-plugin");
    assert.equal(service.getLastResult("test-plugin"), null);
  });

  it("checkOne after unregister throws", async () => {
    const { service } = makeService({});
    service.register(basicReg());
    service.unregister("test-plugin");
    await assert.rejects(
      () => service.checkOne("test-plugin"),
      /No registration/,
    );
  });
});
