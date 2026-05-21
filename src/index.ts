import { IRouter } from "express";
import path from "node:path";
import {
  CleanupOrphansResult,
  ConsumerManifest,
  ContainerConfig,
  ContainerInfo,
  ContainerJobConfig,
  ContainerJobResult,
  ContainerManagerApi,
  ContainerResourceLimits,
  ContainerRuntimeInfo,
  ContainerState,
  DoctorApi,
  EnsureRunningOptions,
  HistoryEntry,
  ManifestApi,
  PluginConfig,
  PruneResult,
  ResolveResult,
  RuntimePreference,
  SelfDeploymentResult,
  UpdateResourcesResult,
  VolumeIssue,
} from "./types.js";
import {
  fieldsRequiringRecreateForUnset,
  filterUnsupportedLimits,
  mergeResourceLimits,
  minimizeOverride,
  resourceLimitsEqual,
  tryLiveUpdate,
} from "./resources.js";
import { detectRuntime, isContainerized } from "./runtime.js";
import {
  classifyVolumeSources,
  collectRecoveredVolumes,
  connectToNetwork,
  disconnectFromNetwork,
  ensureNetwork,
  ensureRunning,
  execInContainer,
  getActualPortBindings,
  getContainerLogs,
  getContainerState,
  getImageDigest,
  getLiveContainerDigest,
  getLiveResources,
  getRepoDigest,
  imageExists,
  listContainers,
  findSelfContainerId,
  parsePositiveIntQuery,
  pruneImages,
  pullImage,
  qualifyImage as qualifyImageForRuntime,
  removeContainer,
  removeNetwork,
  findAvailablePort,
  releaseReservedPort,
  resolveHostPath,
  resolveSignalkDataSource,
  resolveSignalkNetworks,
  safeInvokeContainerLog,
  safeInvokeVolumeIssue,
  startContainer,
  stopContainer,
  tailContainerLogs,
} from "./containers.js";
import { createLogStreamBroker, LogStreamBroker } from "./log-stream-broker.js";
import { runJob, cleanupOrphanedJobs } from "./jobs.js";
import { UpdateService } from "./updates/service.js";
import { FileUpdateCache } from "./updates/cache.js";
import { registerUpdateRoutes } from "./updates/routes.js";
import { DIGEST_RE, resolveImage } from "./manifest/resolver.js";
import { ManifestStore } from "./manifest/store.js";
import { imageRunsAsUser, selfDeployment } from "./doctor.js";

interface App {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
  getDataDirPath?: () => string;
  /**
   * SignalK server runtime config. `configPath` is the **top of the
   * SignalK installation config tree** (typically `~/.signalk/`).
   * Distinct from `app.getDataDirPath()` which SignalK rewrites
   * per-plugin to a sub-directory.  Used by `signalkConfigRootMount`.
   * Optional in this interface because the upstream `@signalk/server-api`
   * type doesn't declare it; the actual server runtime always provides it.
   */
  config?: {
    configPath?: string;
    [key: string]: unknown;
  };
  handleMessage?: (pluginId: string, delta: unknown) => void;
  /**
   * Persist the plugin's configuration to plugin-config-data/signalk-container.json.
   * Signal K server-api declares this; we optionally use it from updateResources()
   * to auto-save a new containerOverride so refreshes don't lose the user's edit.
   * Callback signature matches @signalk/server-api.
   */
  savePluginOptions?: (
    configuration: object,
    cb: (err: NodeJS.ErrnoException | null) => void,
  ) => void;
  [key: string]: unknown;
}

/**
 * SSE comment-frame heartbeat interval.  30s is comfortably below
 * common reverse-proxy idle-read timeouts (nginx default 60s) but
 * not so frequent that quiet streams pay a noticeable cost.
 */
const SSE_HEARTBEAT_MS = 30_000;

