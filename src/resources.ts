import type { ContainerResourceLimits, ContainerRuntimeInfo } from "./types";
import { execRuntime } from "./runtime";

/**
 * Resource limits known to be applyable via `podman update` /
 * `docker update`. Anything outside this set forces a recreate
 * fallback. (cpuset is intentionally excluded — kernel/cgroup
 * support varies and the failure mode is silent on some systems.)
 */
const LIVE_UPDATABLE_FIELDS: ReadonlyArray<keyof ContainerResourceLimits> = [
  "cpus",
  "cpuShares",
  "memory",
  "memorySwap",
  "memoryReservation",
  "pidsLimit",
];

/**
 * Fields that, once set on a running container, cannot be UNSET via
 * `podman update` / `docker update`. The runtime can lower or raise
 * them, but cannot return them to the unlimited/default state without
 * a container recreate.
 *
 *   - memory / memorySwap / memoryReservation: cgroup memory.max can
 *     be lowered or raised, but resetting to "max" (unlimited) is
 *     not exposed via `podman update`.
 *   - oomScoreAdj: set at create time only, never via update.
 *
 * Used by the orchestration layer (index.ts) to detect "user is
 * asking to remove a limit we previously set, and live update can't
 * do that" and force a recreate. Without this check, the live-update
 * path would silently no-op the unset and `effectiveResources` would
 * report a state that doesn't match the actual container.
 */
const FIELDS_THAT_CANNOT_LIVE_UNSET: ReadonlySet<
  keyof ContainerResourceLimits
> = new Set(["memory", "memorySwap", "memoryReservation", "oomScoreAdj"]);

/**
 * Compare a snapshot of currently-applied resource limits to a
 * target, and return the list of fields that the target is asking
 * to UNSET (i.e. fields present in `current` but absent or null in
 * `target`) which cannot be live-unset.
 *
 * If this returns a non-empty list, the caller MUST take the
 * recreate path — live update will silently no-op the unset.
 *
 * `current` is what `getLiveResources()` returned (the actual cgroup
 * state). `target` is the post-merge intended state.
 */
