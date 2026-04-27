export type RuntimeName = "podman" | "docker";
export type RuntimePreference = "auto" | RuntimeName;

export interface ContainerRuntimeInfo {
  runtime: RuntimeName;
  version: string;
  isPodmanDockerShim: boolean;
  /**
   * cgroup v2 controllers actually available to this runtime, e.g.
   * `["cpu", "memory", "pids"]` on a typical rootless podman setup
   * where cpuset is not delegated. `null` means "not probed" — treat
   * all controllers as available (used for docker, where we can't
   * easily query the per-runtime view).
   *
   * Used by `resources.ts` to silently drop ContainerResourceLimits
   * fields whose backing controller is missing, instead of letting
   * the runtime fail at container-create time.
   */
  cgroupControllers?: string[] | null;
}

export type ContainerState = "running" | "stopped" | "missing" | "no-runtime";

export interface ContainerConfig {
  image: string;
  tag: string;
  ports?: Record<string, string>;
  /**
   * Explicit volume mounts. Keys are container paths, values are either:
   *   - an absolute host path  (bind mount)
   *   - a Docker/Podman named volume (no leading `/`)
   * Example: `{ "/data": "/host/path" }` or `{ "/data": "my-volume" }`
   */
  volumes?: Record<string, string>;
  /**
   * Mount the SignalK data directory at this container path, regardless
   * of how SignalK itself is deployed (bare-metal, Docker with a named
   * volume, Docker with a bind mount).
   *
   * signalk-container resolves the appropriate source automatically:
   *   - bare-metal: binds `app.getDataDirPath()` directly
   *   - in Docker:  inspects the current container to find the named
   *     volume or host path backing `app.getDataDirPath()`, then
   *     mounts that same source into the managed container
   *
   * The mounted path in the managed container will correspond to the
   * root of `app.getDataDirPath()`.  Consumer plugins can compute paths
   * inside the mount as:
   *   `path.join(signalkDataMount, path.relative(app.getDataDirPath(), absPath))`
   *
   * Example:
   *   `signalkDataMount: "/signalk-data"` → FFmpeg can write to
   *   `/signalk-data/node_modules/my-plugin/public/out/stream.m3u8`
   */
  signalkDataMount?: string;
  env?: Record<string, string>;
  restart?: "no" | "unless-stopped" | "always";
  command?: string[];
  networkMode?: string;
  /**
   * Resource limits for the container. The consumer plugin sets a
   * sensible default here; the user can override per-container via
   * signalk-container's plugin config (see `containerOverrides`).
   * The user override is field-level merged on top of the plugin
   * default — set a field to `null` to explicitly remove the limit.
   */
  resources?: ContainerResourceLimits;
}

/**
 * Resource limits applied via podman/docker run flags. All fields
 * are optional; omitted means "no limit imposed by us" (the runtime
 * default applies). Use `null` in a user override to explicitly
 * remove a limit set by the plugin default.
 *
 * For semantics see:
 *   https://docs.podman.io/en/latest/markdown/podman-run.1.html#cpu-options
 *   https://docs.podman.io/en/latest/markdown/podman-run.1.html#memory-options
 */
export interface ContainerResourceLimits {
  /** Hard CPU cap (CFS quota). e.g. 1.5 = 1.5 cores. */
  cpus?: number | null;
  /** Soft CPU weight under contention. Default 1024. */
  cpuShares?: number | null;
  /** Pin to specific cores. e.g. "0,1" or "1-3". */
  cpusetCpus?: string | null;
  /** Hard memory cap, e.g. "512m", "2g". */
  memory?: string | null;
  /**
   * Total memory + swap. Set equal to `memory` to disable swap entirely.
   * Recommended for predictable behavior.
   */
  memorySwap?: string | null;
  /** Soft floor — kernel reclaims first from containers above this. */
  memoryReservation?: string | null;
  /** Process/thread cap to bound runaway thread leaks. */
  pidsLimit?: number | null;
  /** OOM score adjustment, -1000..1000. Higher = killed first. */
  oomScoreAdj?: number | null;
}