export default (app: App) => {
  let runtimeInfo: ContainerRuntimeInfo | null = null;
  let runtimePreference: RuntimePreference = "auto";
  let pruneTimer: NodeJS.Timeout | null = null;
  const healthTimers = new Map<string, NodeJS.Timeout>();
  let updateService: UpdateService | null = null;
  let manifestStore: ManifestStore | null = null;

  // Re-created on every start() so each plugin-lifecycle gets a fresh
  // promise — without this, whenReady() would resolve immediately on
  // any restart with the stale value from the prior run. Resolved by
  // start()'s IIFE once detectRuntime has settled (success or failure).
  // Consumers `await api.whenReady()` to replace the manual
  // "while (Date.now() < deadline && !getRuntime()) await sleep(1000)"
  // polling pattern. The resolver itself is a per-start local captured
  // by the IIFE — see start() — so overlapping start() calls (in
  // theory possible if SignalK ever re-enters) can't fire each
  // other's promises.
  let readyPromise = new Promise<void>(() => {
    // initial placeholder — replaced before whenReady() ever resolves
    // because start() reassigns readyPromise first thing.
  });

  /**
   * Per-container state for resource limit management:
   *   lastConfigs        — the most recent ContainerConfig passed to
   *                        ensureRunning(), used to recreate the
   *                        container when a live `update` fails.
   *   currentOverrides   — user overrides loaded from plugin config,
   *                        keyed by the unprefixed container name.
   *   effectiveResources — the merged limits currently applied
   *                        (plugin default ⊕ user override). Used to
   *                        skip no-op updates and report via
   *                        getResources().
   *   lastVolumeIssues   — containerPaths whose `VolumeSpec` source
   *                        was missing on the last ensureRunning()
   *                        call (and which policy applied). Used to
   *                        detect recovery on the next call.
   */
  const lastConfigs = new Map<string, ContainerConfig>();
  const lastVolumeIssues = new Map<
    string,
    {
      skipped: Array<{ containerPath: string; source: string }>;
      aborted: Array<{ containerPath: string; source: string }>;
    }
  >();
  // Per-container log-stream broker.  Lazily created on first subscribe
  // (either from `onContainerLog` or the SSE route), torn down when
  // the last subscriber unsubscribes OR when the container is
  // removed.  See src/log-stream-broker.ts for the fan-out model.
  const logStreamBrokers = new Map<string, LogStreamBroker>();
  // Tracks the latest `onContainerLog` unsubscribe fn per container
  // so auto-recreate (and re-calls of ensureRunning with a different
  // callback) can cancel the prior subscription before installing
  // the new one.
  const perCallOnContainerLogUnsub = new Map<string, () => void>();
  let currentOverrides: Record<string, ContainerResourceLimits> = {};
  // Cached result of resolveSignalkDataSource() — resolved once on first
  // ensureRunning() call that uses signalkDataMount, then reused.
  // `pendingDataSource` collapses concurrent resolutions onto one inspect.
  let cachedDataSource: string | null = null;
  let pendingDataSource: Promise<string> | null = null;
  // Same shape, but for `signalkConfigRootMount` → resolves the host
  // backing of `app.config.configPath` (the SignalK config root),
  // distinct from the plugin-private dataDir.
  let cachedConfigRootSource: string | null = null;
  let pendingConfigRootSource: Promise<string> | null = null;
  // Cached SignalK user-defined networks (resolved once, cleared on stop).
  // `pendingNetworks` collapses concurrent resolutions onto one inspect.
  // `undefined` = not yet resolved; `null` = resolved but inspect failed
  // (bare-metal or host-network); `string[]` = resolved successfully.
  let cachedSignalkNetworks: string[] | null | undefined = undefined;
  let pendingNetworks: Promise<string[] | null> | null = null;
  async function ensureCachedSignalkNetworks(): Promise<string[] | null> {
    if (cachedSignalkNetworks !== undefined) return cachedSignalkNetworks;
    if (pendingNetworks) return pendingNetworks;
    if (!runtimeInfo) return null;
    const inflight = resolveSignalkNetworks(runtimeInfo, app.debug);
    pendingNetworks = inflight;
    try {
      const resolved = await inflight;
      if (pendingNetworks === inflight) {
        cachedSignalkNetworks = resolved;
      }
      return resolved;
    } finally {
      if (pendingNetworks === inflight) pendingNetworks = null;
    }
  }
  // Maps "containerName:containerPort" → "host:port" (or "ctrName:port").
  // Populated by ensureRunning() when signalkAccessiblePorts is set.
  // Cleared on stop()/remove() so ports are re-evaluated on the next start.
  const portAddressMap = new Map<string, string>();

  // Tracks every "containerName:containerPort" key that was ever registered
  // via signalkAccessiblePorts.  Used by resolveContainerAddress() to
  // distinguish "registered but ensureRunning() not called yet" (a plugin
  // bug) from "port was never declared" (a legitimate null return).
  const registeredPorts = new Set<string>();
  async function ensureCachedDataSource(): Promise<string> {
    if (cachedDataSource) return cachedDataSource;
    if (pendingDataSource) return pendingDataSource;
    if (!runtimeInfo) throw new Error("No container runtime available");
    if (!app.getDataDirPath) {
      throw new Error(
        "signalkDataMount requires app.getDataDirPath, which is unavailable",
      );
    }
    const dataDir = app.getDataDirPath();
    const inflight = resolveSignalkDataSource(dataDir, runtimeInfo, app.debug);
    pendingDataSource = inflight;
    try {
      const resolved = await pendingDataSource;
      // Only cache if the plugin wasn't stopped while we were awaiting:
      // stop() sets pendingDataSource = null, so a different value here
      // (or null) means another caller cleared it (or stop ran).
      if (pendingDataSource === inflight) {
        cachedDataSource = resolved;
        app.debug(`signalkDataMount resolved: ${cachedDataSource}`);
      }
      return resolved;
    } finally {
      if (pendingDataSource === inflight) pendingDataSource = null;
    }
  }
  async function ensureCachedConfigRootSource(): Promise<string> {
    if (cachedConfigRootSource) return cachedConfigRootSource;
    if (pendingConfigRootSource) return pendingConfigRootSource;
    if (!runtimeInfo) throw new Error("No container runtime available");
    const configPath = app.config?.configPath;
    if (!configPath) {
      throw new Error(
        "signalkConfigRootMount requires the Signal K server configPath, which is unavailable",
      );
    }
    const inflight = resolveSignalkDataSource(
      configPath,
      runtimeInfo,
      app.debug,
    );
    pendingConfigRootSource = inflight;
    try {
      const resolved = await pendingConfigRootSource;
      if (pendingConfigRootSource === inflight) {
        cachedConfigRootSource = resolved;
        app.debug(`signalkConfigRootMount resolved: ${cachedConfigRootSource}`);
      }
      return resolved;
    } finally {
      if (pendingConfigRootSource === inflight) pendingConfigRootSource = null;
    }
  }
  /**
   * Remove all portAddressMap and registeredPorts entries for `name`, and
   * release any process-local port reservations that were backed by a
   * loopback (`127.0.0.1:PORT`) address.
   *
   * Called by api.stop(), api.remove(), and plugin.stop() to ensure that
   * resolveContainerAddress() never returns a stale endpoint after a
   * container has been taken down, and that the next bare-metal
   * ensureRunning() call re-probes for an available host port.
   */
  function evictContainerAddresses(name: string): void {
    for (const key of portAddressMap.keys()) {
      if (key.startsWith(`${name}:`)) {
        const addr = portAddressMap.get(key)!;
        if (addr.startsWith("127.0.0.1:")) {
          releaseReservedPort(Number(addr.split(":")[1]));
        }
        portAddressMap.delete(key);
      }
    }
    for (const key of registeredPorts) {
      if (key.startsWith(`${name}:`)) registeredPorts.delete(key);
    }
  }

  const effectiveResources = new Map<string, ContainerResourceLimits>();
  // Pristine plugin-default resource limits, captured at the top of the
  // `api.ensureRunning` wrapper BEFORE the override merge. Lets the
  // "Reset to plugin defaults" feature restore what the consumer plugin
  // originally asked for. Without this, we'd have no way to reconstruct
  // the default — lastConfigs stores the post-merge result.
  const pluginDefaults = new Map<string, ContainerResourceLimits>();
  // Captured at start(config). Used by recordOverride to build the full
  // cfg object when calling app.savePluginOptions, so the disk file keeps
  // runtime/pruneSchedule/etc. untouched alongside the new override.
  let currentConfig: PluginConfig | null = null;

  /**
   * Persist the current in-memory `currentOverrides` map to disk via
   * Signal K's `app.savePluginOptions`. Best-effort: failures are
   * logged but non-fatal (the live container state is already correct;
   * we just lose durability across Signal K restarts).
   *
   * Does NOT cause a plugin restart — `savePluginOptions` writes to
   * plugin-config-data/signalk-container.json without triggering the
   * Signal K admin UI's stop-and-restart flow, so this is safe to
   * call from inside a request handler without causing downtime.
   *
   * The `debugContext` is included in the debug log line so it's
   * possible to tell which code path triggered the write.
   */
  function persistOverridesToDisk(debugContext: string): void {
    if (!currentConfig || !app.savePluginOptions) {
      app.debug(
        `persistOverridesToDisk(${debugContext}): skipped (currentConfig=${currentConfig !== null}, savePluginOptions=${!!app.savePluginOptions})`,
      );
      return;
    }
    const newCfg = {
      ...currentConfig,
      containerOverrides: { ...currentOverrides },
    };
    // Keep currentConfig in sync so subsequent writes see the latest
    // containerOverrides too.
    currentConfig = newCfg;
    app.savePluginOptions(newCfg, (err) => {
      if (err) {
        app.error(
          `Failed to persist containerOverrides to disk (${debugContext}): ${err.message}. ` +
            `The in-memory state is correct but will be lost on the next Signal K restart.`,
        );
      } else {
        app.debug(
          `persistOverridesToDisk(${debugContext}): wrote to plugin-config-data`,
        );
      }
    });
  }

  /**
   * Record a user-requested override into `currentOverrides` so that
   * `GET /api/containers/:name/resources` returns a truthful `override`
   * field, AND so the next `ensureRunning` call from a consumer plugin
   * correctly merges the override on top of the plugin's default.
   *
   * Also persists the updated override map to disk via
   * `persistOverridesToDisk` so the user's Apply click survives both
   * page reloads AND full Signal K restarts.
   *
   * Called from inside `updateResources` after a successful apply.
   *
   * The input `limits` is a snapshot of the user's intent for the
   * container (e.g. the form state from the resource editor, which
   * seeds from the current effective state). We minimize it against
   * `pluginDefaults.get(name)` so that only fields which genuinely
   * differ from the consumer plugin's default get stored. This:
   *   - Prevents the "Override active" badge from sticking when the
   *     user submits a form that matches the plugin default.
   *   - Lets future plugin-default bumps (e.g. mayara bumping memory
   *     from "512m" to "1g") propagate to users who only explicitly
   *     overrode a different field like cpus.
   *
   * If the minimized result is empty (every submitted field matches
   * the plugin default), the override is deleted entirely.
   *
   * When no plugin default is known (pluginDefaults lacks an entry —
   * only possible if the consumer plugin never called ensureRunning,
   * which shouldn't happen in practice since updateResources requires
   * a prior ensureRunning for its recreate fallback path), we fall
   * back to storing the raw limits as before.
   */
  function recordOverride(name: string, limits: ContainerResourceLimits): void {
    const pluginDefault = pluginDefaults.get(name);
    const minimized = pluginDefault
      ? minimizeOverride(limits, pluginDefault)
      : { ...limits };
    const keys = Object.keys(minimized);
    if (keys.length === 0) {
      delete currentOverrides[name];
    } else {
      currentOverrides[name] = minimized;
    }
    persistOverridesToDisk(`recordOverride(${name})`);
  }

  /**
   * Remove a container's override entirely and persist to disk.
   * Used by the reset-to-plugin-defaults path (DELETE endpoint) where
   * we want to clear the override independently of calling
   * updateResources (which would re-add it via recordOverride at the
   * end of the successful-apply branches).
   */
  function clearOverride(name: string): void {
    if (!(name in currentOverrides)) return;
    delete currentOverrides[name];
    persistOverridesToDisk(`clearOverride(${name})`);
  }

  /**
   * Return the log-stream broker for `name`, lazily creating it on
   * the first subscribe.  Subscribers (an `onContainerLog` callback
   * or an SSE handler) share a single underlying `podman logs -f`
   * child.  Throws if the runtime isn't initialised yet.
   *
   * Also accepts an optional `startTail` to seed the broker on
   * first creation only — once a broker is alive, subsequent
   * `getOrCreateBroker` calls return the existing instance and
   * `startTail` is ignored.  This matches the documented limit
   * on `EnsureRunningOptions.onContainerLogStartTail`.
   */
  function getOrCreateBroker(
    name: string,
    startTail?: number,
  ): LogStreamBroker {
    let broker = logStreamBrokers.get(name);
    if (broker && !broker.isClosed()) return broker;
    if (!runtimeInfo) throw new Error("No container runtime available");
    broker = createLogStreamBroker(runtimeInfo, name, {
      startTail,
      spawnTail: tailContainerLogs,
      onTailError: (msg) => app.error(`logs(${name}): tail error: ${msg}`),
      onSubscriberError: (err) =>
        app.error(
          `logs(${name}): subscriber threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
    });
    logStreamBrokers.set(name, broker);
    return broker;
  }

  const api: ContainerManagerApi = {
    getRuntime() {
      return runtimeInfo;
    },

    whenReady() {
      return readyPromise;
    },

    async pullImage(image: string, onProgress?: (msg: string) => void) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await pullImage(
        runtimeInfo,
        qualifyImageForRuntime(image, runtimeInfo),
        onProgress,
      );
    },

    async imageExists(image: string) {
      if (!runtimeInfo) return false;
      return imageExists(
        runtimeInfo,
        qualifyImageForRuntime(image, runtimeInfo),
      );
    },

    async getImageDigest(imageOrContainer: string) {
      if (!runtimeInfo) return null;
      return getImageDigest(runtimeInfo, imageOrContainer);
    },

    async ensureRunning(
      name: string,
      config: ContainerConfig,
      options?: EnsureRunningOptions,
    ) {
      if (!runtimeInfo) throw new Error("No container runtime available");

      // Fail fast on a malformed digest before any pull or magic-mount
      // resolution. resolveImage() validates again, but doing it here
      // produces a cleaner stack for the consumer plugin.
      if (config.digest !== undefined && !DIGEST_RE.test(config.digest)) {
        throw new Error(
          `Invalid digest for ${config.image}: expected sha256:<64-hex>, got ${config.digest}`,
        );
      }

      // Resolve signalkDataMount → inject into volumes before anything else.
      // We strip the field from the config so containers.ts / buildRunArgs
      // never sees it (it only knows about plain volumes).
      if (config.signalkDataMount) {
        const source = await ensureCachedDataSource();
        const { signalkDataMount, ...rest } = config;
        const existing = rest.volumes?.[signalkDataMount];
        if (existing && existing !== source) {
          app.debug(
            `ensureRunning(${name}): signalkDataMount '${signalkDataMount}' overrides explicit volumes entry '${existing}' with resolved source '${source}'`,
          );
        }
        config = {
          ...rest,
          volumes: {
            ...rest.volumes,
            [signalkDataMount]: source,
          },
        };
      }

      // Resolve signalkConfigRootMount → inject into volumes. Same pattern
      // as signalkDataMount above, but resolves through app.config.configPath
      // (the SignalK installation root) instead of app.getDataDirPath() (the
      // plugin-private subdir). See the field's JSDoc in types.ts for when
      // to use which.
      if (config.signalkConfigRootMount) {
        const source = await ensureCachedConfigRootSource();
        const { signalkConfigRootMount, ...rest } = config;
        const existing = rest.volumes?.[signalkConfigRootMount];
        if (existing && existing !== source) {
          app.debug(
            `ensureRunning(${name}): signalkConfigRootMount '${signalkConfigRootMount}' overrides explicit volumes entry '${existing}' with resolved source '${source}'`,
          );
        }
        config = {
          ...rest,
          volumes: {
            ...rest.volumes,
            [signalkConfigRootMount]: source,
          },
        };
      }

      // Resolve signalkAccessiblePorts → configure networking so the
      // SignalK process can connect back to services in the container.
      // We strip the field from config so containers.ts never sees it.
      //
      // pendingPortMap collects the address entries that should be written
      // to portAddressMap, but only AFTER ensureRunning() succeeds below.
      // This prevents stale mappings from surviving a failed container create.
      const pendingPortMap = new Map<string, string>();

      // Capture the originally-requested signalkAccessiblePorts before the
      // block below destructures and removes it from `config`. Used after
      // ensureRunning succeeds to re-validate the cache against the runtime's
      // actual binding (issue #27).
      const requestedSignalkPorts: number[] =
        config.signalkAccessiblePorts ?? [];

      if (config.signalkAccessiblePorts?.length) {
        // Destructure to strip the three fields we take ownership of so they
        // cannot accidentally leak into the wrong Docker config branch.
        const {
          signalkAccessiblePorts,
          networkMode: _callerNetworkMode,
          ports: _callerPorts,
          ...cleanRest
        } = config;

        // Warn early if the caller is mixing signalkAccessiblePorts with
        // fields that we will override.  Doing both is almost certainly a
        // mistake and the result would otherwise be a silent surprise.
        if (_callerNetworkMode) {
          app.error(
            `ensureRunning(${name}): signalkAccessiblePorts and networkMode are both set — ` +
              `'${_callerNetworkMode}' will be discarded. ` +
              `Do not combine signalkAccessiblePorts with explicit networkMode.`,
          );
        }
        if (_callerPorts && Object.keys(_callerPorts).length > 0) {
          app.error(
            `ensureRunning(${name}): signalkAccessiblePorts and ports are both set — ` +
              `manual port bindings are preserved but may be overwritten by signalkAccessiblePorts entries. ` +
              `Do not combine signalkAccessiblePorts with explicit ports.`,
          );
        }

        // Register every requested port so resolveContainerAddress() can
        // distinguish "not yet available" from "never declared".
        for (const containerPort of signalkAccessiblePorts) {
          registeredPorts.add(`${name}:${containerPort}`);
        }

        // resolveSignalkNetworks returns null when running bare-metal OR when
        // docker inspect fails (e.g. host-network mode where HOSTNAME is the
        // machine name, not a container ID). In both cases we fall back to
        // publishing ports on 127.0.0.1 — the SignalK process can reach them
        // on the loopback whether it is bare-metal or on the host network.
        const networks = isContainerized()
          ? await ensureCachedSignalkNetworks()
          : null;
        const targetNetwork = networks?.[0] ?? null;

        if (networks === null) {
          // ── Bare-metal OR host-network container ──────────────────────
          // Bind each port to 127.0.0.1. Prefer the declared port number;
          // step over it if already in use.
          const portMappings: Record<string, string> = {};
          for (const containerPort of signalkAccessiblePorts) {
            // Reuse a previously COMMITTED host port for this container+port
            // so that idempotent ensureRunning() calls don't trigger a
            // config change (and therefore an unwanted container recreate).
            const cacheKey = `${name}:${containerPort}`;
            let address = portAddressMap.get(cacheKey);
            if (!address) {
              const hostPort = await findAvailablePort(containerPort);
              address = `127.0.0.1:${hostPort}`;
              pendingPortMap.set(cacheKey, address);
              if (hostPort !== containerPort) {
                app.debug(
                  `signalkAccessiblePorts(${name}): port ${containerPort} was taken, allocated ${hostPort}`,
                );
              }
            }
            const [, hostPort] = address.split(":");
            portMappings[String(containerPort)] = `127.0.0.1:${hostPort}`;
          }
          // Preserve any explicitly configured ports and merge ours on top.
          // networkMode is intentionally excluded — port bindings and
          // networkMode are mutually exclusive in Docker/Podman.
          config = {
            ...cleanRest,
            ports: { ..._callerPorts, ...portMappings },
          } as ContainerConfig;
        } else if (targetNetwork) {
          // ── Containerized, user-defined network ───────────────────────
          // Attach the managed container to SignalK's own user-defined
          // network. Docker's embedded DNS resolves the container name,
          // so no host port needs to be exposed.
          if (_callerNetworkMode && _callerNetworkMode !== targetNetwork) {
            app.debug(
              `signalkAccessiblePorts(${name}): overriding explicit networkMode '${_callerNetworkMode}' with SignalK network '${targetNetwork}'`,
            );
          }
          const prefixed = name.startsWith("sk-") ? name : `sk-${name}`;
          for (const containerPort of signalkAccessiblePorts) {
            pendingPortMap.set(
              `${name}:${containerPort}`,
              `${prefixed}:${containerPort}`,
            );
          }
          // networkMode takes full ownership — no port bindings or leftover
          // networkMode from the caller.
          config = {
            ...cleanRest,
            networkMode: targetNetwork,
          } as ContainerConfig;
        } else {
          // ── Containerized, default bridge only ────────────────────────
          // No user-defined network: share SignalK's network namespace so
          // the managed container's bound ports appear on SignalK's loopback.
          //
          // All containers using this strategy share the same network
          // namespace, so containerPort is global — two containers listening
          // on the same port would collide at the OS level inside the
          // namespace.  We use findAvailablePort() as a collision probe: it
          // both checks whether the port is free and reserves it in-process
          // so concurrent ensureRunning() calls cannot race on the same port.
          // If it probes and the first available port ≠ containerPort the
          // port is already taken, and we cannot remap it (the container
          // image listens on a fixed port), so we fail fast with a clear
          // message instead of silently starting a container that cannot bind.
          // Cascade detection so `network_mode: host` deployments don't
          // construct `container:<host-machine-name>` — the same bug
          // resolveSignalkNetworks/resolveHostPath have been fixed for
          // (issue #23).
          const selfId = await findSelfContainerId(runtimeInfo, app.debug);
          if (!selfId) {
            throw new Error(
              `signalkAccessiblePorts(${name}): could not detect SignalK's own container id ` +
                `(SIGNALK_CONTAINER_ID unset, HOSTNAME unusable, /proc/self/cgroup unparseable). ` +
                `Set SIGNALK_CONTAINER_ID to the container name as a workaround.`,
            );
          }
          app.debug(
            `signalkAccessiblePorts(${name}): only default bridge found, falling back to container:${selfId}`,
          );
          for (const containerPort of signalkAccessiblePorts) {
            const cacheKey = `${name}:${containerPort}`;
            if (!portAddressMap.has(cacheKey)) {
              const probed = await findAvailablePort(containerPort);
              if (probed !== containerPort) {
                // Release the unintended reservation before throwing.
                releaseReservedPort(probed);
                throw new Error(
                  `signalkAccessiblePorts(${name}): port ${containerPort} is already in use ` +
                    `in the shared network namespace (container:${selfId}). ` +
                    `Each container must use a unique port.`,
                );
              }
              pendingPortMap.set(cacheKey, `127.0.0.1:${containerPort}`);
            }
          }
          // container:<self-id> shares the network namespace — port bindings
          // are meaningless and must not be carried over.
          config = {
            ...cleanRest,
            networkMode: `container:${selfId}`,
          } as ContainerConfig;
        }
      }

      // Capture the plugin's pristine default resource limits BEFORE
      // merging with the user override. This is the only place in the
      // system that sees the "default" as a separate input; lastConfigs
      // stores the post-merge result. We need the default for:
      //   - "Reset to plugin defaults" action in the UI
      //   - (future) detecting when an override happens to match the
      //     default and offering to clear it
      pluginDefaults.set(name, { ...(config.resources ?? {}) });

      // Merge user override on top of the plugin's default resources.
      // The user override (from signalk-container's own plugin config)
      // wins field-by-field; null in the override removes a limit.
      const merged = mergeResourceLimits(
        config.resources,
        currentOverrides[name],
      );
      // Drop fields whose backing cgroup controller is unavailable on
      // this host (Bug B). Log them once so the user knows their
      // override is being ignored. Without this filter, an override
      // with `cpusetCpus` on rootless podman would cause `podman run`
      // to fail with a cryptic OCI error.
      const { accepted: filteredMerged, dropped } = filterUnsupportedLimits(
        merged,
        runtimeInfo,
      );
      for (const d of dropped) {
        app.debug(
          `ensureRunning(${name}): dropped resources.${d.field}: ${d.reason}`,
        );
      }
      const effectiveConfigPreFilter: ContainerConfig = {
        ...config,
        resources: filteredMerged,
      };

      // Classify volumes against host-source existence and per-volume
      // ifMissing policy. `skipped` volumes are dropped from the
      // request and announced via onVolumeIssue; `aborted` volumes
      // trigger an event then a throw.
      const { kept, skipped, aborted } = classifyVolumeSources(
        effectiveConfigPreFilter.volumes,
      );

      const emitVolumeIssue = (event: VolumeIssue) =>
        safeInvokeVolumeIssue(options?.onVolumeIssue, event, (err) =>
          app.error(
            `ensureRunning(${name}): onVolumeIssue handler threw for ` +
              `${event.containerPath} -> ${event.source} (${event.action}): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          ),
        );

      for (const v of skipped) {
        app.debug(
          `ensureRunning(${name}): skipping volume ${v.containerPath} -> ${v.source} (host path missing)`,
        );
        emitVolumeIssue({
          containerPath: v.containerPath,
          source: v.source,
          action: "skipped",
          reason: `Host path ${v.source} does not exist; volume omitted`,
        });
      }
      for (const v of aborted) {
        emitVolumeIssue({
          containerPath: v.containerPath,
          source: v.source,
          action: "aborted",
          reason: `Required host path ${v.source} does not exist`,
        });
      }
      if (aborted.length > 0) {
        const list = aborted
          .map((v) => `${v.containerPath} -> ${v.source}`)
          .join(", ");
        // Surface to debug too — the throw alone isn't visible in places
        // that only watch debug output.
        app.debug(
          `ensureRunning(${name}): aborting — required host paths missing for volumes: ${list}`,
        );
        // Persist current missing state BEFORE throwing so a later
        // successful call (once the source reappears) can emit
        // action: "recovered" for these entries. Without this, the
        // first-time abort would have no prior record to recover from.
        lastVolumeIssues.set(name, { skipped, aborted });
        throw new Error(
          `ensureRunning(${name}): required host paths missing for volumes: ${list}`,
        );
      }

      const effectiveConfig: ContainerConfig = {
        ...effectiveConfigPreFilter,
        volumes: kept,
      };

      // Recovery detection: anything in lastVolumeIssues that is now
      // present in `kept` is announced AFTER ensureRunning returns
      // (the inner call's diff path is what actually recreates the
      // container to include the recovered mount).
      const recovered = collectRecoveredVolumes(
        lastVolumeIssues.get(name),
        skipped,
        aborted,
        kept,
      );

      // Capture the prior call's config before overwriting so the diff
      // inside ensureRunning can detect "unset" drift (env key removed,
      // command previously set and now undefined). undefined on first call.
      const priorConfig = lastConfigs.get(name);
      // Cache for later updateResources() recreate-fallback path. Post-
      // filter shape — drift detection sees consistent state across calls.
      lastConfigs.set(name, effectiveConfig);
      effectiveResources.set(name, filteredMerged);
      // `aborted` is always empty here — we'd have thrown above otherwise —
      // but we store the variable verbatim for clarity.
      lastVolumeIssues.set(name, { skipped, aborted });

      // Resolve the image to a concrete pull spec + digest BEFORE the
      // inner ensureRunning. The resolver does the pull (if missing)
      // and computes the resolvedDigest that flows into the manifest
      // record after success. The inner call's own imageExists check
      // is cheap and short-circuits the duplicate pull.
      const resolved = await resolveImage(
        runtimeInfo,
        effectiveConfig,
        {
          qualifyImage: qualifyImageForRuntime,
          imageExists,
          pullImage,
          getRepoDigest,
          getImageDigest,
        },
        (msg) => app.debug(`resolveImage(${name}): ${msg}`),
      );

      try {
        await ensureRunning(
          runtimeInfo,
          name,
          effectiveConfig,
          (msg) => app.debug(msg),
          options,
          undefined,
          priorConfig,
        );
      } catch (err) {
        // Release any process-local port reservations so the next attempt
        // can re-probe freely instead of skipping ports we failed to claim.
        for (const addr of pendingPortMap.values()) {
          if (addr.startsWith("127.0.0.1:")) {
            releaseReservedPort(Number(addr.split(":")[1]));
          }
        }
        throw err;
      }

      // Commit port-address mappings only after the container has been
      // successfully started.  Populating portAddressMap before this
      // point would leave stale entries if ensureRunning() throws.
      // Release the process-local reservations: Docker now holds the actual
      // OS-level binding, making the in-flight reservation redundant.
      for (const [key, addr] of pendingPortMap) {
        portAddressMap.set(key, addr);
        if (addr.startsWith("127.0.0.1:")) {
          releaseReservedPort(Number(addr.split(":")[1]));
        }
      }

      // Defence-in-depth: re-validate the cached port mappings against the
      // runtime's actual binding.  `findAvailablePort()` probes by binding a
      // TCP socket — there is a small TOCTOU window between that probe and
      // the runtime's `podman create`, during which another process can
      // release or claim the preferred port.  See issue #27.
      //
      // We only validate the bare-metal / loopback entries; containerised
      // entries of the form `sk-<name>:<port>` go through DNS rather than a
      // host port and cannot drift.  Any mismatch is corrected silently and
      // logged at debug level so a future reproduction has breadcrumbs.
      if (requestedSignalkPorts.length > 0) {
        try {
          const liveBindings = await getActualPortBindings(runtimeInfo, name);
          for (const containerPort of requestedSignalkPorts) {
            const cacheKey = `${name}:${containerPort}`;
            const cached = portAddressMap.get(cacheKey);
            if (!cached || !cached.startsWith("127.0.0.1:")) continue;
            const live = liveBindings.get(containerPort);
            if (!live || live.length === 0) continue;
            // Prefer the binding on 127.0.0.1; fall back to the first one.
            const loopback = live.find((b) => b.hostIp === "127.0.0.1");
            const chosen = loopback ?? live[0];
            if (!chosen) continue;
            const truth = `127.0.0.1:${chosen.hostPort}`;
            if (truth !== cached) {
              app.debug(
                `ensureRunning(${name}): cache drift detected for port ${containerPort} — ` +
                  `cached '${cached}', actual '${truth}'. Overwriting with truth.`,
              );
              const cachedPort = Number(cached.split(":")[1]);
              if (Number.isFinite(cachedPort)) {
                releaseReservedPort(cachedPort);
              }
              portAddressMap.set(cacheKey, truth);
            }
          }
        } catch (err) {
          app.debug(
            `ensureRunning(${name}): port-binding re-validation failed (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Record what's actually running in the manifest. Read the
      // live container's digest (via its immutable image-id) rather
      // than the pre-ensureRunning resolver output: if `ensureRunning`
      // took the no-drift path while the local `image:tag` was
      // refreshed out-of-band, the resolver's digest reflects the
      // local tag state, not the running container. Falling back to
      // the resolver's digest only happens when the inspect race
      // means we can't read the live id.
      //
      // Fire-and-forget: a failed write is logged but does not fail
      // the ensureRunning call. recordResolution() decides the
      // effective reason based on the actual transition
      // (plugin-install vs plugin-update).
      if (manifestStore) {
        let liveResolved: ResolveResult = resolved;
        try {
          const liveDigest = await getLiveContainerDigest(runtimeInfo, name);
          if (liveDigest) {
            liveResolved = {
              pullSpec: resolved.pullSpec,
              resolvedDigest: liveDigest,
              source: resolved.source,
            };
          }
        } catch (err) {
          // Manifest recording is best-effort — a transient inspect
          // failure must not reject the ensureRunning call. Fall back
          // to the pre-resolve digest.
          app.error(
            `ensureRunning(${name}): live digest probe failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        manifestStore
          .recordResolution({
            pluginId: options?.pluginId ?? `container:${name}`,
            pluginVersion: options?.pluginVersion ?? "unknown",
            containerName: name,
            config: {
              image: effectiveConfig.image,
              tag: effectiveConfig.tag,
              digest: effectiveConfig.digest,
              updateChannel: effectiveConfig.updateChannel,
            },
            resolved: liveResolved,
            // Omit `reason` so the store auto-detects: first record is
            // `plugin-install`, subsequent digest changes are
            // `plugin-update`. PR-C admin paths (user-pull, manual-check)
            // will pass their own reason explicitly.
          })
          .catch((err) =>
            app.error(
              `ensureRunning(${name}): manifest record failed: ${err instanceof Error ? err.message : err}`,
            ),
          );
      }

      // Bug D: if ensureRunning was a no-op (container was already
      // running) AND the requested limits differ from the live state,
      // fire a live update to bring them in line. This is what makes
      // user `containerOverrides` config changes take effect on the
      // next consumer-plugin restart without forcing a recreate.
      //
      // Capture limits AFTER ensureRunning so an internal recreate (drift
      // detection in ensureRunning recreates the container with
      // filteredMerged already applied) does not trigger a spurious
      // tryLiveUpdate against an already-correct container.
      const postLimits = await getLiveResources(runtimeInfo, name);
      if (!resourceLimitsEqual(postLimits, filteredMerged)) {
        const fullName = name.startsWith("sk-") ? name : `sk-${name}`;

        // Bug E: if any field is being UNSET and it can't be unset
        // via live update (memory, oomScoreAdj, etc.), the live path
        // would silently no-op. We can't safely recreate from inside
        // ensureRunning's "already running" branch — that would
        // surprise the consumer plugin. Instead, log a clear warning
        // pointing the user to the explicit recreate path.
        const cannotUnset = fieldsRequiringRecreateForUnset(
          postLimits,
          filteredMerged,
        );
        if (cannotUnset.length > 0) {
          app.error(
            `ensureRunning(${name}): cannot live-unset fields ${cannotUnset.join(", ")} on already-running container. ` +
              `These limits will remain at their previous values until the container is recreated. ` +
              `Use POST /plugins/signalk-container/api/containers/${name}/resources to force a recreate.`,
          );
          // Still try to apply the OTHER (settable) fields via live update.
        }

        const live = await tryLiveUpdate(runtimeInfo, fullName, filteredMerged);
        if (!live.ok) {
          // Live update failed (e.g. cpuset on a host that doesn't
          // delegate it). The container is still running with its
          // OLD limits, which is fine — log a warning so the user
          // can see why their override didn't take effect, but
          // don't throw, since the container itself is healthy.
          app.error(
            `ensureRunning(${name}): live resource update failed: ${live.stderr ?? "unknown reason"}. ` +
              `Container is running with previous limits. ` +
              `Use POST /api/containers/${name}/resources to force a recreate.`,
          );
        } else {
          app.debug(
            `ensureRunning(${name}): live-updated resources to match new config`,
          );
        }
      }

      // Recovery emission: AFTER the inner ensureRunning returns (so
      // any drift-driven recreate has already brought the container
      // back with the recovered mounts), notify the consumer that any
      // previously-missing volume sources are now applied.
      for (const r of recovered) {
        emitVolumeIssue({
          containerPath: r.containerPath,
          source: r.source,
          action: "recovered",
          reason: `Host path ${r.source} is now present; volume applied`,
        });
      }

      // onContainerLog: subscribe the plugin callback (if any) to the
      // per-container broker.  Re-entry from auto-recreate (or a
      // fresh consumer-plugin call) cancels the prior subscription
      // before re-subscribing — without this, two callbacks would
      // accumulate per recreate and the old one would be unreachable
      // (still inside the broker's subscriber set).
      if (options?.onContainerLog) {
        perCallOnContainerLogUnsub.get(name)?.();
        const userOnContainerLog = options.onContainerLog;
        const broker = getOrCreateBroker(name, options.onContainerLogStartTail);
        const unsub = broker.subscribe({
          onLine: (line) =>
            safeInvokeContainerLog(userOnContainerLog, line, (err) =>
              app.error(
                `ensureRunning(${name}): onContainerLog handler threw: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            ),
        });
        perCallOnContainerLogUnsub.set(name, unsub);
      } else {
        // Caller explicitly removed onContainerLog this call —
        // drop any prior subscription so we don't keep feeding a
        // detached callback.  If that drains the broker, evict it
        // from the Map so a fresh subscriber later spawns a clean
        // tail (mirrors the SSE-disconnect cleanup below).
        perCallOnContainerLogUnsub.get(name)?.();
        perCallOnContainerLogUnsub.delete(name);
        const broker = logStreamBrokers.get(name);
        if (broker && !broker.isClosed() && broker.subscriberCount() === 0) {
          logStreamBrokers.delete(name);
        }
      }

      if (options?.healthCheck) {
        const existing = healthTimers.get(name);
        if (existing) clearInterval(existing);

        const timer = setInterval(async () => {
          try {
            const ok = await options.healthCheck!();
            if (!ok) {
              options.onUnhealthy?.(name, "Health check returned false");
            }
          } catch (err) {
            options.onUnhealthy?.(
              name,
              err instanceof Error ? err.message : String(err),
            );
          }
        }, 60000);
        healthTimers.set(name, timer);
      }
    },

    async resolveContainerAddress(
      containerName: string,
      containerPort: number,
    ): Promise<string | null> {
      if (!runtimeInfo) return null;
      const key = `${containerName}:${containerPort}`;
      const addr = portAddressMap.get(key);
      if (addr !== undefined) return addr;
      if (registeredPorts.has(key)) {
        throw new Error(
          `resolveContainerAddress(${containerName}, ${containerPort}): ` +
            `port was declared in signalkAccessiblePorts but the address is not yet available — ` +
            `call ensureRunning() before resolveContainerAddress().`,
        );
      }
      return null;
    },

    async resolveSignalkDataMount(): Promise<string | null> {
      // Honor the documented contract: return null when we cannot
      // resolve, never throw. ensureCachedDataSource() throws when
      // app.getDataDirPath is unavailable; that's appropriate for
      // ensureRunning (the caller asked us to mount it) but not for
      // this introspection method.
      if (!runtimeInfo || !app.getDataDirPath) return null;
      return ensureCachedDataSource();
    },

    async resolveHostPath(absPath: string) {
      if (!runtimeInfo) return null;
      return resolveHostPath(absPath, runtimeInfo, app.debug);
    },

    async start(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await startContainer(runtimeInfo, name);
    },

    async stop(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await stopContainer(runtimeInfo, name);
      evictContainerAddresses(name);
    },

    async remove(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await removeContainer(runtimeInfo, name);
      evictContainerAddresses(name);
      // Tear down the log-stream broker — notifies any SSE clients
      // with `event: end` and stops the underlying `podman logs -f`.
      // Plugin `onContainerLog` callbacks just stop receiving lines.
      const broker = logStreamBrokers.get(name);
      if (broker) {
        broker.close("container-removed");
        logStreamBrokers.delete(name);
      }
      perCallOnContainerLogUnsub.delete(name);
    },

    async getState(name: string): Promise<ContainerState> {
      if (!runtimeInfo) return "no-runtime";
      return getContainerState(runtimeInfo, name);
    },

    async runJob(config: ContainerJobConfig): Promise<ContainerJobResult> {
      if (!runtimeInfo) throw new Error("No container runtime available");
      return runJob(runtimeInfo, config);
    },

    async getLogs(
      name: string,
      options?: { tail?: number; since?: number },
    ): Promise<string[]> {
      if (!runtimeInfo) throw new Error("No container runtime available");
      return getContainerLogs(runtimeInfo, name, options);
    },

    async cleanupOrphanedJobs(filter: {
      ownerPluginId: string;
    }): Promise<CleanupOrphansResult> {
      if (!runtimeInfo) {
        return { reaped: [] };
      }
      return cleanupOrphanedJobs(runtimeInfo, filter.ownerPluginId);
    },

    async prune(): Promise<PruneResult> {
      if (!runtimeInfo) throw new Error("No container runtime available");
      return pruneImages(runtimeInfo);
    },

    async listContainers(): Promise<ContainerInfo[]> {
      if (!runtimeInfo) return [];
      return listContainers(runtimeInfo);
    },

    async execInContainer(name: string, command: string[]) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      return execInContainer(runtimeInfo, name, command);
    },

    async ensureNetwork(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await ensureNetwork(runtimeInfo, name);
    },

    async removeNetwork(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await removeNetwork(runtimeInfo, name);
    },

    async connectToNetwork(containerName: string, networkName: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await connectToNetwork(runtimeInfo, containerName, networkName);
    },

    async disconnectFromNetwork(containerName: string, networkName: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await disconnectFromNetwork(runtimeInfo, containerName, networkName);
    },

    async updateResources(
      name: string,
      limits: ContainerResourceLimits,
    ): Promise<UpdateResourcesResult> {
      if (!runtimeInfo) throw new Error("No container runtime available");

      const fullName = name.startsWith("sk-") ? name : `sk-${name}`;
      const warnings: string[] = [];

      // Bug Y: `limits` is the user's intent for fields they want to
      // change, NOT an absolute target. Merge it on top of the consumer
      // plugin's pristine default (stored in pluginDefaults by the
      // api.ensureRunning wrapper) so the fields the user didn't
      // touch stay at the plugin default. Without this merge, the user
      // submitting just `{cpus: 2}` would cause the container to be
      // recreated with ONLY cpus (memory/swap/pids wiped), because
      // updateResources was treating the payload as absolute.
      //
      // This mirrors the semantics of the api.ensureRunning wrapper
      // which already merges plugin default + user override before
      // applying. Now both entry points behave consistently: the
      // final state applied to the container is always
      // `pluginDefault ⊕ userOverride`, where userOverride is the
      // minimal set of fields the user explicitly changed.
      //
      // The ORIGINAL unmerged `limits` is still passed to
      // recordOverride, which in turn passes it through minimizeOverride
      // (same plugin-default-aware logic). So the stored override is
      // still minimal — only fields that actually differ from the
      // default.
      const pluginDefault = pluginDefaults.get(name) ?? {};
      const mergedTarget = mergeResourceLimits(pluginDefault, limits);

      // Filter the MERGED target against the runtime's actual cgroup
      // capabilities. Dropping a field here is silent at the
      // resources.ts layer; we surface it once via app.debug so the
      // user knows their override is being ignored. (Bug B fix.)
      const { accepted: filteredLimits, dropped } = filterUnsupportedLimits(
        mergedTarget,
        runtimeInfo,
      );
      for (const d of dropped) {
        const w = `dropped resources.${d.field}: ${d.reason}`;
        warnings.push(w);
        app.debug(`updateResources(${name}): ${w}`);
      }

      // Read the LIVE state from podman, not the in-memory cache.
      // The cache (`effectiveResources`) is good for "what did we last
      // try to apply" tracking, but it can drift from reality:
      //   - on Signal K restart it's empty
      //   - if the previous v0.1.6 buggy code claimed a successful
      //     unset that podman didn't actually do, the cache reflects
      //     the user's intent but the container has the old value
      //   - manual `podman update` from outside Signal K isn't tracked
      // Always compare against truth.
      const liveBefore = await getLiveResources(runtimeInfo, name);

      // No-op when the live container already matches what's being
      // requested. Verify existence by way of getLiveResources returning
      // an empty object — if liveBefore is {}, either the container is
      // missing OR it has no resource limits at all, both of which
      // require a separate state check.
      if (resourceLimitsEqual(liveBefore, filteredLimits)) {
        const state = await getContainerState(runtimeInfo, name);
        if (state === "missing") {
          throw new Error(
            `updateResources: container ${fullName} does not exist`,
          );
        }
        // Live state already matches the request — true no-op.
        // Update the caches so they stop lying if they were stale.
        effectiveResources.set(name, { ...filteredLimits });
        recordOverride(name, limits);
        return {
          method: "live",
          warnings: warnings.length ? warnings : undefined,
        };
      }

      // Bug E: detect "user is asking to UNSET a field that's currently
      // set on the container, AND that field cannot be unset via live
      // update". Memory limits and oom-score-adj are the offenders —
      // podman/docker can lower or raise them, but not return them to
      // the unlimited/default state without a recreate.
      const mustRecreateForUnset = fieldsRequiringRecreateForUnset(
        liveBefore,
        filteredLimits,
      );
      const forceRecreate = mustRecreateForUnset.length > 0;
      if (forceRecreate) {
        const fieldList = mustRecreateForUnset.join(", ");
        const w = `forcing recreate to unset live-non-unsettable fields: ${fieldList}`;
        warnings.push(w);
        app.debug(`updateResources(${name}): ${w}`);
      }

      // Try the runtime's live `update` first — instantaneous, no
      // downtime — and only fall back to recreate when it refuses
      // OR when we know live update can't perform the requested unset.
      const live = forceRecreate
        ? {
            ok: false as const,
            stderr: "force-recreate for unset of non-live-unsettable field(s)",
          }
        : await tryLiveUpdate(runtimeInfo, fullName, filteredLimits);
      if (live.ok) {
        effectiveResources.set(name, { ...filteredLimits });
        recordOverride(name, limits);
        // Also keep the cached ContainerConfig in sync so that a
        // future recreate (e.g. on plugin restart) preserves the
        // newer limits.
        const cached = lastConfigs.get(name);
        if (cached) {
          lastConfigs.set(name, {
            ...cached,
            resources: { ...filteredLimits },
          });
        }
        return {
          method: "live",
          warnings: warnings.length ? warnings : undefined,
        };
      }

      // Live update refused (cpuset on incompatible kernel, oom-score-adj,
      // or runtime quirk). Fall back to stop+remove+ensureRunning if we
      // have the original config cached.
      const cachedConfig = lastConfigs.get(name);
      if (!cachedConfig) {
        throw new Error(
          `updateResources: cannot recreate ${name} — no cached ContainerConfig. ` +
            `Live update failed: ${live.stderr ?? "unknown reason"}. ` +
            `The consumer plugin must call ensureRunning() first.`,
        );
      }

      if (live.stderr) {
        warnings.push(`live update: ${live.stderr}`);
      }

      const newConfig: ContainerConfig = {
        ...cachedConfig,
        resources: { ...filteredLimits },
      };

      // Capture pre-recreate state so we can roll back if the
      // recreate fails. The cached ContainerConfig IS the rollback
      // target — it's what the consumer plugin most recently asked
      // for, minus our new resources. (Bug A fix.)
      try {
        await removeContainer(runtimeInfo, name);
      } catch (err) {
        warnings.push(
          `remove during recreate: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        await ensureRunning(runtimeInfo, name, newConfig, (msg) =>
          app.debug(msg),
        );
      } catch (recreateErr) {
        // Recreate failed — the container is gone or in a bad state.
        // Try to roll back to the previous config so the consumer
        // plugin's container is at least back to working order.
        const recreateMsg =
          recreateErr instanceof Error
            ? recreateErr.message
            : String(recreateErr);
        app.error(
          `updateResources(${name}): recreate with new limits failed, attempting rollback: ${recreateMsg}`,
        );

        try {
          // Make sure no half-created container is in the way.
          await removeContainer(runtimeInfo, name).catch(() => {});
          await ensureRunning(runtimeInfo, name, cachedConfig, (msg) =>
            app.debug(msg),
          );
          // Rollback succeeded — internal state is unchanged. Throw a
          // wrapper that carries the original recreate error as `cause`
          // so callers can introspect the underlying podman failure.
          throw new Error(
            `Failed to apply new resources for ${name}: ${recreateMsg}. ` +
              `Container rolled back to previous config; the new limits were NOT applied.`,
            { cause: recreateErr },
          );
        } catch (rollbackErr) {
          // Both the new-config recreate AND the rollback failed.
          // The container is genuinely gone and we can't bring it back.
          // Clear our caches so getResources/listConfigs don't lie.
          const rollbackMsg =
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr);
          // Don't shadow the rollback error if it's our own re-thrown
          // success message — only treat genuinely-different errors as
          // fatal.
          if (rollbackErr === recreateErr || rollbackMsg === recreateMsg) {
            // Same error came back from rollback — original throw above.
            throw rollbackErr;
          }
          if (rollbackMsg.startsWith("Failed to apply new resources")) {
            // This was the success-with-rollback message thrown above.
            throw rollbackErr;
          }
          lastConfigs.delete(name);
          effectiveResources.delete(name);
          lastVolumeIssues.delete(name);
          app.setPluginError(
            `Container ${name} is in an indeterminate state: ` +
              `recreate failed (${recreateMsg}) AND rollback failed (${rollbackMsg}). ` +
              `Manual intervention required.`,
          );
          throw new Error(
            `Failed to apply new resources for ${name} (${recreateMsg}) ` +
              `AND failed to roll back (${rollbackMsg}). ` +
              `Container is in an indeterminate state, manual intervention required.`,
            { cause: rollbackErr },
          );
        }
      }

      lastConfigs.set(name, newConfig);
      effectiveResources.set(name, { ...filteredLimits });
      recordOverride(name, limits);
      return { method: "recreated", warnings };
    },

    getResources(name: string): ContainerResourceLimits {
      return { ...(effectiveResources.get(name) ?? {}) };
    },

    // `updates` is wired up in start() once the data dir is known.
    // Until then, register() is a silent no-op via the stub below.
    get updates() {
      return updateService ?? stubUpdateService;
    },

    // `manifest` is wired up in start() once the data dir is known.
    // Until then, reads return null/[] via the stub below; the stub
    // never throws so consumer plugins can query unconditionally.
    get manifest(): ManifestApi {
      return manifestStore ?? stubManifest;
    },
    // `doctor` probes need `runtimeInfo` (resolved during start()).
    // Until then, every call returns `{ ok: false, error: "Container
    // manager not yet started" }` so consumer plugins can call
    // unconditionally without crashing the boot path.
    get doctor(): DoctorApi {
      return runtimeInfo ? liveDoctor : stubDoctor;
    },
  };

  const liveDoctor: DoctorApi = {
    async imageRunsAsUser(
      image: string,
      user?: ContainerConfig["user"],
    ): Promise<{ ok: boolean; output: string; error?: string }> {
      // runtimeInfo is captured at call time, not at module load, so
      // this always reflects the current detection state — useful if
      // future plumbing supports runtime swap.
      if (!runtimeInfo) {
        return {
          ok: false,
          output: "",
          error: "Container manager not yet started",
        };
      }
      return imageRunsAsUser(runtimeInfo, image, user);
    },
    async selfDeployment(): Promise<SelfDeploymentResult> {
      return selfDeployment(runtimePreference);
    },
  };

  const stubDoctor: DoctorApi = {
    async imageRunsAsUser(): Promise<{
      ok: boolean;
      output: string;
      error?: string;
    }> {
      return {
        ok: false,
        output: "",
        error: "Container manager not yet started",
      };
    },
    // selfDeployment is the diagnostic for "why isn't the runtime up?",
    // so it must work BEFORE start() settles — otherwise operators have
    // no way to find out from the API what went wrong. Calls through to
    // the real probe using whatever preference has been captured so far
    // (defaults to "auto" at module init).
    async selfDeployment(): Promise<SelfDeploymentResult> {
      return selfDeployment(runtimePreference);
    },
  };

  const stubManifest: ManifestApi = {
    async get(): Promise<ConsumerManifest | null> {
      return null;
    },
    async list(): Promise<ConsumerManifest[]> {
      return [];
    },
    async getContainerHistory(): Promise<HistoryEntry[]> {
      return [];
    },
  };

  /**
   * Stub update service used between module load and start(). Calls
   * are silent no-ops so consumer plugins can register unconditionally.
   * Replaced by a real UpdateService instance in start().
   */
  const stubUpdateService = {
    register: () => {},
    unregister: () => {},
    checkOne: async () => {
      throw new Error("Container manager not yet started");
    },
    checkAll: async () => [],
    getLastResult: () => null,
    listRegistrations: () => [],
    sources: {
      githubReleases: () => ({
        async fetch() {
          return {
            kind: "error" as const,
            error: "Container manager not yet started",
          };
        },
      }),
      dockerHubTags: () => ({
        async fetch() {
          return {
            kind: "error" as const,
            error: "Container manager not yet started",
          };
        },
      }),
    },
  } as unknown as UpdateService;

  const plugin = {
    id: "signalk-container",
    name: "Container Manager",

    schema: {
      type: "object" as const,
      properties: {
        runtime: {
          type: "string",
          enum: ["auto", "podman", "docker"],
          default: "auto",
          title: "Container runtime",
          description:
            "Auto-detect (Podman preferred), or force a specific runtime",
        },
        pruneSchedule: {
          type: "string",
          enum: ["off", "weekly", "monthly"],
          default: "weekly",
          title: "Auto-prune dangling images",
        },
        maxConcurrentJobs: {
          type: "number",
          default: 2,
          title: "Max concurrent one-shot jobs",
          description: "Limit parallel container job executions",
        },
        updateCheckInterval: {
          type: "string",
          default: "24h",
          title: "Update check interval",
          description:
            "How often to check for container image updates (e.g. 24h, 12h, 1h). Min 1h.",
        },
        backgroundUpdateChecks: {
          type: "boolean",
          default: true,
          title: "Background update checks",
          description:
            "Periodically check for container image updates in the background. Disable on metered connections — manual checks via the UI button still work.",
        },
        containerOverrides: {
          type: "object" as const,
          title: "Per-container resource overrides",
          description:
            'Override resource limits for specific managed containers, keyed by name (without \'sk-\' prefix). Field-level merged on top of the consumer plugin\'s defaults — set a field to null to remove a limit set by the plugin. Example: { "mayara-server": { "cpus": 1.5, "memory": "512m" } }. Live-applied via \'podman update\' when possible, falls back to recreate.',
          additionalProperties: {
            type: "object",
            properties: {
              cpus: { type: ["number", "null"], title: "Hard CPU cap (cores)" },
              cpuShares: {
                type: ["number", "null"],
                title: "Soft CPU weight (default 1024)",
              },
              cpusetCpus: {
                type: ["string", "null"],
                title: "Pin to specific cores, e.g. '0,1' or '1-3'",
              },
              memory: {
                type: ["string", "null"],
                title: "Hard memory cap, e.g. '512m', '2g'",
              },
              memorySwap: {
                type: ["string", "null"],
                title: "Memory + swap (set equal to 'memory' to disable swap)",
              },
              memoryReservation: {
                type: ["string", "null"],
                title: "Soft memory floor",
              },
              pidsLimit: {
                type: ["number", "null"],
                title: "Process/thread cap",
              },
              oomScoreAdj: {
                type: ["number", "null"],
                title: "OOM score adjustment (-1000..1000)",
              },
            },
          },
          default: {},
        },
      },
    },

    start(config: PluginConfig) {
      // Fresh whenReady() promise per start — see comment by the
      // declaration above. Reset before the async IIFE so any pending
      // readers either see the new promise or the resolved old one,
      // never a stale promise pointing at the prior run. The resolver
      // is captured into `localResolveReady` (closed over by the IIFE
      // below) so overlapping start() calls can't fire each other's
      // promises.
      let localResolveReady: () => void = () => {};
      readyPromise = new Promise<void>((r) => {
        localResolveReady = r;
      });

      // Cache the full config object so recordOverride() can rebuild it
      // when persisting a new override via savePluginOptions. Shallow
      // copy to avoid mutating the caller's object.
      currentConfig = { ...config };
      // Cache user-supplied per-container resource overrides. These
      // are merged into every ensureRunning() call so consumer
      // plugins automatically pick them up. The user can edit them
      // in signalk-container's plugin config; saving causes Signal K
      // to stop+start this plugin, so the new overrides take effect
      // on the next ensureRunning() call from each consumer.
      currentOverrides = config.containerOverrides ?? {};

      // Instantiate the update service synchronously so consumer
      // plugins can call containers.updates.register(...) before
      // the runtime is detected. The service tolerates a null
      // runtime — it queues registrations and runs them on the
      // first scheduled tick after detectRuntime() succeeds.
      const dataDir = app.getDataDirPath
        ? app.getDataDirPath()
        : "/tmp/signalk-container";
      const cachePath = path.join(dataDir, "updates-cache.json");
      const intervalMs = parseDurationOrDefault(
        config.updateCheckInterval,
        24 * 60 * 60 * 1000,
      );
      updateService = new UpdateService({
        app: {
          debug: (msg, ...args) => app.debug(msg, ...args),
          error: (msg, ...args) => app.error(msg, ...args),
          handleMessage: app.handleMessage
            ? (id, delta) => app.handleMessage!(id, delta)
            : undefined,
        },
        containers: {
          getRuntime: () => runtimeInfo,
          getState: (name) =>
            runtimeInfo
              ? getContainerState(runtimeInfo, name)
              : Promise.resolve("no-runtime" as ContainerState),
          pullImage: async (image) => {
            if (!runtimeInfo) throw new Error("No container runtime available");
            await pullImage(
              runtimeInfo,
              qualifyImageForRuntime(image, runtimeInfo),
            );
          },
          getImageDigest: async (imageOrContainer) => {
            if (!runtimeInfo) return null;
            return getImageDigest(runtimeInfo, imageOrContainer);
          },
        },
        clock: {
          now: () => Date.now(),
          setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
          clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        },
        cache: new FileUpdateCache(cachePath, (msg) => app.debug(msg)),
        defaultCheckIntervalMs: intervalMs,
        backgroundChecks: config.backgroundUpdateChecks !== false,
      });

      manifestStore = new ManifestStore(
        path.join(dataDir, "signalk-container-manifests"),
        (msg) => app.debug(msg),
      );

      // Expose API on global so other plugins can find it.
      // Each plugin gets a shallow copy of app (_.assign({}, app)),
      // so setting on app doesn't propagate. Global is the shared bus.
      (globalThis as any).__signalk_containerManager = api;

      // Async init — server does not await start()
      (async () => {
        const preference = config.runtime ?? "auto";
        runtimePreference = preference;
        const containerized = isContainerized();
        if (containerized) {
          app.debug(
            "Signal K is running inside a container. Container runtime " +
              "must be exposed (podman/docker socket + binary) for this plugin to work.",
          );
        }
        app.debug("detecting runtime, preference=%s", preference);
        runtimeInfo = await detectRuntime(preference);
        app.debug("detectRuntime result: %o", runtimeInfo);

        if (!runtimeInfo) {
          // Detection failed — run the deployment doctor to extract a
          // copy-pasteable remediation. Goes to app.error so the lines
          // land in the Signal K server log; setPluginError stays
          // short because it shows inline in the admin UI.
          const doctor = await selfDeployment(preference);
          const headline = headlineForDoctorStatus(doctor.status);
          app.setPluginError(
            `${headline}. See GET /plugins/signalk-container/api/doctor/deployment for details.`,
          );
          if (doctor.remediation.length > 0) {
            app.error(
              `signalk-container deployment doctor — ${headline}:\n${doctor.remediation.join("\n")}`,
            );
          }
          localResolveReady();
          return;
        }

        const hostUser = runtimeInfo.hostUser;
        app.debug(
          `runtime ready: ${runtimeInfo.runtime} ${runtimeInfo.version}` +
            `, rootless=${runtimeInfo.isRootless ?? "unknown"}` +
            `, hostUser=${hostUser ? `${hostUser.uid}:${hostUser.gid}` : "unavailable"}` +
            `, containerized=${containerized}`,
        );

        const statusPrefix = containerized ? "(in-container) " : "";
        app.setPluginStatus(
          `${statusPrefix}${runtimeInfo.runtime} ${runtimeInfo.version}${runtimeInfo.isPodmanDockerShim ? " (podman shim)" : ""}`,
        );

        if (config.pruneSchedule && config.pruneSchedule !== "off") {
          const intervalMs =
            config.pruneSchedule === "weekly"
              ? 7 * 24 * 60 * 60 * 1000
              : 30 * 24 * 60 * 60 * 1000;
          pruneTimer = setInterval(async () => {
            try {
              const result = await pruneImages(runtimeInfo!);
              app.debug(
                `Pruned ${result.imagesRemoved} images, reclaimed ${result.spaceReclaimed}`,
              );
            } catch (err) {
              app.error("Auto-prune failed:", err);
            }
          }, intervalMs);
        }

        app.debug("Container manager started");
        localResolveReady();
      })().catch((err) => {
        app.setPluginError(
          `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        localResolveReady();
      });
    },

    stop() {
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
      for (const timer of healthTimers.values()) {
        clearInterval(timer);
      }
      healthTimers.clear();
      if (updateService) {
        updateService.stop();
        updateService = null;
      }
      manifestStore = null;
      lastConfigs.clear();
      lastVolumeIssues.clear();
      // Force-close every broker; SSE clients still attached receive
      // `event: end` and disconnect.  `podman logs -f` children get
      // SIGTERM via the broker's stop-tail path.
      for (const broker of logStreamBrokers.values()) {
        broker.close("plugin-stopped");
      }
      logStreamBrokers.clear();
      perCallOnContainerLogUnsub.clear();
      effectiveResources.clear();
      pluginDefaults.clear();
      currentOverrides = {};
      currentConfig = null;
      cachedDataSource = null;
      pendingDataSource = null;
      cachedConfigRootSource = null;
      pendingConfigRootSource = null;
      cachedSignalkNetworks = undefined;
      pendingNetworks = null;
      portAddressMap.clear();
      registeredPorts.clear();
      delete (globalThis as any).__signalk_containerManager;
    },

    registerWithRouter(router: IRouter) {
      router.get("/api/runtime", (_req, res) => {
        if (!runtimeInfo) {
          res.status(503).json({ error: "No container runtime available" });
          return;
        }
        res.json(runtimeInfo);
      });

      router.get("/api/containers", async (_req, res) => {
        try {
          const containers = await api.listContainers();
          res.json(containers);
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.get("/api/containers/:name/state", async (req, res) => {
        try {
          const state = await api.getState(String(req.params.name));
          res.json({ name: req.params.name, state });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.get("/api/containers/:name/resources", async (req, res) => {
        if (!runtimeInfo) {
          res.status(503).json({ error: "No container runtime available" });
          return;
        }
        const name = String(req.params.name);
        // For containers we manage via ensureRunning, return the
        // declared/merged effective limits — these are authoritative
        // and round-trip with the override editor below.
        let effective = api.getResources(name);
        // For one-shot job containers (`sk-job-*`), `effectiveResources`
        // has no entry — runJob applies `--cpus N` etc. at run-time and
        // never registers the container with the manager. Read the live
        // cgroup state straight from `podman inspect` so the UI can
        // show "1 CPU" / "512m" instead of "No resource limits set".
        // This is read-only by design; a job container is destined to
        // exit on its own and editing limits on it makes no sense.
        if (Object.keys(effective).length === 0 && name.startsWith("job-")) {
          try {
            effective = await getLiveResources(runtimeInfo, name);
          } catch (err) {
            // Best-effort. Falling back to {} keeps the existing
            // "No resource limits set" empty state for unreachable
            // containers, which is the prior behaviour. Log so a
            // recurring inspect failure is at least visible in
            // server debug output rather than silently invisible.
            app.debug(
              `getResources(${name}) job fallback failed (runtime=${runtimeInfo.runtime} ${runtimeInfo.version}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        res.json({
          name,
          effective,
          override: currentOverrides[name] ?? null,
        });
      });

      router.post("/api/containers/:name/resources", async (req, res) => {
        if (!runtimeInfo) {
          res.status(503).json({ error: "No container runtime available" });
          return;
        }
        const name = String(req.params.name);
        const limits = (req.body ?? {}) as ContainerResourceLimits;
        try {
          const result = await api.updateResources(name, limits);
          res.json({
            name,
            ...result,
            effective: api.getResources(name),
            // Mirror what GET returns so the frontend can derive its
            // "Override active" badge from a single source (POST
            // response on click, GET response on reload).
            override: currentOverrides[name] ?? null,
          });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      /**
       * Clear any user override for a container and restore the
       * consumer plugin's pristine default resource limits. The
       * plugin default is captured at the top of api.ensureRunning
       * (pluginDefaults map) before the merge layer mixes in any
       * override — this endpoint restores the pure default state,
       * which is IMPOSSIBLE to express via the normal POST route
       * (POST with `{}` would leave the container with no limits,
       * not the default limits).
       *
       * Requires that the consumer plugin has called ensureRunning
       * at least once, otherwise there's nothing to reset to.
       */
      router.delete("/api/containers/:name/resources", async (req, res) => {
        if (!runtimeInfo) {
          res.status(503).json({ error: "No container runtime available" });
          return;
        }
        const name = String(req.params.name);
        const pluginDefault = pluginDefaults.get(name);
        if (!pluginDefault) {
          res.status(404).json({
            error:
              `No plugin default recorded for ${name}. The consumer plugin ` +
              `must call ensureRunning() first (which happens automatically ` +
              `on plugin startup).`,
          });
          return;
        }
        try {
          // Apply the plugin's pristine default to the running container.
          // This goes through updateResources which handles the usual
          // live-vs-recreate decision AND calls recordOverride at the
          // end — which is the opposite of what we want for "clear the
          // override". So we clear AFTERWARDS (two writes to disk, but
          // correct final state).
          const result = await api.updateResources(name, pluginDefault);
          clearOverride(name);
          res.json({
            name,
            cleared: true,
            ...result,
            effective: api.getResources(name),
            override: null,
          });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.post("/api/containers/:name/stop", async (req, res) => {
        try {
          await api.stop(req.params.name);
          res.json({ status: "stopped" });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.post("/api/containers/:name/start", async (req, res) => {
        try {
          await api.start(req.params.name);
          res.json({ status: "started" });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.post("/api/containers/:name/remove", async (req, res) => {
        try {
          await api.remove(req.params.name);
          res.json({ status: "removed" });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      // One-shot log fetch (no streaming).  Defaults `tail=200`,
      // max 10000 (enforced inside getContainerLogs).  `since` is
      // unix-epoch seconds.  Used by the UI Logs modal to paint
      // initial history before opening the SSE stream.
      router.get("/api/containers/:name/logs", async (req, res) => {
        if (!runtimeInfo) {
          res.status(503).json({ error: "No container runtime available" });
          return;
        }
        // Validate query params at the boundary.  Reject non-integer
        // and negative values with 400 — `getContainerLogs` clamps
        // server-side but that's a fallback, not a substitute for
        // input validation at the public surface.  See
        // `parsePositiveIntQuery` in containers.ts (exported so it
        // can be tested in isolation).
        const tailParse = parsePositiveIntQuery(req.query.tail, "tail");
        if (tailParse.error) {
          res.status(400).json({ error: tailParse.error });
          return;
        }
        const sinceParse = parsePositiveIntQuery(req.query.since, "since");
        if (sinceParse.error) {
          res.status(400).json({ error: sinceParse.error });
          return;
        }
        const tail = tailParse.value;
        const since = sinceParse.value;
        const name = req.params.name;
        // Deterministic 404 detection — match the stream route.  Don't
        // regex stderr (locale + runtime-specific phrasing); ask the
        // runtime directly whether the container exists.
        try {
          const state = await getContainerState(runtimeInfo, name);
          if (state === "missing") {
            res.status(404).json({ error: `No such container: ${name}` });
            return;
          }
        } catch (err) {
          res.status(503).json({
            error: `Failed to inspect container runtime: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          return;
        }
        try {
          const lines = await api.getLogs(name, { tail, since });
          res.json({ name, lines });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      // SSE stream of live log lines.  Subscriber to the per-container
      // broker; auto-disconnects when the client goes away.  Closes
      // with `event: end` when the container is removed or the plugin
      // is stopped.  See `LogStreamBroker` for fan-out semantics.
      router.get("/api/containers/:name/logs/stream", async (req, res) => {
        if (!runtimeInfo) {
          res.status(503).json({ error: "No container runtime available" });
          return;
        }
        const { name } = req.params;
        // Preflight: don't open the SSE stream against a container
        // that doesn't exist.  Otherwise the client connects, gets
        // 200, and immediately receives `event: end` from the
        // broker's `onTailError` — visually confusing and wastes a
        // round-trip on an obvious 404.  Wrap the inspect call —
        // `getContainerState` can throw if the runtime is busy or
        // exec itself fails, and we still want a clean JSON error.
        try {
          const state = await getContainerState(runtimeInfo, name);
          if (state === "missing") {
            res.status(404).json({ error: `No such container: ${name}` });
            return;
          }
        } catch (err) {
          res.status(503).json({
            error: `Failed to inspect container runtime: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          return;
        }
        // Use setHeader (not writeHead's headers object) so the
        // headers are locked onto the response object before any
        // upstream compression middleware sees the first chunk.
        // `compression` (which Signal K applies globally) respects
        // `Cache-Control: no-transform` and skips compressing —
        // without this directive, observed in the wild:
        //
        //   Content-Encoding: gzip
        //
        // overriding our `identity` header.  Gzip buffers bytes
        // until it has a full block to emit, so the `hello` frame
        // sits unsent and the modal stays at "Backfilled — opening
        // live stream…" forever.
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Content-Encoding", "identity");
        res.statusCode = 200;
        // Force the headers (and any queued body) onto the wire
        // now — without this, Express keeps the response in a
        // "wait for more" state until `res.end()` or a sufficient
        // body chunk arrives.  For SSE that means the `hello`
        // frame below would sit in the kernel send buffer.
        res.flushHeaders();
        res.write("event: hello\ndata: connected\n\n");

        let broker: LogStreamBroker;
        try {
          broker = getOrCreateBroker(name);
        } catch (err) {
          // Defensive — runtimeInfo was non-null above but could in
          // theory become null between the check and getOrCreateBroker.
          res.write(
            `event: end\ndata: ${err instanceof Error ? err.message : String(err)}\n\n`,
          );
          res.end();
          return;
        }

        const unsub = broker.subscribe({
          onLine: (line) => {
            // Replace any embedded newlines with spaces — SSE `data:`
            // frames are line-oriented and our upstream splitter
            // already emits one line at a time, so this is defensive.
            const safeLine = line.replace(/[\r\n]+/g, " ");
            // Guard the write: a client disconnect can fire between
            // the broker emitting a line and node delivering it to
            // this callback, and `res.write` on an ended/destroyed
            // response throws ERR_STREAM_WRITE_AFTER_END.  Without
            // this guard the throw would propagate up through the
            // broker fan-out and noisily route via `onTailError`.
            if (res.writableEnded || res.destroyed) return;
            try {
              res.write(`data: ${safeLine}\n\n`);
            } catch {
              /* connection already gone; req.close handler will fire */
            }
          },
          onClose: (reason) => {
            // Same race as onLine: client may have disconnected
            // before this fires.  res.write/res.end on an ended
            // response throws ERR_STREAM_WRITE_AFTER_END.
            if (res.writableEnded || res.destroyed) return;
            try {
              res.write(`event: end\ndata: ${reason}\n\n`);
              res.end();
            } catch {
              /* connection already gone */
            }
          },
        });

        // Heartbeat keeps reverse-proxy idle timeouts at bay during
        // quiet container periods.  Sent as an SSE comment frame
        // (single `:` line) — clients ignore it.  `unref()` so the
        // timer doesn't hold the event loop open during shutdown;
        // req.on("close") clears it on normal disconnect.
        const heartbeat = setInterval(() => {
          try {
            res.write(": heartbeat\n\n");
          } catch {
            /* connection already gone; req.close handler will fire */
          }
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref();

        req.on("close", () => {
          clearInterval(heartbeat);
          unsub();
          const live = logStreamBrokers.get(name);
          if (live && !live.isClosed() && live.subscriberCount() === 0) {
            // Last subscriber went away — the broker stopped its
            // tail in `unsub()`; drop the Map entry so a fresh
            // subscribe later spawns a new broker.
            logStreamBrokers.delete(name);
          }
        });
      });

      router.post("/api/prune", async (_req, res) => {
        try {
          const result = await api.prune();
          res.json(result);
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      // Doctor probes. POST so callers send a JSON body with the image
      // ref and optional user spec; GET would clutter the path with
      // query-encoded values that can't carry a structured `user`.
      router.post("/api/doctor/image", async (req, res) => {
        const body = (req.body ?? {}) as {
          image?: unknown;
          tag?: unknown;
          user?: ContainerConfig["user"];
        };
        if (typeof body.image !== "string" || body.image.length === 0) {
          res
            .status(400)
            .json({ error: "Request body must include a non-empty `image`." });
          return;
        }
        const ref =
          typeof body.tag === "string" && body.tag.length > 0
            ? `${body.image}:${body.tag}`
            : body.image;
        try {
          const result = await api.doctor.imageRunsAsUser(ref, body.user);
          res.json(result);
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      // Deployment doctor. Unlike the image probe this is a GET — no
      // body, idempotent, and the response is the operator-facing
      // diagnosis of "why isn't the runtime up?". Re-runs the probe on
      // each call; the cost is at most three execFile invocations.
      router.get("/api/doctor/deployment", async (_req, res) => {
        try {
          const result = await api.doctor.selfDeployment();
          res.json(result);
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      // Update detection routes (registered if and only if the
      // service was instantiated in start()).
      if (updateService) {
        registerUpdateRoutes(router, updateService, () => runtimeInfo !== null);
      }
    },
  };

  return plugin;
};

/**
 * Map a `SelfDeploymentResult.status` to the short, single-line text
 * shown in `app.setPluginError` (the admin UI surface). The full
 * remediation block goes to `app.error` separately — this is just the
 * headline operators see at a glance.
 */
function headlineForDoctorStatus(
  status: SelfDeploymentResult["status"],
): string {
  switch (status) {
    case "no-runtime":
      return "No container runtime found";
    case "socket-unreachable":
      return "Runtime socket unreachable";
    case "permission-denied":
      return "Runtime socket: permission denied";
    case "self-id-unresolved":
      return "Signal K container ID unresolved";
    case "ok":
      return "Runtime ready";
  }
}

function parseDurationOrDefault(
  input: string | undefined,
  fallback: number,
): number {
  if (!input) return fallback;
  const m = input.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) return fallback;
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
      return fallback;
  }
}