export function fieldsRequiringRecreateForUnset(
  current: ContainerResourceLimits,
  target: ContainerResourceLimits,
): Array<keyof ContainerResourceLimits> {
  const result: Array<keyof ContainerResourceLimits> = [];
  for (const field of FIELDS_THAT_CANNOT_LIVE_UNSET) {
    const wasSet = isSet(current[field]);
    const willBeSet = isSet(target[field]);
    if (wasSet && !willBeSet) {
      result.push(field);
    }
  }
  return result;
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/**
 * Maps each ContainerResourceLimits field to the cgroup v2 controller
 * it requires. `null` means the field is not gated by a cgroup
 * controller (oom_score_adj is set in /proc/<pid>/oom_score_adj, not
 * via cgroups). Used by `filterUnsupportedLimits` to gracefully drop
 * limits whose backing controller is not delegated to the runtime.
 */
const FIELD_TO_CONTROLLER: Record<
  keyof ContainerResourceLimits,
  string | null
> = {
  cpus: "cpu",
  cpuShares: "cpu",
  cpusetCpus: "cpuset",
  memory: "memory",
  memorySwap: "memory",
  memoryReservation: "memory",
  pidsLimit: "pids",
  oomScoreAdj: null, // not a cgroup controller
};

export interface FilterResult {
  /** Limits with unsupported fields removed. */
  accepted: ContainerResourceLimits;
  /**
   * Fields that were dropped, with the reason. Caller should log
   * these once (not on every reconcile) so the user knows their
   * override is being silently ignored.
   */
  dropped: Array<{ field: keyof ContainerResourceLimits; reason: string }>;
}

/**
 * Drop ContainerResourceLimits fields whose backing cgroup controller
 * is not available on this runtime. Returns the filtered limits and
 * a list of dropped fields for logging.
 *
 * Behavior:
 *   - If `runtime.cgroupControllers` is `null` or `undefined`, all
 *     fields are accepted (we have no information to filter against —
 *     this is the default for docker, where we don't probe).
 *   - If a field is `null` or `undefined` in the input, it's preserved
 *     (the merge layer handles null=unset semantics).
 *   - If a field's controller is in the available list, accepted.
 *   - If a field's controller is missing, dropped with a clear reason.
 */
export function filterUnsupportedLimits(
  limits: ContainerResourceLimits,
  runtime: ContainerRuntimeInfo,
): FilterResult {
  const controllers = runtime.cgroupControllers;
  if (!controllers) {
    // Not probed — assume all controllers are available.
    return { accepted: { ...limits }, dropped: [] };
  }
  const available = new Set(controllers);
  const accepted: ContainerResourceLimits = {};
  const dropped: FilterResult["dropped"] = [];

  for (const key of Object.keys(limits) as Array<
    keyof ContainerResourceLimits
  >) {
    const value = limits[key];
    // Preserve null/undefined verbatim — merge layer handles them.
    if (value === undefined || value === null) {
      (accepted as Record<string, unknown>)[key] = value as unknown;
      continue;
    }
    const controller = FIELD_TO_CONTROLLER[key];
    if (controller === null || available.has(controller)) {
      (accepted as Record<string, unknown>)[key] = value;
    } else {
      dropped.push({
        field: key,
        reason: `cgroup controller '${controller}' not delegated to ${runtime.runtime} (available: ${controllers.join(", ") || "none"})`,
      });
    }
  }

  return { accepted, dropped };
}

/**
 * Field-level merge of two ContainerResourceLimits objects. The
 * override "wins" — but `null` in the override means "explicitly
 * remove the limit set by the base", whereas `undefined` means
 * "inherit from base". This matches RFC 7396 JSON merge patch
 * semantics for individual fields.
 *
 * Examples:
 *   merge({ cpus: 1.5, memory: "512m" }, { cpus: 2.0 })
 *     → { cpus: 2.0, memory: "512m" }
 *   merge({ cpus: 1.5, memory: "512m" }, { memory: null })
 *     → { cpus: 1.5 }
 *   merge({ cpus: 1.5 }, undefined)
 *     → { cpus: 1.5 }
 */
export function mergeResourceLimits(
  base: ContainerResourceLimits | undefined,
  override: ContainerResourceLimits | undefined,
): ContainerResourceLimits {
  const result: ContainerResourceLimits = { ...(base ?? {}) };
  if (!override) return clean(result);

  for (const key of Object.keys(override) as Array<
    keyof ContainerResourceLimits
  >) {
    const value = override[key];
    if (value === undefined) {
      // inherit base
      continue;
    }
    if (value === null) {
      // explicit unset
      delete result[key];
      continue;
    }
    // override wins (typed assignment via cast — TS can't follow the
    // discriminated indexed type narrowing here without a helper).
    (result as Record<string, unknown>)[key] = value;
  }
  return clean(result);
}

/** Strip null/undefined fields from the merged result. */
function clean(limits: ContainerResourceLimits): ContainerResourceLimits {
  const out: ContainerResourceLimits = {};
  for (const [k, v] of Object.entries(limits)) {
    if (v !== undefined && v !== null) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * Translate ContainerResourceLimits into podman/docker run flags.
 * Returns a flat array suitable for splicing into the run argv.
 * Ordering doesn't matter — both runtimes accept these in any order.
 *
 * Fields whose backing cgroup controller is unavailable on the host
 * are silently dropped — caller should call `filterUnsupportedLimits`
 * separately if it wants to log the dropped set.
 */
export function resourceFlagsForRun(
  limits: ContainerResourceLimits | undefined,
  runtime: ContainerRuntimeInfo,
): string[] {
  if (!limits) return [];
  const { accepted } = filterUnsupportedLimits(limits, runtime);
  const args: string[] = [];

  if (accepted.cpus !== undefined && accepted.cpus !== null) {
    args.push("--cpus", String(accepted.cpus));
  }
  if (accepted.cpuShares !== undefined && accepted.cpuShares !== null) {
    args.push("--cpu-shares", String(accepted.cpuShares));
  }
  if (accepted.cpusetCpus !== undefined && accepted.cpusetCpus !== null) {
    args.push("--cpuset-cpus", accepted.cpusetCpus);
  }
  if (accepted.memory !== undefined && accepted.memory !== null) {
    args.push("--memory", accepted.memory);
  }
  if (accepted.memorySwap !== undefined && accepted.memorySwap !== null) {
    args.push("--memory-swap", accepted.memorySwap);
  }
  if (
    accepted.memoryReservation !== undefined &&
    accepted.memoryReservation !== null
  ) {
    args.push("--memory-reservation", accepted.memoryReservation);
  }
  if (accepted.pidsLimit !== undefined && accepted.pidsLimit !== null) {
    args.push("--pids-limit", String(accepted.pidsLimit));
  }
  if (accepted.oomScoreAdj !== undefined && accepted.oomScoreAdj !== null) {
    args.push("--oom-score-adj", String(accepted.oomScoreAdj));
  }

  return args;
}

/**
 * Translate ContainerResourceLimits into the flags accepted by
 * `podman update` / `docker update`. Returns null if the limits
 * contain a field that cannot be live-updated (e.g. cpuset on some
 * kernels, or oomScoreAdj which is set at create time only).
 *
 * Caller should fall back to recreate when this returns null.
 */
export function resourceFlagsForUpdate(
  limits: ContainerResourceLimits,
): string[] | null {
  // Check whether every set field is in the live-updatable set.
  for (const key of Object.keys(limits) as Array<
    keyof ContainerResourceLimits
  >) {
    const value = limits[key];
    if (value === undefined || value === null) continue;
    if (!LIVE_UPDATABLE_FIELDS.includes(key)) {
      return null;
    }
  }

  const args: string[] = [];
  if (limits.cpus !== undefined && limits.cpus !== null) {
    args.push("--cpus", String(limits.cpus));
  }
  if (limits.cpuShares !== undefined && limits.cpuShares !== null) {
    args.push("--cpu-shares", String(limits.cpuShares));
  }
  if (limits.memory !== undefined && limits.memory !== null) {
    args.push("--memory", limits.memory);
  }
  if (limits.memorySwap !== undefined && limits.memorySwap !== null) {
    args.push("--memory-swap", limits.memorySwap);
  }
  if (
    limits.memoryReservation !== undefined &&
    limits.memoryReservation !== null
  ) {
    args.push("--memory-reservation", limits.memoryReservation);
  }
  if (limits.pidsLimit !== undefined && limits.pidsLimit !== null) {
    args.push("--pids-limit", String(limits.pidsLimit));
  }
  return args;
}

/**
 * Type of the runtime exec function. Matches `execRuntime` from
 * runtime.ts; passed in by the caller so tests can inject a stub.
 */
export type ExecRuntimeFn = (
  runtime: ContainerRuntimeInfo,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Attempt a live `podman update` / `docker update` on the named
 * container. Returns ok=true on success, ok=false on any failure
 * (caller is expected to fall back to recreate).
 *
 * The container name should already be the prefixed form (sk-...).
 * `exec` defaults to the production execRuntime; tests pass a stub.
 *
 * Behavior:
 *   - Filters `limits` against `runtime.cgroupControllers` first.
 *     Fields whose backing controller is unavailable are dropped
 *     silently (caller logs them via filterUnsupportedLimits if it
 *     wants visibility).
 *   - If the filtered limits contain a field that cannot be
 *     live-updated (e.g. cpuset, oomScoreAdj), returns ok=false so
 *     the caller falls back to recreate.
 *   - If the filtered limits are empty (every field was dropped),
 *     verifies the container exists before claiming vacuous success.
 *     This prevents Bug C: silent success when the container has
 *     been removed out from under us.
 */
export async function tryLiveUpdate(
  runtime: ContainerRuntimeInfo,
  fullName: string,
  limits: ContainerResourceLimits,
  exec: ExecRuntimeFn = execRuntime,
): Promise<{ ok: boolean; stderr?: string }> {
  const { accepted } = filterUnsupportedLimits(limits, runtime);
  const flags = resourceFlagsForUpdate(accepted);
  if (flags === null) {
    return { ok: false, stderr: "limits contain non-live-updatable fields" };
  }
  if (flags.length === 0) {
    // Nothing to apply via update. Don't claim vacuous success
    // without verifying the target exists — the caller may be
    // operating on a container that was removed out from under us.
    const exists = await exec(runtime, ["inspect", fullName]);
    if (exists.exitCode !== 0) {
      return {
        ok: false,
        stderr: `container ${fullName} does not exist`,
      };
    }
    return { ok: true };
  }
  const result = await exec(runtime, ["update", ...flags, fullName]);
  if (result.exitCode !== 0) {
    return { ok: false, stderr: result.stderr || result.stdout };
  }
  return { ok: true };
}

/**
 * Compare two ContainerResourceLimits for semantic equality (after
 * cleaning out null/undefined). Used to skip no-op updates when the
 * user saves the config panel without actually changing anything.
 */
export function resourceLimitsEqual(
  a: ContainerResourceLimits | undefined,
  b: ContainerResourceLimits | undefined,
): boolean {
  const ca = clean(a ?? {});
  const cb = clean(b ?? {});
  const ka = Object.keys(ca).sort();
  const kb = Object.keys(cb).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (
      (ca as Record<string, unknown>)[ka[i]] !==
      (cb as Record<string, unknown>)[kb[i]]
    )
      return false;
  }
  return true;
}
