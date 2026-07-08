import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PruneScheduler,
  FilePruneStateStore,
  MemoryPruneStateStore,
  MAX_TIMER_CHUNK_MS,
  type PruneClock,
} from "../pruneScheduler.js";

// ---------- test doubles ----------

interface FakeTimer {
  fn: () => void;
  delayMs: number;
  cleared: boolean;
  fired: boolean;
}

class FakeClock implements PruneClock {
  current = 1_000_000_000;
  timers: FakeTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimer(fn: () => void, delayMs: number): unknown {
    const timer: FakeTimer = { fn, delayMs, cleared: false, fired: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimer(handle: unknown): void {
    (handle as FakeTimer).cleared = true;
  }

  get pending(): FakeTimer | undefined {
    return this.timers.find((t) => !t.fired && !t.cleared);
  }

  /** Fire the next pending timer, advancing the clock by its delay. */
  fireNext(): void {
    const next = this.pending;
    assert.ok(next, "expected a pending timer");
    this.current += next.delayMs;
    next.fired = true;
    next.fn();
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Fire chained timers (chunked waits) until `run` has been invoked. */
async function advanceUntilRun(
  clock: FakeClock,
  runs: unknown[],
): Promise<number> {
  const start = clock.current;
  const before = runs.length;
  while (runs.length === before) {
    clock.fireNext();
    await settle();
  }
  return clock.current - start;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY = 5 * 60 * 1000;

function makeScheduler(opts: {
  clock: FakeClock;
  store?: MemoryPruneStateStore;
  run?: () => Promise<void>;
  intervalMs?: number;
  maxTimerChunkMs?: number;
}) {
  const store = opts.store ?? new MemoryPruneStateStore();
  const runs: number[] = [];
  const scheduler = new PruneScheduler({
    intervalMs: opts.intervalMs ?? WEEK,
    store,
    clock: opts.clock,
    startupDelayMs: STARTUP_DELAY,
    maxTimerChunkMs: opts.maxTimerChunkMs,
    run:
      opts.run ??
      (async () => {
        runs.push(opts.clock.current);
      }),
  });
  return { scheduler, store, runs };
}

describe("PruneScheduler", () => {
  it("never run: fires after the startup delay and records the run", async () => {
    const clock = new FakeClock();
    const { scheduler, store, runs } = makeScheduler({ clock });
    scheduler.start();

    assert.equal(clock.pending?.delayMs, STARTUP_DELAY);
    clock.fireNext();
    await settle();

    assert.equal(runs.length, 1);
    assert.equal(store.load(), clock.current);
  });

  it("recent last run: waits out the remaining interval, not the startup delay", async () => {
    const clock = new FakeClock();
    const store = new MemoryPruneStateStore();
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    store.save(clock.current - twoDays);
    const { scheduler, runs } = makeScheduler({ clock, store });
    scheduler.start();

    const elapsed = await advanceUntilRun(clock, runs);
    assert.equal(elapsed, WEEK - twoDays);
  });

  it("overdue last run: fires after the startup delay", async () => {
    const clock = new FakeClock();
    const store = new MemoryPruneStateStore();
    store.save(clock.current - 2 * WEEK);
    const { scheduler, runs } = makeScheduler({ clock, store });
    scheduler.start();

    assert.equal(clock.pending?.delayMs, STARTUP_DELAY);
    clock.fireNext();
    await settle();
    assert.equal(runs.length, 1);
  });

  it("schedules the next run one interval after a completed run", async () => {
    const clock = new FakeClock();
    const { scheduler, runs } = makeScheduler({ clock });
    scheduler.start();
    clock.fireNext();
    await settle();

    const elapsed = await advanceUntilRun(clock, runs);
    assert.equal(elapsed, WEEK);
    assert.equal(runs.length, 2);
  });

  it("failed run: leaves the last-run timestamp unset and retries next interval", async () => {
    const clock = new FakeClock();
    const store = new MemoryPruneStateStore();
    const attempts: number[] = [];
    const { scheduler } = makeScheduler({
      clock,
      store,
      run: async () => {
        attempts.push(clock.current);
        throw new Error("boom");
      },
    });
    scheduler.start();
    clock.fireNext();
    await settle();

    assert.equal(attempts.length, 1);
    assert.equal(store.load(), null);

    const elapsed = await advanceUntilRun(clock, attempts);
    assert.equal(elapsed, WEEK);
  });

  it("clock moved backwards: re-anchors instead of waiting out a future due time", async () => {
    const clock = new FakeClock();
    const store = new MemoryPruneStateStore();
    store.save(clock.current + 365 * 24 * 60 * 60 * 1000);
    const { scheduler, runs } = makeScheduler({ clock, store });
    scheduler.start();

    assert.equal(store.load(), clock.current);
    const elapsed = await advanceUntilRun(clock, runs);
    assert.equal(elapsed, WEEK);
  });

  it("chunks long waits below the timer ceiling", async () => {
    const clock = new FakeClock();
    const month = 30 * 24 * 60 * 60 * 1000;
    const store = new MemoryPruneStateStore();
    store.save(clock.current);
    const { scheduler, runs } = makeScheduler({
      clock,
      store,
      intervalMs: month,
    });
    scheduler.start();

    const elapsed = await advanceUntilRun(clock, runs);
    assert.equal(elapsed, month);
    for (const t of clock.timers) {
      assert.ok(t.delayMs <= MAX_TIMER_CHUNK_MS);
      assert.ok(t.delayMs < 2 ** 31);
    }
    assert.ok(clock.timers.length > 1, "expected chunked waits");
  });

  it("stop() cancels the pending timer", () => {
    const clock = new FakeClock();
    const { scheduler } = makeScheduler({ clock });
    scheduler.start();
    scheduler.stop();
    assert.equal(clock.pending, undefined);
  });

  it("stop() during an in-flight run prevents rescheduling", async () => {
    const clock = new FakeClock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { scheduler } = makeScheduler({
      clock,
      run: () => gate,
    });
    scheduler.start();
    clock.fireNext();
    scheduler.stop();
    release();
    await settle();
    assert.equal(clock.pending, undefined);
  });
});

describe("FilePruneStateStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prune-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", () => {
    const store = new FilePruneStateStore(join(dir, "prune-state.json"));
    assert.equal(store.load(), null);
  });

  it("round-trips a timestamp", () => {
    const path = join(dir, "prune-state.json");
    const store = new FilePruneStateStore(path);
    store.save(1234567890);
    assert.equal(store.load(), 1234567890);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(parsed.version, 1);
  });

  it("creates missing parent directories on save", () => {
    const store = new FilePruneStateStore(join(dir, "nested", "state.json"));
    store.save(42);
    assert.equal(store.load(), 42);
  });

  it("treats corrupt or wrong-shape files as never run", () => {
    const path = join(dir, "prune-state.json");
    writeFileSync(path, "not json", "utf-8");
    assert.equal(new FilePruneStateStore(path).load(), null);

    writeFileSync(path, JSON.stringify({ version: 2, lastRunAt: 5 }), "utf-8");
    assert.equal(new FilePruneStateStore(path).load(), null);

    writeFileSync(
      path,
      JSON.stringify({ version: 1, lastRunAt: "soon" }),
      "utf-8",
    );
    assert.equal(new FilePruneStateStore(path).load(), null);
  });
});
