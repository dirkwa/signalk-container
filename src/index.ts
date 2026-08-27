import { IRouter } from "express";
import path from "node:path";
import { existsSync, promises as fsp } from "node:fs";
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
  CpuPriority,
  DoctorApi,
  EnsureRunningOptions,
  HistoryEntry,
  ManagedImageRef,
  ManifestApi,
  PluginConfig,
  PruneResult,
  ResolveResult,
  RuntimePreference,
  SelfDeploymentResult,
  SetupSnippetFormat,
  SetupSnippetResult,
  DeviceIssue,
  UpdateResourcesResult,
  VolumeIssue,
} from "./types.js";
import {
  clampCpusToHost,
  fieldsRequiringRecreateForUnset,
  filterUnsupportedLimits,
  mergeResourceLimits,
  minimizeOverride,
  resourceLimitsEqual,
  tryLiveUpdate,
} from "./resources.js";
import { detectRuntime, isContainerized, setDisableUserns } from "./runtime.js";
import { setNamespace, resetNamespace } from "./namespace.js";
import {
  makeDegradationEmitter,
  type NotificationApp,
} from "./notifications.js";
import { resetClient } from "./client.js";
import {
  classifyVolumeSources,
  type VolumeSourceState,
  collectRecoveredVolumes,
  defaultHomeForConfigRoot,
  defaultTimezoneEnv,
  connectToNetwork,
  disconnectFromNetwork,
  ensureNetwork,
  ensureRunning,
  execInContainer,
  collectManagedImageRefs as collectManagedImageRefsFromManifests,
  getActualPortBindings,
  getContainerLastError,
  getContainerLogs,
  getContainerState,
  getImageDigest,
  getLiveContainerDigest,
  getLiveResources,
  getRepoDigest,
  getRequestedResources,
  imageExists,
  listContainers,
  findSelfContainerId,
  parsePositiveIntQuery,
  prefixedName,
  pruneImages,
  pullImage,
  readContainerNofile,
  runScheduledPrune,
  qualifyImage as qualifyImageForRuntime,
  removeContainer,
  removeManagedData,
  removeNetwork,
  WIPE_MOUNT_PATH,
  findAvailablePort,
  releaseReservedPort,
  resolveHostPath,
  resolveHostTimezone,
  resolveSignalkDataSource,
  resolveSignalkNetworks,
  safeInvokeContainerLog,
  safeInvokeDeviceIssue,
  safeInvokeUnhealthy,
  safeInvokeVolumeIssue,
  startContainer,
  stopContainer,
  tailContainerLogs,
  safeInvokeResourceClamped,
} from "./containers.js";
import { createLogStreamBroker, LogStreamBroker } from "./log-stream-broker.js";
import { runJob, cleanupOrphanedJobs } from "./jobs.js";
import type { ProbeCacheEntry } from "./devices.js";
import {
  probeHostDevice,
  parseProbeOutput,
  PROBE_MOUNT,
  PROBE_GROUP_MOUNT,
  cachedProbe,
  nameSelfMountedNodes,
  PROBE_SELF_MARKER,
  PROBE_TIMEOUT_MS,
  PROBE_CACHE_MS,
} from "./devices.js";
import { UpdateService } from "./updates/service.js";
import { FileUpdateCache } from "./updates/cache.js";
import { registerUpdateRoutes } from "./updates/routes.js";
import { DIGEST_RE, resolveImage } from "./manifest/resolver.js";
import { ManifestStore } from "./manifest/store.js";
import {
  CPU_PRIORITIES,
  DEFAULT_CONTAINER_CPU_PRIORITY,
  DEFAULT_JOB_CPU_PRIORITY,
  DEFAULT_KEEP_IMAGE_VERSIONS,
  cpuPriorityLimits,
  normalizeCpuPriority,
  normalizeKeepImageVersions,
} from "./configNormalize.js";
import { PruneScheduler, FilePruneStateStore } from "./pruneScheduler.js";
import {
  generateSetupSnippet,
  imageRunsAsUser,
  doctorSurfacing,
  isDashboardDeploymentError,
  selfDeployment,
} from "./doctor.js";

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
  /**
   * Managed-notification API (SignalK server ≥ 2.30.0). `raise` returns a
   * NotificationId that `clear` later removes. Reuses
   * `NotificationApp["notifications"]` (defined in `./notifications.js`) as
   * the single source of truth for the shape, so the plugin and the emitter
   * can't drift — e.g. one sprouting a `method` field the other lacks
   * (deliberately absent: the emitter states severity only, the server's
   * NotificationManager owns presentation, RFC notification-handling §6.1).
   * That shape is declared locally rather than imported from
   * `@signalk/server-api` because the pinned type (2.24.0) doesn't yet
   * expose `raise`/`clear` — the running server does. Optional, so an older
   * server (where it is undefined) degrades to the existing surfacing.
   */
  notifications?: NotificationApp["notifications"];
  [key: string]: unknown;
}

/**
 * SSE comment-frame heartbeat interval.  30s is comfortably below
 * common reverse-proxy idle-read timeouts (nginx default 60s) but
 * not so frequent that quiet streams pay a noticeable cost.
 */
const SSE_HEARTBEAT_MS = 30_000;

const HEALTH_POLL_MS = 60_000;

// `DEFAULT_KEEP_IMAGE_VERSIONS` and `normalizeKeepImageVersions` live in
// `./configNormalize.js` so the backend and the React config panel share
// one contract — a browser-safe module with no node-only imports.