export interface ContainerInfo {
  name: string;
  image: string;
  state: ContainerState;
  created: string;
  ports: string[];
  managedBy: string;
}

export interface ContainerJobConfig {
  image: string;
  command: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  timeout?: number;
  onProgress?: (msg: string) => void;
  label?: string;
}

export type ContainerJobStatus =
  | "pending"
  | "pulling"
  | "running"
  | "completed"
  | "failed";

export interface ContainerJobResult {
  id: string;
  status: ContainerJobStatus;
  image: string;
  command: string[];
  label?: string;
  exitCode?: number;
  log: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  runtime?: RuntimeName;
}

export interface PruneResult {
  imagesRemoved: number;
  spaceReclaimed: string;
}

export interface HealthCheckOptions {
  healthCheck?: () => Promise<boolean>;
  onUnhealthy?: (name: string, error: string) => void;
}

export interface ContainerManagerApi {
  getRuntime(): ContainerRuntimeInfo | null;
  pullImage(image: string, onProgress?: (msg: string) => void): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  /**
   * Return the local image digest (sha256 ID) for an image reference or
   * container name, or null if not present. Used by the update detection
   * service for floating-tag drift checks.
   */
  getImageDigest(imageOrContainer: string): Promise<string | null>;
  /**
   * Apply new resource limits to a running container. Tries the
   * runtime's live `update` command first (no downtime); falls back
   * to stop+remove+ensureRunning if the runtime can't apply them
   * live (e.g. cpuset on some kernels). The container's effective
   * limits become the field-level merge of `limits` on top of the
   * config last passed to `ensureRunning`.
   */
  updateResources(
    name: string,
    limits: ContainerResourceLimits,
  ): Promise<UpdateResourcesResult>;
  /**
   * Return the currently effective resource limits for a managed
   * container, merging plugin defaults and user overrides. Returns
   * an empty object if the container has no limits or doesn't exist.
   */
  getResources(name: string): ContainerResourceLimits;
  ensureRunning(
    name: string,
    config: ContainerConfig,
    options?: HealthCheckOptions,
  ): Promise<void>;
  /**
   * Resolve the source (named volume or host path) that backs
   * `app.getDataDirPath()` in the current deployment.  The return value
   * is what signalk-container uses internally when a ContainerConfig
   * carries `signalkDataMount`; expose it here so consumer plugins can
   * log or inspect the resolved value if needed.
   *
   * Returns null if the runtime is not yet initialised.
   */
  resolveSignalkDataMount(): Promise<string | null>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  getState(name: string): Promise<ContainerState>;
  runJob(config: ContainerJobConfig): Promise<ContainerJobResult>;
  prune(): Promise<PruneResult>;
  listContainers(): Promise<ContainerInfo[]>;
  ensureNetwork(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  connectToNetwork(containerName: string, networkName: string): Promise<void>;
  execInContainer(
    name: string,
    command: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  disconnectFromNetwork(
    containerName: string,
    networkName: string,
  ): Promise<void>;
  /**
   * Centralized container-image update detection. Consumer plugins
   * register their containers and the service handles version checking,
   * scheduling, caching, and offline-tolerance.
   * See doc/plugin-developer-guide.md "Update detection" for usage.
   */
  updates: import("./updates/types").UpdateServiceApi;
}

export interface PluginConfig {
  runtime: RuntimePreference;
  pruneSchedule: "off" | "weekly" | "monthly";
  maxConcurrentJobs: number;
  updateCheckInterval?: string;
  backgroundUpdateChecks?: boolean;
  /**
   * Per-container user overrides for resource limits, keyed by
   * container name (without `sk-` prefix). Field-level merged on top
   * of the plugin's default. Use `null` to explicitly remove a limit
   * set by the plugin.
   */
  containerOverrides?: Record<string, ContainerResourceLimits>;
}

/**
 * Result of an updateResources() call. `live` means cgroup limits
 * were applied without restart; `recreated` means we fell back to
 * stop+remove+create because the runtime refused the live update.
 */
export interface UpdateResourcesResult {
  method: "live" | "recreated";
  warnings?: string[];
}
