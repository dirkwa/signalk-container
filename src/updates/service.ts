import type { ContainerRuntimeInfo, ContainerState } from "../types.js";
import type {
  DockerHubTagsSourceOptions,
  GithubReleasesSourceOptions,
  TagKind,
  UpdateCheckResult,
  UpdateRegistration,
  UpdateServiceApi,
  VersionSourceResult,
} from "./types.js";
import { compareVersions } from "./semver.js";
import { classifyTag } from "./tagClassifier.js";
import { isOfflineError } from "./offline.js";
import type { UpdateCache } from "./cache.js";
import { dockerHubTags, githubReleases } from "./sources.js";

export interface AppDeps {
  debug: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  /** Emit a Signal K notification (notifications.plugins.<id>.updateAvailable). */
  handleMessage?: (pluginId: string, delta: unknown) => void;
}

export interface ContainerDeps {
  getRuntime(): ContainerRuntimeInfo | null;
  getState(name: string): Promise<ContainerState>;
  pullImage(image: string): Promise<void>;
  /** Returns local image digest (image ID) for an image:tag or container name. */
  getImageDigest(imageOrContainer: string): Promise<string | null>;
}

export interface ClockDeps {
  now(): number;
  /** Schedule fn to run after delayMs. Returns an opaque handle. */
  setTimer(fn: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface UpdateServiceOptions {
  app: AppDeps;
  containers: ContainerDeps;
  clock: ClockDeps;
  cache: UpdateCache;
  /** Default check interval if registration doesn't specify. */
  defaultCheckIntervalMs?: number;
  /** Run scheduled checks at all? Manual checks always work. */
  backgroundChecks?: boolean;
  /** Number of consecutive REAL errors before auto-unregister. */
  errorStrikeLimit?: number;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1h
// The first check after registration runs on its own short delay rather than a
// full interval. Registration happens during container startup, so the
// container-state gate below usually reports not-yet-running on the very first
// attempt; waiting a whole interval to retry leaves a restored cache entry on
// screen for up to a day. Not floored by MIN_INTERVAL_MS — that floor exists to
// keep the *recurring* poll off the registry, and this fires once per
// registration.
const FIRST_CHECK_DELAY_MS = 45 * 1000;
// An "unknown" result means the check never ran — no runtime yet, or the
// container is not running. On a first boot that pulls the image over a slow
// link this can outlast the delay above, and falling straight back to the
// recurring interval would leave the panel wrong for up to a day. Retry on the
// short delay a bounded number of times before settling into the normal poll.
const MAX_STARTUP_RETRIES = 10;
const DEFAULT_STRIKE_LIMIT = 5;

interface RegistrationState {
  reg: UpdateRegistration;
  intervalMs: number;
  timer: unknown | null;
  /** A check currently in flight for this registration. */
  inFlight: Promise<UpdateCheckResult> | null;
  /** Consecutive REAL errors (offline doesn't count). */
  consecutiveErrors: number;
  /** Short-delay retries used while the first check keeps returning "unknown". */
  startupRetries: number;
  /** Last result, used for transition detection. */
  lastResult: UpdateCheckResult | null;
}

/**
 * Centralized update detection service. Owned by signalk-container,
 * exposed to consumer plugins via containers.updates.
 */
export class UpdateService implements UpdateServiceApi {
  private readonly registrations = new Map<string, RegistrationState>();
  private readonly cachedResults: Record<string, UpdateCheckResult>;
  private readonly defaultIntervalMs: number;
  private readonly backgroundChecks: boolean;
  private readonly strikeLimit: number;
  private stopped = false;

  readonly sources = {
    githubReleases: (repo: string, options?: GithubReleasesSourceOptions) =>
      githubReleases(repo, options),
    dockerHubTags: (image: string, options?: DockerHubTagsSourceOptions) =>
      dockerHubTags(image, options),
  };

  constructor(private readonly opts: UpdateServiceOptions) {
    this.cachedResults = opts.cache.load();
    this.defaultIntervalMs = opts.defaultCheckIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.backgroundChecks = opts.backgroundChecks ?? true;
    this.strikeLimit = opts.errorStrikeLimit ?? DEFAULT_STRIKE_LIMIT;
  }

  register(reg: UpdateRegistration): void {
    if (this.stopped) return;
    if (!reg.pluginId || !reg.containerName || !reg.image || !reg.currentTag) {
      this.opts.app.error(
        `[updates] register() called with invalid registration: ${JSON.stringify({ pluginId: reg.pluginId, containerName: reg.containerName, image: reg.image })}`,
      );
      return;
    }

    // Replace any prior registration for this plugin.
    this.unregister(reg.pluginId);

    const intervalMs = Math.max(
      MIN_INTERVAL_MS,
      parseDuration(reg.checkInterval) ?? this.defaultIntervalMs,
    );

    // Seed lastResult from persisted cache so the first UI poll after
    // a server restart returns the cached value, not "unknown" — but only
    // when that verdict still describes the container that is actually
    // running. A cached "0.6.10 -> 1.0.0 available" restored onto a container
    // now running 1.0.0 renders as "update available" for a version already
    // installed, and survives every restart until a real check happens to
    // land. Comparing against the live tag keeps the offshore case (reboot on
    // the same version, no uplink) while dropping a verdict that has been
    // overtaken by an update.
    const persisted = this.cachedResults[reg.pluginId] ?? null;
    const liveTag = safeCallTag(reg);
    const stale = persisted !== null && persisted.runningTag !== liveTag;
    if (stale) {
      // Evict rather than just skip the seed: handleOffline() and
      // buildUnknownResult() read cachedResults directly, so a merely
      // unseeded entry would resurface through them on the first offline or
      // container-not-running check — the same wrong verdict by another path.
      this.opts.app.debug(
        `[updates] dropping cached result for ${reg.pluginId}: it describes ${persisted.runningTag}, running ${liveTag}`,
      );
      delete this.cachedResults[reg.pluginId];
      this.opts.cache.save(this.cachedResults);
    }
    const cached = stale ? null : persisted;

    const state: RegistrationState = {
      reg,
      intervalMs,
      timer: null,
      inFlight: null,
      consecutiveErrors: 0,
      startupRetries: 0,
      lastResult: cached,
    };
    this.registrations.set(reg.pluginId, state);

    this.opts.app.debug(
      `[updates] registered ${reg.pluginId} (interval ${intervalMs / 1000}s)`,
    );

    if (this.backgroundChecks) {
      // First check soon, then on the normal interval.
      this.scheduleNext(state, true);
    }
  }

  unregister(pluginId: string): void {
    const state = this.registrations.get(pluginId);
    if (!state) return;
    if (state.timer !== null) {
      this.opts.clock.clearTimer(state.timer);
      state.timer = null;
    }
    this.registrations.delete(pluginId);
    this.opts.app.debug(`[updates] unregistered ${pluginId}`);
  }

  getLastResult(pluginId: string): UpdateCheckResult | null {
    return this.registrations.get(pluginId)?.lastResult ?? null;
  }

  /** List all currently-registered plugin IDs. */
  listRegistrations(): string[] {
    return Array.from(this.registrations.keys());
  }

  async checkOne(pluginId: string): Promise<UpdateCheckResult> {
    const state = this.registrations.get(pluginId);
    if (!state) {
      throw new Error(`No registration for plugin ${pluginId}`);
    }
    // Per-registration mutex: coalesce concurrent checks.
    if (state.inFlight) return state.inFlight;
    state.inFlight = this.runCheck(state).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  }

  async checkAll(): Promise<UpdateCheckResult[]> {
    return Promise.all(
      Array.from(this.registrations.keys()).map((id) => this.checkOne(id)),
    );
  }

  /**
   * Stop all timers and flush the cache. Called from the plugin's stop().
   */
  stop(): void {
    this.stopped = true;
    for (const state of this.registrations.values()) {
      if (state.timer !== null) {
        this.opts.clock.clearTimer(state.timer);
        state.timer = null;
      }
    }
    this.opts.cache.save(this.cachedResults);
  }

  // ---------- internals ----------

  private scheduleNext(state: RegistrationState, first = false): void {
    if (this.stopped || !this.backgroundChecks) return;
    // ±10% jitter so multiple plugins don't all hit the API simultaneously.
    const jitter = state.intervalMs * 0.1 * (Math.random() * 2 - 1);
    const delay = first
      ? FIRST_CHECK_DELAY_MS
      : Math.max(MIN_INTERVAL_MS, state.intervalMs + jitter);
    state.timer = this.opts.clock.setTimer(() => {
      this.runCheck(state)
        .catch((err) => {
          // Should never reach here — runCheck handles its own errors.
          this.opts.app.error(
            `[updates] scheduled check for ${state.reg.pluginId} threw: ${err}`,
          );
        })
        .finally(() => {
          if (!this.registrations.has(state.reg.pluginId)) return;
          // "unknown" means the check never ran. Keep the short cadence until
          // the container is actually up, then fall back to the interval.
          const retry =
            state.lastResult?.reason === "unknown" &&
            state.startupRetries < MAX_STARTUP_RETRIES;
          state.startupRetries = retry ? state.startupRetries + 1 : 0;
          this.scheduleNext(state, retry);
        });
    }, delay);
  }

  private async runCheck(state: RegistrationState): Promise<UpdateCheckResult> {
    const { reg } = state;
    const runningTag = safeCallTag(reg);
    const tagKind = classifyTag(runningTag);
    const checkedAt = isoNow(this.opts.clock);

    // Wait for runtime to be ready. If not yet, return a cached or
    // "unknown" result without erroring.
    const runtime = this.opts.containers.getRuntime();
    if (!runtime) {
      return this.buildUnknownResult(state, runningTag, tagKind, checkedAt, {
        reason: "unknown",
        error: "Container runtime not yet ready",
      });
    }

    // Container-state gate: don't bother checking if the container
    // is stopped or missing — the consumer plugin may be temporarily
    // disabled, that's fine.
    let containerState: ContainerState;
    try {
      containerState = await this.opts.containers.getState(reg.containerName);
    } catch (err) {
      // getState shouldn't throw, but if it does treat as "unknown".
      return this.buildUnknownResult(state, runningTag, tagKind, checkedAt, {
        reason: "unknown",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (containerState !== "running") {
      return this.buildUnknownResult(state, runningTag, tagKind, checkedAt, {
        reason: "unknown",
      });
    }

    // Resolve currentVersion: prefer the consumer's callback (live
    // self-report) over the configured tag.
    let currentVersion: string | null = null;
    if (reg.currentVersion) {
      try {
        currentVersion = await reg.currentVersion();
      } catch (err) {
        // Real error (not offline) from consumer's callback.
        return this.handleRealError(
          state,
          runningTag,
          tagKind,
          checkedAt,
          `currentVersion callback threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (currentVersion === null && tagKind === "semver") {
      currentVersion = runningTag.replace(/^v/i, "");
    }

    // Fetch latest from version source.
    let sourceResult: VersionSourceResult;
    try {
      sourceResult = await reg.versionSource.fetch(runtime);
    } catch (err) {
      if (isOfflineError(err)) {
        return this.handleOffline(state, runningTag, tagKind, checkedAt);
      }
      return this.handleRealError(
        state,
        runningTag,
        tagKind,
        checkedAt,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (sourceResult.kind === "error") {
      // Source returned a structured error (HTTP non-2xx, parse failure).
      // These are "real" errors — count toward strikes.
      return this.handleRealError(
        state,
        runningTag,
        tagKind,
        checkedAt,
        sourceResult.error,
      );
    }

    const latestVersion =
      sourceResult.kind === "version" ? sourceResult.latest : null;

    // ---- Strategy matrix ----
    let updateAvailable = false;
    let reason: UpdateCheckResult["reason"] = "up-to-date";

    if (tagKind === "semver") {
      if (currentVersion && latestVersion) {
        const cmp = compareVersions(currentVersion, latestVersion);
        if (cmp < 0) {
          updateAvailable = true;
          reason = "newer-version";
        } else if (cmp > 0) {
          // User is ahead of latest stable (perhaps prerelease pinned).
          // Not an "update available" — but the UI can show the gap.
          reason = "up-to-date";
        }
      }
    } else {
      // Floating or unknown tag — digest drift detection.
      // We need both: the local container's image digest, and the
      // remote registry's digest for the same tag. To get the remote
      // digest we have to pull the image (cheap if it hasn't changed).
      const fullImage = `${reg.image}:${runningTag}`;
      try {
        await this.opts.containers.pullImage(fullImage);
      } catch (err) {
        if (isOfflineError(err)) {
          return this.handleOffline(state, runningTag, tagKind, checkedAt);
        }
        return this.handleRealError(
          state,
          runningTag,
          tagKind,
          checkedAt,
          `pullImage failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let remoteDigest: string | null;
      let localDigest: string | null;
      try {
        remoteDigest = await this.opts.containers.getImageDigest(fullImage);
        localDigest = await this.opts.containers.getImageDigest(
          reg.containerName,
        );
      } catch (err) {
        return this.handleRealError(
          state,
          runningTag,
          tagKind,
          checkedAt,
          `getImageDigest failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (remoteDigest && localDigest && remoteDigest !== localDigest) {
        updateAvailable = true;
        reason = "digest-drift";
      }
    }

    const result: UpdateCheckResult = {
      pluginId: reg.pluginId,
      containerName: reg.containerName,
      runningTag,
      tagKind,
      currentVersion,
      latestVersion,
      updateAvailable,
      reason,
      checkedAt,
      lastSuccessfulCheckAt: checkedAt,
      fromCache: false,
    };

    this.commitSuccess(state, result);
    return result;
  }

  private handleOffline(
    state: RegistrationState,
    runningTag: string,
    tagKind: TagKind,
    checkedAt: string,
  ): UpdateCheckResult {
    this.opts.app.debug(`[updates] offline for ${state.reg.pluginId}`);
    const cached = this.cachedResults[state.reg.pluginId];
    if (cached) {
      const result: UpdateCheckResult = {
        ...cached,
        runningTag, // current pin may differ from cached
        tagKind,
        checkedAt,
        reason: "offline",
        fromCache: true,
      };
      state.lastResult = result;
      // Do NOT increment consecutiveErrors — offline is not a real error.
      return result;
    }
    const result: UpdateCheckResult = {
      pluginId: state.reg.pluginId,
      containerName: state.reg.containerName,
      runningTag,
      tagKind,
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      reason: "offline",
      checkedAt,
      lastSuccessfulCheckAt: null,
      fromCache: false,
    };
    state.lastResult = result;
    return result;
  }

  private handleRealError(
    state: RegistrationState,
    runningTag: string,
    tagKind: TagKind,
    checkedAt: string,
    error: string,
  ): UpdateCheckResult {
    state.consecutiveErrors += 1;
    this.opts.app.error(
      `[updates] check failed for ${state.reg.pluginId} (strike ${state.consecutiveErrors}/${this.strikeLimit}): ${error}`,
    );

    if (state.consecutiveErrors >= this.strikeLimit) {
      this.opts.app.error(
        `[updates] auto-unregistering ${state.reg.pluginId} after ${this.strikeLimit} consecutive errors`,
      );
      this.unregister(state.reg.pluginId);
    }

    const cached = this.cachedResults[state.reg.pluginId];
    const result: UpdateCheckResult = {
      pluginId: state.reg.pluginId,
      containerName: state.reg.containerName,
      runningTag,
      tagKind,
      currentVersion: cached?.currentVersion ?? null,
      latestVersion: cached?.latestVersion ?? null,
      updateAvailable: false,
      reason: "error",
      error,
      checkedAt,
      lastSuccessfulCheckAt: cached?.lastSuccessfulCheckAt ?? null,
      fromCache: !!cached,
    };
    state.lastResult = result;
    return result;
  }

  private buildUnknownResult(
    state: RegistrationState,
    runningTag: string,
    tagKind: TagKind,
    checkedAt: string,
    extra: { reason: "unknown"; error?: string },
  ): UpdateCheckResult {
    const cached = this.cachedResults[state.reg.pluginId];
    const result: UpdateCheckResult = {
      pluginId: state.reg.pluginId,
      containerName: state.reg.containerName,
      runningTag,
      tagKind,
      currentVersion: null,
      latestVersion: cached?.latestVersion ?? null,
      updateAvailable: false,
      reason: extra.reason,
      error: extra.error,
      checkedAt,
      lastSuccessfulCheckAt: cached?.lastSuccessfulCheckAt ?? null,
      fromCache: !!cached,
    };
    state.lastResult = result;
    return result;
  }

  private commitSuccess(
    state: RegistrationState,
    result: UpdateCheckResult,
  ): void {
    state.consecutiveErrors = 0;
    const previous = state.lastResult;
    state.lastResult = result;
    this.cachedResults[state.reg.pluginId] = result;
    this.opts.cache.save(this.cachedResults);

    // Notification on transition: emit only when going from
    // not-update-available → update-available, never on offline transitions.
    const wasAvailable =
      previous?.updateAvailable === true && previous?.reason !== "offline";
    if (result.updateAvailable && !wasAvailable) {
      this.emitNotification(result);
    }
  }

  private emitNotification(result: UpdateCheckResult): void {
    if (!this.opts.app.handleMessage) return;
    const message =
      result.reason === "newer-version"
        ? `Update available: ${result.currentVersion} → ${result.latestVersion}`
        : `Container image rebuild available for ${result.runningTag}`;
    const delta = {
      updates: [
        {
          values: [
            {
              path: `notifications.plugins.${result.pluginId}.updateAvailable`,
              value: {
                state: "normal",
                method: ["visual"],
                message,
              },
            },
          ],
        },
      ],
    };
    try {
      this.opts.app.handleMessage(result.pluginId, delta);
    } catch (err) {
      this.opts.app.error(
        `[updates] failed to emit notification: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

// ---------- helpers ----------

function safeCallTag(reg: UpdateRegistration): string {
  try {
    return reg.currentTag() ?? "";
  } catch {
    return "";
  }
}

function isoNow(clock: ClockDeps): string {
  return new Date(clock.now()).toISOString();
}

/**
 * Parse "24h", "12h", "1h", "30m" → milliseconds. Returns null on parse fail.
 */
export function parseDuration(input: string | undefined): number | null {
  if (!input) return null;
  const m = input.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    case "d":
      return n * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}