export default (app: App) => {
  let runtimeInfo: ContainerRuntimeInfo | null = null;
  let runtimePreference: RuntimePreference = "auto";
  let pruneScheduler: PruneScheduler | null = null;
  const healthTimers = new Map<string, NodeJS.Timeout>();
  // Guards against overlapping health polls per container: a slow check must
  // not race a later one and overwrite the emitter's edge-triggered health
  // state out of order.
  const healthPollsInFlight = new Set<string>();
  let updateService: UpdateService | null = null;
  let manifestStore: ManifestStore | null = null;

  // Degradation notifications (notifications.container.*) — see
  // src/notifications.ts. Additive: a parallel channel next to the existing
  // log / plugin-status / consumer-callback surfacing. Enabled state is set
  // from config in start(); until then it defaults on.
  const degradation = makeDegradationEmitter(app);

  // Commit the device issues of an ensureRunning transition to
  // lastDeviceIssues AND mirror the `unresolved` subset onto the
  // deviceUnresolved notification, so the doctor state and the notification
  // can never diverge. Called from all three commit sites (initial,
  // recreate, rollback).
  const commitDeviceIssues = (name: string, issues: DeviceIssue[]): void => {
    if (issues.length > 0) lastDeviceIssues.set(name, issues);
    else lastDeviceIssues.delete(name);
    degradation.syncDeviceIssues(name, issues);
  };

  // Raise/clear the host-level deploymentDegraded notification off a doctor
  // result. Shared by both start() branches — runtime-detection failure
  // (no-runtime / socket-unreachable) and the runtime-up-but-host-degraded
  // recheck — so every dashboard-error status is covered identically.
  const surfaceDeploymentDoctor = (doctor: SelfDeploymentResult): void => {
    if (isDashboardDeploymentError(doctor.status)) {
      degradation.raise(
        "deploymentDegraded",
        "",
        "warn",
        headlineForDoctorStatus(doctor.status),
        { status: doctor.status, remediation: doctor.remediation },
      );
    } else {
      degradation.clear("deploymentDegraded", "");
    }
  };

  /**
   * Build the reaper's view of managed images: every container recorded
   * in a manifest, paired with the immutable image-ID it is currently
   * running (or null when missing). The manifest store is the only
   * registry that survives a restart, so it — not the in-memory
   * `lastConfigs` — is the source of truth for "what do we manage".
   */
  async function collectManagedImageRefs(
    runtime: ContainerRuntimeInfo,
  ): Promise<ManagedImageRef[]> {
    if (!manifestStore) return [];
    return collectManagedImageRefsFromManifests(
      runtime,
      await manifestStore.list(),
      (msg) => app.debug(msg),
    );
  }

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
  // Device-passthrough events from the most recent ensureRunning() call
  // per container, feeding the doctor's devicePassthrough section. The
  // inner ensureRunning fires events at create time and re-fires
  // `unresolved` on every reconcile of a container carrying
  // DEVICES_UNRESOLVED_LABEL, so committing per call (and clearing on a
  // quiet call) keeps this current across restarts and recoveries.
  const lastDeviceIssues = new Map<string, DeviceIssue[]>();

  /**
   * Build the `onDeviceIssue` interceptor shared by every path that calls
   * `ensureRunning` (the API wrapper AND the resource-update recreate) so
   * device-passthrough events are collected, logged at the right level
   * (`optimistic` is informational; the rest are actionable), forwarded to
   * the consumer's own handler, and committed to `lastDeviceIssues` for
   * the doctor. Returns the collected list and the handler; the caller
   * commits `issues` to `lastDeviceIssues` (set when non-empty, delete
   * when quiet) only after its `ensureRunning` succeeds.
   */
  function makeDeviceIssueCollector(
    name: string,
    consumerHandler?: (event: DeviceIssue) => void | Promise<void>,
  ): { issues: DeviceIssue[]; onDeviceIssue: (event: DeviceIssue) => void } {
    const issues: DeviceIssue[] = [];
    return {
      issues,
      onDeviceIssue: (event) => {
        if (
          !issues.some(
            (e) =>
              e.entry === event.entry &&
              e.hostPath === event.hostPath &&
              e.action === event.action,
          )
        ) {
          issues.push(event);
          if (event.action === "optimistic") {
            app.debug(`ensureRunning(${name}): ${event.reason}`);
          } else {
            app.error(`ensureRunning(${name}): ${event.reason}`);
          }
        }
        safeInvokeDeviceIssue(consumerHandler, event, (err) =>
          app.error(
            `ensureRunning(${name}): onDeviceIssue handler threw for ` +
              `${event.hostPath} (${event.action}): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    };
  }

  /**
   * Doctor section built from `lastDeviceIssues`. `null` when quiet so
   * the doctor renders nothing. Advice lines cover the two actionable
   * states: unverified emissions (mount the path into the Signal K
   * container for full fidelity) and host-rejected entries (attach the
   * device; retried on the next recreate).
   */
  function buildDevicePassthroughSection(): SelfDeploymentResult["devicePassthrough"] {
    const issues: NonNullable<
      SelfDeploymentResult["devicePassthrough"]
    >["issues"] = [];
    for (const [container, events] of lastDeviceIssues) {
      for (const e of events) {
        issues.push({
          container,
          entry: e.entry,
          hostPath: e.hostPath,
          action: e.action,
          reason: e.reason,
        });
      }
    }
    if (issues.length === 0) return null;
    const paths = (action: DeviceIssue["action"]): string[] => [
      ...new Set(
        issues.filter((i) => i.action === action).map((i) => i.hostPath),
      ),
    ];
    const unresolved = paths("unresolved");
    const optimistic = paths("optimistic").filter(
      (p) => !unresolved.includes(p),
    );
    const skipped = paths("skipped");
    const advice: string[] = [];
    if (optimistic.length > 0) {
      advice.push(
        `Signal K runs containerized and cannot verify ${optimistic.join(", ")} locally; ` +
          `the bind is emitted for the runtime to resolve on the host. For full drift ` +
          `fidelity, mount the path into the Signal K container read-only:`,
      );
      for (const p of optimistic) {
        advice.push(
          `  compose/run: -v ${p}:${p}:ro   quadlet: Volume=${p}:${p}:ro`,
        );
      }
    }
    if (unresolved.length > 0) {
      advice.push(
        `Missing on the host: ${unresolved.join(", ")}. Attach or enable the device ` +
          `(e.g. plug in the USB audio card, load the driver); the entry is retried ` +
          `automatically on the next container recreate.`,
      );
    }
    if (skipped.length > 0) {
      advice.push(
        `Missing at create time (device unplugged?): ${skipped.join(", ")}. The ` +
          `container started without it; recreate the container once the device is back.`,
      );
    }
    const groupSkipped = [
      ...new Set(
        issues.filter((i) => i.action === "group-skipped").map((i) => i.entry),
      ),
    ];
    if (groupSkipped.length > 0) {
      advice.push(
        `groupAdd names not found in the host's /etc/group: ${groupSkipped.join(", ")}. ` +
          `The container started without them; create the group on the host (or use a ` +
          `numeric GID) and recreate the container.`,
      );
    }
    return { issues, advice };
  }
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
  // Plugin-wide CPU priority tiers from config; the container tier sits
  // underneath each consumer's `resources`, the job tier underneath each
  // `runJob` caller's `resources`.
  let containerCpuPriority: CpuPriority = DEFAULT_CONTAINER_CPU_PRIORITY;
  let jobCpuPriority: CpuPriority = DEFAULT_JOB_CPU_PRIORITY;
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
  // `undefined` = not yet resolved; `null` = bare-metal semantics (not
  // containerized, SignalK itself host-networked, or inspect failed);
  // `string[]` = resolved successfully.
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
  /** Short-lived probe results, keyed by path. See probeHostDevice below. */
  const probeCache = new Map<string, ProbeCacheEntry>();

  /**
   * An image already on this host that can run the probe.
   *
   * Never pulls: a device check must not depend on the network, and returning
   * "unknown" is better than fetching something. Candidates are the images of
   * containers already running here, so they are on disk by definition.
   *
   * Sorted before use: `listContainers` order is not stable, and an unstable
   * choice would make the probe pick a different image run to run — harmless
   * but untraceable when one of them turns out not to work.
   *
   * The probe command needs a POSIX `sh` with `stat`; a distroless or scratch
   * image has neither. Rather than guess, the caller treats a failed job as
   * "unknown" and moves on, so a bad candidate costs one cheap failed
   * container, not a wrong answer.
   */
  async function findLocalProbeImages(
    runtime: ContainerRuntimeInfo,
  ): Promise<string[]> {
    const running = await listContainers(runtime).catch(() => []);
    return [
      ...new Set(running.map((info) => info.image).filter(Boolean)),
    ].sort();
  }

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

  // Shared post-removal teardown for every path that removes a container
  // (`remove`, `removeManagedData`): release reserved host ports, then tear
  // down the log-stream broker so SSE clients get `event: end` and the
  // underlying `logs -f` stops. Keeping this in one place stops the paths
  // from drifting (e.g. a future broker-teardown change reaching only one).
  function afterContainerRemoved(name: string): void {
    evictContainerAddresses(name);
    const broker = logStreamBrokers.get(name);
    if (broker) {
      broker.close("container-removed");
      logStreamBrokers.delete(name);
    }
    perCallOnContainerLogUnsub.delete(name);
    lastDeviceIssues.delete(name);
    // Stop the health-check timer for the removed container — otherwise it
    // keeps firing pollHealth against a container that no longer exists,
    // re-raising the unhealthy notification we clear just below every 60s
    // with no unhealthy→healthy edge left to clear it again.
    const healthTimer = healthTimers.get(name);
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimers.delete(name);
    }
    healthPollsInFlight.delete(name);
    // A removed container's degradation alerts must not linger.
    degradation.clear("unhealthy", name);
    degradation.clear("deviceUnresolved", name);
    degradation.clear("volumeAborted", name);
    degradation.forgetContainer(name);
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

  /**
   * Can this process establish whether a host bind source exists?
   *
   * Bare metal: yes -- this filesystem IS the host's, so `existsSync` is the
   * final answer, present or absent.
   *
   * Containerized: no, in general. The runtime resolves a bind source against
   * the HOST filesystem, which this process cannot see; `existsSync` here
   * answers about a different filesystem entirely and reports a real host
   * directory as missing. Return "unknown" so the caller keeps the volume and
   * lets the runtime decide against the real thing.
   *
   * The exception is a path this container has itself mounted: it is visible
   * here AND backed by a host source, so a positive result is trustworthy. A
   * negative one still is not -- absence inside this filesystem does not prove
   * absence on the host -- so only `true` is promoted out of it.
   */
  function probeVolumeSource(hostPath: string): VolumeSourceState {
    if (!isContainerized()) return existsSync(hostPath);
    return existsSync(hostPath) ? true : "unknown";
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

      // Propagate the host timezone before any other config shaping so
      // the injected TZ flows into lastConfigs and drift detection like
      // any consumer-set env key.
      config = {
        ...config,
        env: defaultTimezoneEnv(config.env, resolveHostTimezone()),
      };

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
          env: defaultHomeForConfigRoot(rest.env, signalkConfigRootMount),
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

        // resolveSignalkNetworks returns null when running bare-metal, when
        // the SignalK container itself uses host networking, or when docker
        // inspect fails (e.g. self-id undetectable). In all cases we fall
        // back to publishing ports on 127.0.0.1 — the SignalK process can
        // reach them on the loopback whether it is bare-metal or on the
        // host network.
        const networks = isContainerized()
          ? await ensureCachedSignalkNetworks()
          : null;
        const targetNetwork = networks?.[0] ?? null;

        if (networks === null) {
          // ── Bare-metal OR host-network container ──────────────────────
          // Bind each port to 127.0.0.1. Prefer the declared port number;
          // step over it if already in use.
          const portMappings: Record<string, string> = {};
          // The port cache dies with the plugin, so on the first call after
          // a server restart consult the live container's actual bindings
          // before probing: findAvailablePort() would collide with the very
          // port our own running container publishes, allocate a fresh one,
          // and the resulting ports drift would recreate the container on
          // every restart.
          let liveBindings: Awaited<ReturnType<typeof getActualPortBindings>> =
            new Map();
          if (
            signalkAccessiblePorts.some(
              (p) => !portAddressMap.has(`${name}:${p}`),
            )
          ) {
            try {
              liveBindings = await getActualPortBindings(runtimeInfo, name);
            } catch {
              // Non-fatal: fall through to probing.
            }
          }
          for (const containerPort of signalkAccessiblePorts) {
            // Reuse a previously COMMITTED host port for this container+port
            // so that idempotent ensureRunning() calls don't trigger a
            // config change (and therefore an unwanted container recreate).
            const cacheKey = `${name}:${containerPort}`;
            let address = portAddressMap.get(cacheKey);
            if (!address) {
              const live = liveBindings.get(containerPort);
              const chosen =
                live?.find((b) => b.hostIp === "127.0.0.1") ?? live?.[0];
              if (chosen) {
                address = `127.0.0.1:${chosen.hostPort}`;
                pendingPortMap.set(cacheKey, address);
                app.debug(
                  `signalkAccessiblePorts(${name}): reusing live host port ${chosen.hostPort} for ${containerPort}`,
                );
              }
            }
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
          const prefixed = prefixedName(name);
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
          // WHY probe-then-skip-for-own-running-container: findAvailablePort
          // treats every held port as a collision, including the port held by
          // an already-running instance of THIS container. After a restart of
          // SK the managed container is still up on its declared port, which
          // would otherwise throw "port already in use" against ourselves and
          // refuse to start. Only "running" is safe to short-circuit on — a
          // stopped container isn't actually listening, so some other
          // container in the shared namespace might have grabbed the port
          // while we were down. Treat "stopped" like "missing": probe, and
          // surface a real collision if one exists.
          const ownState = await getContainerState(runtimeInfo, name);
          const ownIsRunning = ownState === "running";
          for (const containerPort of signalkAccessiblePorts) {
            const cacheKey = `${name}:${containerPort}`;
            if (!portAddressMap.has(cacheKey)) {
              if (ownIsRunning) {
                pendingPortMap.set(cacheKey, `127.0.0.1:${containerPort}`);
                continue;
              }
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

      // Capture the plugin's default resource limits BEFORE merging with
      // the user override: the plugin-wide CPU priority tier with the
      // consumer's own `resources` on top. This is the only place in the
      // system that sees the "default" as a separate input; lastConfigs
      // stores the post-merge result. We need the default for:
      //   - "Reset to plugin defaults" action in the UI
      //   - minimizing stored overrides to fields that really differ
      const pluginDefault = mergeResourceLimits(
        cpuPriorityLimits(containerCpuPriority),
        config.resources,
      );
      pluginDefaults.set(name, pluginDefault);

      // Merge user override on top of the plugin's default resources.
      // The user override (from signalk-container's own plugin config)
      // wins field-by-field; null in the override removes a limit.
      const merged = mergeResourceLimits(pluginDefault, currentOverrides[name]);
      // Drop fields whose backing cgroup controller is unavailable on
      // this host (Bug B). Log them once so the user knows their
      // override is being ignored. Without this filter, an override
      // with `cpusetCpus` on rootless podman would cause `podman run`
      // to fail with a cryptic OCI error.
      const { accepted: controllerFiltered, dropped } = filterUnsupportedLimits(
        merged,
        runtimeInfo,
      );
      for (const d of dropped) {
        app.debug(
          `ensureRunning(${name}): dropped resources.${d.field}: ${d.reason}`,
        );
      }
      // Cap `cpus` at the daemon's CPU count. Done here, on the object that
      // is created, labelled and later compared against the live container,
      // so the request and the observed value agree on every reconcile.
      // Docker rejects an over-request at create/update time (a 1.5-core
      // plugin default on a 1-vCPU Docker host fails outright).
      const { accepted: filteredMerged, clamped: cpuClamp } = clampCpusToHost(
        controllerFiltered,
        runtimeInfo,
      );
      if (cpuClamp) {
        app.debug(`ensureRunning(${name}): ${cpuClamp.reason}`);
        // Fire-and-forget, like onUlimitClamped: a slow or never-settling
        // handler must not hold up reconciliation.
        safeInvokeResourceClamped(options?.onResourceClamped, cpuClamp, (err) =>
          app.error(
            `ensureRunning(${name}): onResourceClamped handler threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
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
      // The probe answers "unknown" rather than "missing" whenever this
      // process cannot see the host filesystem. When the manager itself runs
      // in a container -- the common deployment -- `existsSync` on a host
      // path checks THIS container's filesystem, not the one the runtime
      // resolves bind sources against. A host directory that plainly exists
      // then reads as absent, and `ifMissing: 'skip'` silently drops a
      // working mount. Consumers worked around it by passing a bare string
      // source, which gives up the skip policy altogether.
      const { kept, skipped, aborted, unverified } = classifyVolumeSources(
        effectiveConfigPreFilter.volumes,
        probeVolumeSource,
      );

      for (const v of unverified) {
        app.debug(
          `ensureRunning(${name}): cannot verify host path ${v.source} from ` +
            `inside this container; keeping volume ${v.containerPath} ` +
            `unverified -- the runtime resolves it against the real host`,
        );
      }

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
        // clear-then-raise so a changed missing-source list refreshes the
        // message: raise() is idempotent per key, so without the clear a
        // second abort with a different `list` would leave the stale message
        // live (same reason pollHealth/syncDeviceIssues clear first).
        degradation.clear("volumeAborted", name);
        degradation.raise(
          "volumeAborted",
          name,
          "alert",
          `${name}: required volume source(s) missing: ${list}`,
          { aborted },
        );
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
      // The cache itself is only advanced AFTER the inner ensureRunning
      // succeeds (below) — writing it here would let a failed transition
      // leave `lastConfigs`/`effectiveResources` claiming a state the
      // container never reached, so a retry's provenance check
      // (`priorConfig.resources`) would miss a stale cap the new config
      // removes.
      const priorConfig = lastConfigs.get(name);
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

      // Intercept device-passthrough events: collect for the doctor's
      // devicePassthrough section (see makeDeviceIssueCollector), forwarding
      // to the consumer's own handler.
      const { issues: deviceIssues, onDeviceIssue } = makeDeviceIssueCollector(
        name,
        options?.onDeviceIssue,
      );
      const innerOptions: EnsureRunningOptions = { ...options, onDeviceIssue };

      try {
        await ensureRunning(
          runtimeInfo,
          name,
          effectiveConfig,
          (msg) => app.debug(msg),
          innerOptions,
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

      // Advance the provenance/recreate-fallback caches only now that the
      // inner transition has succeeded. Post-filter shape — drift detection
      // sees consistent state across calls. On a failed transition above we
      // rethrew, so these keep their prior values and the next attempt's
      // unset check still sees the genuine prior limits.
      lastConfigs.set(name, effectiveConfig);
      effectiveResources.set(name, filteredMerged);
      // Commit device events the same way: a quiet call means the
      // container is running with everything it asked for — clear any
      // stale doctor state (and the deviceUnresolved notification) from
      // earlier calls.
      commitDeviceIssues(name, deviceIssues);
      // Reaching here means the container started with nothing aborted, so
      // clear any prior volumeAborted alert (the missing source reappeared).
      degradation.clear("volumeAborted", name);

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
        const fullName = prefixedName(name);

        // Bug E: if any field is being UNSET and it can't be unset
        // via live update (memory, oomScoreAdj, etc.), the live path
        // would silently no-op. We can't safely recreate from inside
        // ensureRunning's "already running" branch — that would
        // surprise the consumer plugin. Instead, log a clear warning
        // pointing the user to the explicit recreate path.
        //
        // Provenance ladder — what was actually *requested*, so a field
        // present in `postLimits` that never appeared in any request is
        // recognized as a runtime artifact, not a user unset (notably the
        // `oom_score_adj` rootless Podman clamps onto a child container
        // when signalk-server's own oom_score_adj is non-zero):
        //
        //   1. Warm cache: the PRIOR ensureRunning's post-filter
        //      `filteredMerged` (cached in `lastConfigs`, read into
        //      `priorConfig` above before this call overwrote it). Using
        //      the prior request (not the current `filteredMerged`) still
        //      flags a genuine unset: when a user removes a `memory` cap
        //      from `containerOverrides`, the field was in the prior
        //      request and the recreate warning fires.
        //   2. Cold cache (fresh server process): the requested-resources
        //      label stamped on the container at create time — durable
        //      provenance that survives restarts.
        //   3. Neither (container predates the label): `undefined`, NOT
        //      `{}` — an empty object would assert "nothing was ever
        //      requested" and silently suppress a real stale
        //      `memory`/`memorySwap` cap the current config removes.
        //      `undefined` falls back to the plain current-vs-live check
        //      minus runtime-injected fields, so a genuine memory unset
        //      is still surfaced while the inherited oom_score_adj no
        //      longer warns on every server start (#216).
        const priorRequested =
          priorConfig?.resources ?? (await getRequestedResources(name));
        const cannotUnset = fieldsRequiringRecreateForUnset(
          postLimits,
          filteredMerged,
          priorRequested,
        );
        if (cannotUnset.length > 0) {
          app.error(
            `ensureRunning(${name}): cannot live-unset fields ${cannotUnset.join(", ")} on already-running container. ` +
              `These limits will remain at their previous values until the container is recreated. ` +
              `Use POST /plugins/signalk-container/api/containers/${name}/resources to force a recreate.`,
          );
          // Still try to apply the OTHER (settable) fields via live update.
        } else if (
          priorRequested === undefined &&
          postLimits.oomScoreAdj != null &&
          filteredMerged.oomScoreAdj == null
        ) {
          app.debug(
            `ensureRunning(${name}): ignoring live oomScoreAdj=${postLimits.oomScoreAdj} with no provenance — ` +
              `runtime-injected (rootless podman inherits the server's oom_score_adj), not a consumer request`,
          );
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

        // An unhealthy result must never vanish silently: fire the
        // consumer's handler if it wired one, but always also log at error
        // level so a container failing its health check is visible in the
        // server log even when the consumer passed no onUnhealthy. The
        // handler is invoked in its own try/catch — a throwing handler must
        // not re-enter the health-check catch below (which would double-log
        // and let the second throw escape as an unhandled rejection),
        // mirroring the safeInvoke* discipline used for the other callbacks.
        const surfaceUnhealthy = (reason: string): void => {
          app.error(`ensureRunning(${name}): container unhealthy: ${reason}`);
          safeInvokeUnhealthy(options.onUnhealthy, name, reason, (e) =>
            app.error(
              `ensureRunning(${name}): onUnhealthy handler threw: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
          );
        };
        const timer = setInterval(() => {
          // Skip if the previous poll for this container is still running,
          // so a slow health check can't race a later one and clobber the
          // emitter's edge-triggered health state out of order.
          if (healthPollsInFlight.has(name)) return;
          healthPollsInFlight.add(name);
          void degradation
            .pollHealth(name, options.healthCheck!, surfaceUnhealthy)
            .finally(() => healthPollsInFlight.delete(name));
        }, HEALTH_POLL_MS);
        healthTimers.set(name, timer);
      }
    },

    async recreate(
      name: string,
      config: ContainerConfig,
      options?: EnsureRunningOptions,
    ) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      // Always attempt remove. `removeContainer` is idempotent on truly-
      // missing containers (stop errors are swallowed, `rm -f` returns 0),
      // and api.remove's cache evictions / broker teardown are no-ops on
      // a name nobody registered. No need to precondition on getState —
      // that would only add a TOCTOU window before the actual remove.
      // If the runtime does report a real failure, re-check state: a
      // benign disappearance (someone else removed it concurrently) is
      // acceptable; anything else propagates.
      try {
        await api.remove(name);
      } catch (err) {
        const now = await getContainerState(runtimeInfo, name);
        if (now !== "missing") throw err;
      }
      await api.ensureRunning(name, config, options);
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

    async probeHostDevice(path: string) {
      if (!runtimeInfo) return null;
      const runtime = runtimeInfo;

      // Cached: the containerized path spawns a container, and a plugin that
      // polls (a status route, a periodic health check) would otherwise start
      // one per call. Device topology changes on replug, which the hot-plug
      // device mode already handles at the container level, so a short TTL is
      // enough to collapse bursts without going stale in practice.
      return cachedProbe(probeCache, path, Date.now(), PROBE_CACHE_MS, () =>
        probeHostDevice(path, {
          containerized: isContainerized(),
          readDir: (p) => fsp.readdir(p),
          statPath: async (p) => {
            const st = await fsp.stat(p);
            return { isCharacterDevice: st.isCharacterDevice(), gid: st.gid };
          },
          readFile: (p) => fsp.readFile(p, "utf8"),
          debug: app.debug,
          // Runs inside a container so the HOST's view of the path is what gets
          // read. Uses an image already on disk — a device check must not depend
          // on the network, and returning "unknown" is better than pulling.
          runInContainer: async (hostPath) => {
            const images = await findLocalProbeImages(runtime);
            if (images.length === 0) {
              app.debug(
                `probeHostDevice: no local image available to probe ${hostPath}`,
              );
              return null;
            }
            // Try each in turn: the command needs a POSIX `sh` with `stat`, and a
            // distroless or scratch image has neither. One bad candidate costs a
            // cheap failed container, not a wrong answer.
            for (const image of images) {
              const result = await runJob(runtime, {
                image,
                entrypoint: ["sh", "-c"],
                // Node names with their gids, then the HOST's group file.
                //
                // The host's, not the probe image's: the gids on those nodes are
                // the host's, and a probe image will not have the same ones. An
                // Alpine probe has no gid 44 at all, so reading its own
                // /etc/group turned `video` into the bare number "44".
                command: [
                  // The mount is either the device node itself or a directory of
                  // them; handle both, as the local path does.
                  //
                  // Nothing caller-supplied is interpolated here: the command
                  // names only the two constant mount points. A node mount reports
                  // the literal marker below, and the caller substitutes the real
                  // device name — putting the path in the shell string instead
                  // would let a device path containing quotes break out of it.
                  `if [ -c ${PROBE_MOUNT} ]; then echo "N ${PROBE_SELF_MARKER} $(stat -c %g ${PROBE_MOUNT})"; ` +
                    `else for f in ${PROBE_MOUNT}/*; do [ -c "$f" ] && echo "N $(basename "$f") $(stat -c %g "$f")"; done; fi; ` +
                    `echo "---"; cat ${PROBE_GROUP_MOUNT} 2>/dev/null || true`,
                ],
                inputs: {
                  [PROBE_MOUNT]: hostPath,
                  [PROBE_GROUP_MOUNT]: "/etc/group",
                },
                label: "probe-host-device",
                // Bounded: listing a handful of device nodes takes milliseconds,
                // so anything slower is a wedged container, and a device check
                // must never hang the plugin that asked.
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
              });
              if (result.status !== "completed") {
                app.debug(
                  `probeHostDevice: probe with ${image} failed: ${result.error ?? "unknown"}`,
                );
                continue;
              }
              const parsed = parseProbeOutput(result.log.join("\n"));
              return {
                ...parsed,
                nodes: nameSelfMountedNodes(parsed.nodes, hostPath),
              };
            }
            return null;
          },
        }),
      );
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
      afterContainerRemoved(name);
    },

    async removeManagedData(
      name: string,
      hostPath: string,
      options?: { ownerPluginId?: string },
    ): Promise<void> {
      if (!runtimeInfo) throw new Error("No container runtime available");
      const runtime = runtimeInfo;
      // The in-userns fallback runs the container's OWN image (already on
      // disk) so cleanup never pulls. The wipe job mounts the data dir as an
      // output (read-write, no `:ro`) and clears its contents — including
      // dotfiles — from inside the userns as in-container root, which owns the
      // subuid-owned files. `rm -rf` on the mount POINT itself would fail with
      // "device or resource busy", so we delete the contents and let
      // removeManagedData drop the now-empty host-owned parent host-side.
      const runWipeJob = async (image: string, dir: string) => {
        const result = await runJob(runtime, {
          image,
          resources: cpuPriorityLimits(jobCpuPriority),
          // Override the image's ENTRYPOINT: the wipe reuses the managed
          // container's own image (e.g. questdb, whose entrypoint launches the
          // DB), so the shell command must run directly, not as args to that
          // entrypoint.
          entrypoint: ["sh", "-c"],
          command: [
            `rm -rf "${WIPE_MOUNT_PATH}"/* "${WIPE_MOUNT_PATH}"/.[!.]* "${WIPE_MOUNT_PATH}"/..?* 2>/dev/null; true`,
          ],
          outputs: { [WIPE_MOUNT_PATH]: dir },
          label: "remove-managed-data",
          ownerPluginId: options?.ownerPluginId,
        });
        return {
          ok: result.status === "completed",
          error: result.error,
        };
      };
      // afterContainerRemoved is passed as onRemoved so it fires exactly when
      // the container is removed — not on a pre-removal failure (unsafe path,
      // a non-404 inspect error) where the container is still running, and
      // still on a post-removal data-delete failure where it is already gone.
      await removeManagedData(
        runtime,
        name,
        hostPath,
        runWipeJob,
        undefined,
        () => afterContainerRemoved(name),
      );
    },

    async getState(name: string): Promise<ContainerState> {
      if (!runtimeInfo) return "no-runtime";
      return getContainerState(runtimeInfo, name);
    },

    async getContainerNofile(
      name: string,
    ): Promise<{ soft: number; hard: number } | null> {
      if (!runtimeInfo) return null;
      return readContainerNofile(name);
    },

    async runJob(config: ContainerJobConfig): Promise<ContainerJobResult> {
      if (!runtimeInfo) throw new Error("No container runtime available");
      return runJob(runtimeInfo, {
        ...config,
        env: defaultTimezoneEnv(config.env, resolveHostTimezone()),
        resources: mergeResourceLimits(
          cpuPriorityLimits(jobCpuPriority),
          config.resources,
        ),
      });
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

      const fullName = prefixedName(name);
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
      const { accepted: controllerFiltered, dropped } = filterUnsupportedLimits(
        mergedTarget,
        runtimeInfo,
      );
      for (const d of dropped) {
        const w = `dropped resources.${d.field}: ${d.reason}`;
        warnings.push(w);
        app.debug(`updateResources(${name}): ${w}`);
      }
      // Same CPU cap as the ensureRunning path — `docker update` validates
      // NanoCpus against the host just like create does.
      const { accepted: filteredLimits, clamped: cpuClamp } = clampCpusToHost(
        controllerFiltered,
        runtimeInfo,
      );
      if (cpuClamp) {
        warnings.push(cpuClamp.reason);
        app.debug(`updateResources(${name}): ${cpuClamp.reason}`);
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
      //
      // Provenance guard: only force a recreate for a field the consumer
      // actually requested before this update (plugin default ⊕ the
      // stored override). A field that shows up in `liveBefore` purely
      // because the runtime injected it (a rootless-Podman-inherited
      // oom_score_adj) was never the user's to unset, so clearing the
      // override must not trigger a (futile, on rootless) recreate.
      const priorRequested = mergeResourceLimits(
        pluginDefault,
        currentOverrides[name],
      );
      const mustRecreateForUnset = fieldsRequiringRecreateForUnset(
        liveBefore,
        filteredLimits,
        priorRequested,
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

      // A resource-update recreate re-runs ensureRunning, which re-fires
      // device-passthrough events (a device may have been unplugged since
      // the container was first created). Collect them through the same
      // interceptor as the API wrapper so the doctor's devicePassthrough
      // section stays current instead of going stale after a resource bump.
      const recreateCollector = makeDeviceIssueCollector(name);
      try {
        await ensureRunning(
          runtimeInfo,
          name,
          newConfig,
          (msg) => app.debug(msg),
          { onDeviceIssue: recreateCollector.onDeviceIssue },
        );
        commitDeviceIssues(name, recreateCollector.issues);
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
          // Rollback recreates from cachedConfig; refresh device state to
          // reflect the config the container actually ends up running.
          const rollbackCollector = makeDeviceIssueCollector(name);
          await ensureRunning(
            runtimeInfo,
            name,
            cachedConfig,
            (msg) => app.debug(msg),
            { onDeviceIssue: rollbackCollector.onDeviceIssue },
          );
          commitDeviceIssues(name, rollbackCollector.issues);
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
          lastDeviceIssues.delete(name);
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
      const result = await selfDeployment(runtimePreference);
      // Grafted here rather than probed in doctor.ts: the probe has no
      // view into per-container config; the events live in this plugin
      // scope (see lastDeviceIssues).
      result.devicePassthrough = buildDevicePassthroughSection();
      return result;
    },
    async generateSetupSnippet(
      format: SetupSnippetFormat = "compose",
      result?: SelfDeploymentResult,
    ): Promise<SetupSnippetResult> {
      const dep = result ?? (await selfDeployment(runtimePreference));
      return generateSetupSnippet(dep, format, runtimeInfo?.hostUser ?? null);
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
    // generateSetupSnippet is similarly pre-start-safe: it's pure
    // templating over a SelfDeploymentResult, useful exactly when the
    // operator is trying to build a working deployment. hostUser is
    // null pre-start, so snippets default to `${UID}/${GID}` placeholders.
    async generateSetupSnippet(
      format: SetupSnippetFormat = "compose",
      result?: SelfDeploymentResult,
    ): Promise<SetupSnippetResult> {
      const dep = result ?? (await selfDeployment(runtimePreference));
      return generateSetupSnippet(dep, format, null);
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
          description:
            "How often to remove dangling (untagged) images left behind when a floating tag like 'latest' is re-pulled. Measured in wall-clock time across restarts; an overdue prune runs a few minutes after startup. Off disables both this and the version cleanup below.",
        },
        keepImageVersions: {
          type: "integer",
          default: DEFAULT_KEEP_IMAGE_VERSIONS,
          minimum: 0,
          title: "Keep N prior managed-image versions",
          description:
            "On the prune schedule above, also remove superseded versions of images belonging to managed containers, keeping this many prior versions in addition to the running one (0 keeps only the running image). Images not registered by signalk-container, and any image in use by a container, are never touched.",
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
        disableUserNamespaceRemap: {
          type: "boolean",
          default: false,
          title: "Disable user-namespace remap (ZFS workaround)",
          description:
            "Suppress the rootless-Podman --userns=keep-id flag for every managed container. Enable on hosts whose backing filesystem cannot be id-mapped by the kernel (ZFS is the common case; symptom is 'crun: writing file /proc/.../gid_map: Invalid argument' on container create). Bind-mount file ownership still lands on the host caller for root-by-default images. Leave off unless you actually see the error.",
        },
        emitDegradationNotifications: {
          type: "boolean",
          default: true,
          title: "Emit container degradation notifications",
          description:
            "Publish SignalK notifications (notifications.container.*) when a managed container is unhealthy, a device the host rejected, a required volume source is missing, or the container-runtime deployment is degraded. Severity is warn (or alert for a missing required volume) — visual only, no audible alarm. Requires a SignalK server that exposes the managed-notification API (>= 2.30.0); no effect on older servers. Turn off if you don't want these on the notification bus.",
        },
        containerCpuPriority: {
          type: "string",
          enum: [...CPU_PRIORITIES],
          default: DEFAULT_CONTAINER_CPU_PRIORITY,
          title: "CPU priority of managed containers",
          description:
            "Soft CPU weight every managed container gets unless the owning plugin or a per-container override sets its own cpuShares. Only matters when containers compete for CPU with each other or with jobs on this host. Normal is no request; High / Low / Lowest are --cpu-shares 5120 / 512 / 128 (the runtime maps shares to cgroup cpu.weight; crun and runc differ in the numbers, not the order). A lower tier is applied live to running containers on the next consumer-plugin restart; going back to Normal needs a recreate (panel: Normal → Apply).",
        },
        jobCpuPriority: {
          type: "string",
          enum: [...CPU_PRIORITIES],
          default: DEFAULT_JOB_CPU_PRIORITY,
          title: "CPU priority of jobs",
          description:
            "Soft CPU weight for one-shot helper containers (chart imports, GDAL, cleanup) unless the caller sets its own cpuShares. Lowest keeps a chart import from starving the managed services when they contend for CPU; it does not slow the job on an idle host.",
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
                title:
                  "Soft CPU weight (--cpu-shares; unset = the runtime default, tiers: 5120 high / 512 low / 128 lowest)",
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
      // Degradation notifications default on; a stored `false` opts out.
      degradation.setEnabled(config.emitDegradationNotifications !== false);
      // Cache user-supplied per-container resource overrides. These
      // are merged into every ensureRunning() call so consumer
      // plugins automatically pick them up. The user can edit them
      // in signalk-container's plugin config; saving causes Signal K
      // to stop+start this plugin, so the new overrides take effect
      // on the next ensureRunning() call from each consumer.
      currentOverrides = config.containerOverrides ?? {};
      containerCpuPriority = normalizeCpuPriority(
        config.containerCpuPriority,
        DEFAULT_CONTAINER_CPU_PRIORITY,
      );
      jobCpuPriority = normalizeCpuPriority(
        config.jobCpuPriority,
        DEFAULT_JOB_CPU_PRIORITY,
      );
      // Resolve the container-name namespace from the environment before
      // any container is created or reaped. Unset → the default `sk`
      // namespace (production parity); the devcontainer sets
      // `SIGNALK_CONTAINER_NAMESPACE=devpod` so its managed containers and
      // job reaper can't touch a production `sk-*` stack on the same host.
      // Reset on stop() below so a restart re-reads the environment cleanly.
      setNamespace(process.env.SIGNALK_CONTAINER_NAMESPACE, (value) =>
        app.error(
          `Ignoring invalid SIGNALK_CONTAINER_NAMESPACE=${JSON.stringify(
            value,
          )} (expected 1-32 lowercase alphanumerics); using default 'sk'`,
        ),
      );

      // Propagate the ZFS-style opt-out from plugin config into the
      // runtime layer. Default `false` is restored on stop() below
      // so the toggle does not leak across plugin restarts.
      setDisableUserns(config.disableUserNamespaceRemap === true);

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
          app.setPluginError(pluginErrorForDoctor(doctor, headline));
          if (doctor.remediation.length > 0) {
            app.error(
              `signalk-container deployment doctor — ${headline}:\n${doctor.remediation.join("\n")}`,
            );
          }
          surfaceDeploymentDoctor(doctor);
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

        // Runtime detection succeeded, but a container can still run while
        // its host is degraded: cgroup controllers not delegated (memory
        // limits silently dropped) or self-id unresolved. Re-run the doctor
        // and surface those as a dashboard error so the operator isn't left
        // with a green status hiding a real problem. The headline mirrors
        // the no-runtime path; full remediation goes to the server log.
        const doctor = await selfDeployment(preference);
        const surfacing = doctorSurfacing(
          doctor.status,
          doctor.remediation.length,
        );
        if (surfacing === "error") {
          const headline = headlineForDoctorStatus(doctor.status);
          app.setPluginError(pluginErrorForDoctor(doctor, headline));
          if (doctor.remediation.length > 0) {
            app.error(
              `signalk-container deployment doctor — ${headline}:\n${doctor.remediation.join("\n")}`,
            );
          }
        } else if (surfacing === "advisory") {
          // A healthy host can still carry advisory remediation (old
          // Podman, rootless nofile drop). Log it without calling
          // setPluginError, so the hint is discoverable without turning a
          // working install red on the dashboard.
          app.error(
            `signalk-container deployment doctor — advisory:\n${doctor.remediation.join("\n")}`,
          );
        }
        // Raise/clear the deployment notification for BOTH the degraded and
        // the healthy case (a prior start's alert clears when the host
        // recovers). Shared with the no-runtime branch above.
        surfaceDeploymentDoctor(doctor);

        if (config.pruneSchedule && config.pruneSchedule !== "off") {
          const intervalMs =
            config.pruneSchedule === "weekly"
              ? 7 * 24 * 60 * 60 * 1000
              : 30 * 24 * 60 * 60 * 1000;
          // Read here (not via a truthiness guard) so an explicit 0 —
          // "keep only the running image" — is honoured rather than
          // treated as unset.
          const keepImageVersions = normalizeKeepImageVersions(
            config.keepImageVersions,
          );
          pruneScheduler = new PruneScheduler({
            intervalMs,
            store: new FilePruneStateStore(
              path.join(dataDir, "prune-state.json"),
              (msg) => app.debug(msg),
            ),
            debug: (msg) => app.debug(msg),
            run: async () => {
              // Snapshot the runtime once so reaping and pruning act on
              // the same instance across awaits.
              const runtime = runtimeInfo;
              if (!runtime) {
                // Rejecting leaves the run unrecorded, so it is retried
                // next interval / shortly after the next startup.
                throw new Error("no container runtime detected");
              }
              await runScheduledPrune(
                runtime,
                () => collectManagedImageRefs(runtime),
                keepImageVersions,
                {
                  debug: (msg) => app.debug(msg),
                  error: (msg, err) => app.error(msg, err),
                },
              );
            },
          });
          pruneScheduler.start();
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
      if (pruneScheduler) {
        pruneScheduler.stop();
        pruneScheduler = null;
      }
      for (const timer of healthTimers.values()) {
        clearInterval(timer);
      }
      healthTimers.clear();
      healthPollsInFlight.clear();
      // Clear every outstanding degradation notification so a plugin stop
      // doesn't strand alerts on the bus, then drop the tracking state.
      degradation.reset();
      // The doctor's devicePassthrough section reads lastDeviceIssues; clear
      // it too so a restart can't expose a prior run's stale device issues
      // before any new ensureRunning() commits fresh state.
      lastDeviceIssues.clear();
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
      containerCpuPriority = DEFAULT_CONTAINER_CPU_PRIORITY;
      jobCpuPriority = DEFAULT_JOB_CPU_PRIORITY;
      currentConfig = null;
      // Restore the userns-remap default so a future start() that
      // omits the flag (older saved config) does not inherit the
      // previous run's toggle.
      setDisableUserns(false);
      // NOTE: do NOT re-enable the emitter here. degradation.reset() (above)
      // left it disabled so a late raise() from an in-flight startup step
      // can't strand a notification after stop(). The next start() re-enables
      // it from config via degradation.setEnabled(...).
      // Restore the default namespace symmetrically; start() re-reads the
      // env var, so this only matters as a defensive reset.
      resetNamespace();
      cachedDataSource = null;
      pendingDataSource = null;
      cachedConfigRootSource = null;
      pendingConfigRootSource = null;
      cachedSignalkNetworks = undefined;
      pendingNetworks = null;
      portAddressMap.clear();
      registeredPorts.clear();
      // Drop the cached dockerode client so a future start() re-probes the
      // socket (it may have moved, or the runtime may have changed).
      resetClient();
      runtimeInfo = null;
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
          // A container that never started has no log lines; the
          // runtime's record of why (inspect `.State.Error`) is the
          // only diagnostic it leaves behind. Attach it so the Logs
          // modal can render an actionable empty state. `undefined`
          // is dropped by JSON serialization, so the field is absent
          // when there is nothing to report. Best-effort: the lines
          // payload already succeeded, so an inspect failure here must
          // degrade to "no lastError", not fail the response.
          let lastError: string | undefined;
          if (lines.length === 0) {
            try {
              lastError = await getContainerLastError(name);
            } catch {
              lastError = undefined;
            }
          }
          res.json({ name, lines, lastError });
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

      // Snippet generator. Plain text by default so operators can
      // `curl ... > docker-compose.yml`; JSON form available via
      // `Accept: application/json` for programmatic consumers.
      router.get("/api/doctor/snippet", async (req, res) => {
        const rawFormat =
          typeof req.query.format === "string"
            ? (req.query.format as string).toLowerCase()
            : "compose";
        if (rawFormat !== "compose" && rawFormat !== "run") {
          res.status(400).send("format must be 'compose' or 'run'");
          return;
        }
        try {
          const result = await api.doctor.generateSetupSnippet(
            rawFormat as SetupSnippetFormat,
          );
          if (req.accepts(["text", "json"]) === "json") {
            res.json(result);
            return;
          }
          const body = [
            result.snippet,
            result.dockerfile && "\n" + result.dockerfile,
            result.notes.length > 0 &&
              "\n# Notes:\n" + result.notes.map((n) => "# - " + n).join("\n"),
          ]
            .filter(Boolean)
            .join("\n");
          res.type("text/plain; charset=utf-8").send(body);
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
    case "cgroup-controllers-incomplete":
      return "Host cgroup controllers not fully delegated";
    case "ok":
      return "Runtime ready";
  }
}

/**
 * One-line dashboard text for a degraded doctor result. On HaLOS a refused
 * docker socket has a known three-step fix, so the line says so up front
 * rather than reading like a generic failure; every other case keeps the
 * status headline.
 */
export function pluginErrorForDoctor(
  doctor: SelfDeploymentResult,
  headline: string,
): string {
  const lead =
    doctor.platform === "halos" && doctor.status === "permission-denied"
      ? "HaLOS: Signal K is not yet allowed to use docker (one-time fix)"
      : headline;
  return `${lead}. Open this plugin's config screen and click Doctor for details and remediation.`;
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
