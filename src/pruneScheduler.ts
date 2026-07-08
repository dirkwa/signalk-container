import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Persistent record of the last successful prune run. Survives Signal K
 * restarts so the weekly/monthly cadence is measured in wall-clock time,
 * not continuous process uptime — a dev box that restarts the server
 * daily still prunes once the interval has elapsed.
 */
export interface PruneStateStore {
  /** Epoch ms of the last successful run, or null if never run. */
  load(): number | null;
  save(lastRunAt: number): void;
}

interface PruneStateFile {
  version: 1;
  lastRunAt: number;
}

/**
 * File-backed store. Failures are non-fatal — an unreadable or corrupt
 * state file means the next prune is treated as due (the run itself is
 * idempotent and cheap), and a failed write just repeats that on the
 * next start.
 */
export class FilePruneStateStore implements PruneStateStore {
  constructor(
    private readonly path: string,
    private readonly debug: (msg: string) => void = () => {},
  ) {}

  load(): number | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(
        readFileSync(this.path, "utf-8"),
      ) as PruneStateFile;
      if (
        !parsed ||
        parsed.version !== 1 ||
        typeof parsed.lastRunAt !== "number" ||
        !Number.isFinite(parsed.lastRunAt)
      ) {
        this.debug(`[prune] state file shape invalid, treating as never run`);
        return null;
      }
      return parsed.lastRunAt;
    } catch (err) {
      this.debug(
        `[prune] state file unreadable (${err instanceof Error ? err.message : err}), treating as never run`,
      );
      return null;
    }
  }

  save(lastRunAt: number): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const file: PruneStateFile = { version: 1, lastRunAt };
      writeFileSync(this.path, JSON.stringify(file, null, 2), "utf-8");
    } catch (err) {
      this.debug(
        `[prune] state write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/** In-memory store for tests. */
export class MemoryPruneStateStore implements PruneStateStore {
  private lastRunAt: number | null = null;

  load(): number | null {
    return this.lastRunAt;
  }

  save(lastRunAt: number): void {
    this.lastRunAt = lastRunAt;
  }
}

export interface PruneClock {
  now(): number;
  setTimer(fn: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: PruneClock = {
  now: () => Date.now(),
  setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Grace period before an overdue (or never-run) prune fires after
 * startup, so image cleanup doesn't compete with runtime detection,
 * update checks, and consumer-plugin container starts happening in the
 * same boot window.
 */
export const STARTUP_PRUNE_DELAY_MS = 5 * 60 * 1000;

/**
 * Long waits are chained in chunks instead of a single timer. This keeps
 * every delay far below Node's 2^31-1 ms setTimeout ceiling (a 30-day
 * "monthly" interval overflows it and would fire immediately) and
 * re-anchors the due time against the wall clock, which drifts from
 * timer time across system sleep.
 */
export const MAX_TIMER_CHUNK_MS = 6 * 60 * 60 * 1000;

const MS_PER_MINUTE = 60 * 1000;

export interface PruneSchedulerOptions {
  intervalMs: number;
  /**
   * The prune work. A resolved run records a new last-run timestamp; a
   * rejected run does not, so it is retried one interval later (and
   * shortly after the next startup, since it stays overdue).
   */
  run: () => Promise<void>;
  store: PruneStateStore;
  clock?: PruneClock;
  debug?: (msg: string) => void;
  startupDelayMs?: number;
  maxTimerChunkMs?: number;
}

/**
 * Schedules the prune/reap pass against wall-clock due times persisted
 * in a PruneStateStore. `start()` computes the next due time from the
 * stored last run — running shortly after startup when overdue — and
 * each completed run schedules the next one interval later.
 */
export class PruneScheduler {
  private readonly intervalMs: number;
  private readonly run: () => Promise<void>;
  private readonly store: PruneStateStore;
  private readonly clock: PruneClock;
  private readonly debug: (msg: string) => void;
  private readonly startupDelayMs: number;
  private readonly maxTimerChunkMs: number;
  private timer: unknown = null;
  private stopped = false;

  constructor(opts: PruneSchedulerOptions) {
    this.intervalMs = opts.intervalMs;
    this.run = opts.run;
    this.store = opts.store;
    this.clock = opts.clock ?? realClock;
    this.debug = opts.debug ?? (() => {});
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_PRUNE_DELAY_MS;
    this.maxTimerChunkMs = opts.maxTimerChunkMs ?? MAX_TIMER_CHUNK_MS;
  }

  start(): void {
    const now = this.clock.now();
    let lastRunAt = this.store.load();
    if (lastRunAt !== null && lastRunAt > now) {
      // Wall clock moved backwards since the last run (boats without an
      // RTC boot in the past until NTP catches up). Re-anchor to now
      // rather than waiting out a due time that is arbitrarily far off.
      this.debug(`[prune] last run is in the future, re-anchoring to now`);
      lastRunAt = now;
      this.store.save(lastRunAt);
    }
    const dueAt = lastRunAt === null ? now : lastRunAt + this.intervalMs;
    const runAt = Math.max(dueAt, now + this.startupDelayMs);
    this.debug(
      `[prune] next run in ${Math.round((runAt - now) / MS_PER_MINUTE)} minutes`,
    );
    this.scheduleAt(runAt);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private scheduleAt(dueAt: number): void {
    if (this.stopped) return;
    const delay = dueAt - this.clock.now();
    if (delay > this.maxTimerChunkMs) {
      this.timer = this.clock.setTimer(
        () => this.scheduleAt(dueAt),
        this.maxTimerChunkMs,
      );
      return;
    }
    this.timer = this.clock.setTimer(
      () => void this.fire(),
      Math.max(0, delay),
    );
  }

  private async fire(): Promise<void> {
    this.timer = null;
    try {
      await this.run();
      this.store.save(this.clock.now());
    } catch (err) {
      this.debug(
        `[prune] run failed, will retry next interval: ${err instanceof Error ? err.message : err}`,
      );
    }
    this.scheduleAt(this.clock.now() + this.intervalMs);
  }
}
