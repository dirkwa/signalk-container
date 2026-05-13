import type { ContainerRuntimeInfo } from "../types.js";

/**
 * Result returned by a VersionSource.fetch() call. Either a parsed
 * version string (semver-ish), a remote digest, or an error.
 */
export type VersionSourceResult =
  | { kind: "version"; latest: string; metadata?: Record<string, unknown> }
  | { kind: "digest"; remoteDigest: string }
  | { kind: "error"; error: string };

/**
 * Pluggable strategy for finding "the latest available version" of an
 * image. Implementations live in src/updates/sources.ts (githubReleases,
 * dockerHubTags). Consumer plugins do not implement these directly.
 */
export interface VersionSource {
  fetch(runtime: ContainerRuntimeInfo): Promise<VersionSourceResult>;
}

/**
 * What a consumer plugin passes to containers.updates.register().
 *
 * The service auto-detects whether the running tag is semver, floating
 * (latest/main/master/etc.) or unknown, and picks the right strategy
 * automatically. Consumers do NOT need to choose between version
 * comparison and digest drift.
 */
export interface UpdateRegistration {
  /** Plugin ID, e.g. "signalk-questdb". Used as the registration key. */
  pluginId: string;
  /** Container name as passed to ensureRunning(). */
  containerName: string;
  /** Image repo (no tag), e.g. "questdb/questdb". */
  image: string;
  /**
   * Function returning the currently-pinned tag from live config.
   * MUST be a function (not a captured value) so the user can edit
   * the version in plugin options without re-registering.
   */
  currentTag: () => string;
  /** Where to look for "latest" — typically githubReleases(repo). */
  versionSource: VersionSource;
  /**
   * Optional: query the running container directly for its version
   * (e.g. SQL `SELECT build()` for QuestDB, /api/health for Grafana).
   * If present and returns non-null, takes precedence over currentTag()
   * for the comparison.
   */
  currentVersion?: () => Promise<string | null>;
  /** Check interval, e.g. "24h", "12h", "1h". Default: "24h". Min: "1h". */
  checkInterval?: string;
}

export type UpdateReason =
  | "newer-version"
  | "digest-drift"
  | "older-than-pinned"
  | "up-to-date"
  | "offline"
  | "unknown"
  | "error";

export type TagKind = "semver" | "floating" | "unknown";

/**
 * Result of a single update check. Always returned by checkOne(),
 * even when offline (in which case `reason: "offline"` and `fromCache: true`).
 */
export interface UpdateCheckResult {
  pluginId: string;
  containerName: string;
  /** What the container is currently pinned to. */
  runningTag: string;
  /** How the service classified runningTag. */
  tagKind: TagKind;
  /** Resolved semver if tagKind === "semver", else null. */
  currentVersion: string | null;
  /**
   * Newest stable version from the version source.
   * Always populated when the version source returned data, even if
   * the user is pinned to a floating tag — used for informational UI
   * ("you're on :main, latest stable is 9.2.0").
   */
  latestVersion: string | null;
  updateAvailable: boolean;
  reason: UpdateReason;
  error?: string;
  /** ISO timestamp when this result was produced. */
  checkedAt: string;
  /**
   * ISO timestamp of the last successful network fetch.
   * null when the registration has never had a successful check.
   */
  lastSuccessfulCheckAt: string | null;
  /**
   * True when reason === "offline" and we returned cached data
   * from a prior successful check.
   */
  fromCache: boolean;
}

/**
 * Public API exposed to consumer plugins via
 * containers.updates.register(...) etc.
 */
export interface UpdateServiceApi {
  register(reg: UpdateRegistration): void;
  unregister(pluginId: string): void;
  checkOne(pluginId: string): Promise<UpdateCheckResult>;
  checkAll(): Promise<UpdateCheckResult[]>;
  getLastResult(pluginId: string): UpdateCheckResult | null;
  /** Built-in version source factories — convenience for consumers. */
  sources: {
    githubReleases(
      repo: string,
      options?: { allowPrerelease?: boolean; tagPrefix?: string },
    ): VersionSource;
    dockerHubTags(
      image: string,
      options?: { filter?: (tag: string) => boolean },
    ): VersionSource;
  };
}

/**
 * Persistent cache shape stored at ${dataDir}/updates-cache.json.
 */
export interface UpdateCacheFile {
  version: 1;
  results: Record<string, UpdateCheckResult>;
}
