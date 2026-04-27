import { IRouter } from "express";
import path from "path";
import {
  ContainerConfig,
  ContainerInfo,
  ContainerJobConfig,
  ContainerJobResult,
  ContainerManagerApi,
  ContainerResourceLimits,
  ContainerRuntimeInfo,
  ContainerState,
  HealthCheckOptions,
  PluginConfig,
  PruneResult,
  UpdateResourcesResult,
} from "./types";
import {
  fieldsRequiringRecreateForUnset,
  filterUnsupportedLimits,
  mergeResourceLimits,
  minimizeOverride,
  resourceLimitsEqual,
  tryLiveUpdate,
} from "./resources";
import { detectRuntime, isContainerized } from "./runtime";
import {
  connectToNetwork,
  disconnectFromNetwork,
  ensureNetwork,
  ensureRunning,
  execInContainer,
  getContainerState,
  getImageDigest,
  getLiveResources,
  imageExists,
  listContainers,
  pruneImages,
  pullImage,
  qualifyImage as qualifyImageForRuntime,
  removeContainer,
  removeNetwork,
  resolveSignalkDataSource,
  startContainer,
  stopContainer,
} from "./containers";
import { runJob } from "./jobs";
import { UpdateService } from "./updates/service";
import { FileUpdateCache } from "./updates/cache";
import { registerUpdateRoutes } from "./updates/routes";

interface App {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
  getDataDirPath?: () => string;
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

module.exports = (app: App) => {
  let runtimeInfo: ContainerRuntimeInfo | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;
  const healthTimers = new Map<string, NodeJS.Timeout>();
  let updateService: UpdateService | null = null;

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
   */
  const lastConfigs = new Map<string, ContainerConfig>();
  let currentOverrides: Record<string, ContainerResourceLimits> = {};
  // Cached result of resolveSignalkDataSource() — resolved once on first
  // ensureRunning() call that uses signalkDataMount, then reused.
  // `pendingDataSource` collapses concurrent resolutions onto one inspect.
  let cachedDataSource: string | null = null;
  let pendingDataSource: Promise<string> | null = null;
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

  const api: ContainerManagerApi = {
    getRuntime() {
      return runtimeInfo;
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
      options?: HealthCheckOptions,
    ) {
      if (!runtimeInfo) throw new Error("No container runtime available");

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
      const effectiveConfig: ContainerConfig = {
        ...config,
        resources: filteredMerged,
      };

      // Cache for later updateResources() recreate-fallback path.
      lastConfigs.set(name, effectiveConfig);
      effectiveResources.set(name, filteredMerged);

      // Capture the running container's existing resources BEFORE
      // calling ensureRunning, so we can detect "already running but
      // limits differ" (Bug D). If the container is missing,
      // getLiveResources returns {} and the diff won't trigger.
      const preLimits = await getLiveResources(runtimeInfo, name);

      await ensureRunning(
        runtimeInfo,
        name,
        effectiveConfig,
        (msg) => app.debug(msg),
        options,
      );

      // Bug D: if ensureRunning was a no-op (container was already
      // running) AND the requested limits differ from the live state,
      // fire a live update to bring them in line. This is what makes
      // user `containerOverrides` config changes take effect on the
      // next consumer-plugin restart without forcing a recreate.
      if (!resourceLimitsEqual(preLimits, filteredMerged)) {
        const fullName = name.startsWith("sk-") ? name : `sk-${name}`;

        // Bug E: if any field is being UNSET and it can't be unset
        // via live update (memory, oomScoreAdj, etc.), the live path
        // would silently no-op. We can't safely recreate from inside
        // ensureRunning's "already running" branch — that would
        // surprise the consumer plugin. Instead, log a clear warning
        // pointing the user to the explicit recreate path.
        const cannotUnset = fieldsRequiringRecreateForUnset(
          preLimits,
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

    async resolveSignalkDataMount(): Promise<string | null> {
      // Honor the documented contract: return null when we cannot
      // resolve, never throw. ensureCachedDataSource() throws when
      // app.getDataDirPath is unavailable; that's appropriate for
      // ensureRunning (the caller asked us to mount it) but not for
      // this introspection method.
      if (!runtimeInfo || !app.getDataDirPath) return null;
      return ensureCachedDataSource();
    },

    async start(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await startContainer(runtimeInfo, name);
    },

    async stop(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await stopContainer(runtimeInfo, name);
    },

    async remove(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await removeContainer(runtimeInfo, name);
    },

    async getState(name: string): Promise<ContainerState> {
      if (!runtimeInfo) return "no-runtime";
      return getContainerState(runtimeInfo, name);
    },

    async runJob(config: ContainerJobConfig): Promise<ContainerJobResult> {
      if (!runtimeInfo) throw new Error("No container runtime available");
      return runJob(runtimeInfo, config);
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

      // Expose API on global so other plugins can find it.
      // Each plugin gets a shallow copy of app (_.assign({}, app)),
      // so setting on app doesn't propagate. Global is the shared bus.
      (globalThis as any).__signalk_containerManager = api;

      // Async init — server does not await start()
      (async () => {
        const preference = config.runtime ?? "auto";
        const containerized = isContainerized();
        if (containerized) {
          app.debug(
            "Signal K is running inside a container. Container runtime " +
              "must be exposed (docker.sock + binary) for this plugin to work.",
          );
        }
        app.debug("detecting runtime, preference=%s", preference);
        runtimeInfo = await detectRuntime(preference);
        app.debug("detectRuntime result: %o", runtimeInfo);

        if (!runtimeInfo) {
          const msg = containerized
            ? "No container runtime found. Signal K appears to run inside a container — " +
              "you must mount the host's docker socket and binary. See README."
            : "No container runtime found. Install Podman: sudo apt install podman";
          app.setPluginError(msg);
          return;
        }

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
      })().catch((err) => {
        app.setPluginError(
          `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      lastConfigs.clear();
      effectiveResources.clear();
      pluginDefaults.clear();
      currentOverrides = {};
      currentConfig = null;
      cachedDataSource = null;
      pendingDataSource = null;
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

      router.get("/api/containers/:name/resources", (req, res) => {
        if (!runtimeInfo) {
          res.status(503).json({ error: "No container runtime available" });
          return;
        }
        const name = String(req.params.name);
        res.json({
          name,
          effective: api.getResources(name),
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

      // Update detection routes (registered if and only if the
      // service was instantiated in start()).
      if (updateService) {
        registerUpdateRoutes(router, updateService, () => runtimeInfo !== null);
      }
    },
  };

  return plugin;
};

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
