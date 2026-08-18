import type {
  ContainerResourceLimits,
  ContainerRuntimeInfo,
  ResourceClamp,
} from "./types.js";
import {
  getClient,
  safe,
  safeInspect,
  type ContainerClient,
} from "./client.js";
import { messageWithRaw } from "./errors.js";

/**
 * dockerode `HostConfig` resource fields. The Docker API takes CPU as a
 * NanoCpus integer and memory as a byte count, where the CLI took
 * `--cpus 1.5` and `--memory 512m`. `prefixedName` callers build this
 * fragment and merge it into a createContainer payload or pass it to
 * `container.update()`.
 */
export interface ResourceHostConfig {
  NanoCpus?: number;
  /**
   * CFS quota/period form of the CPU cap, used by the live-UPDATE path.
   * Podman's docker-compat `/update` endpoint does not apply `NanoCpus`
   * (the call succeeds but the cgroup cpu.max is left unchanged); it does
   * honour `CpuQuota`/`CpuPeriod`, which Docker accepts too. Create uses
   * `NanoCpus`; update uses these. `cpus` → quota = round(cpus*period),
   * period = 100000 (100ms, the Docker/podman default).
   */
  CpuQuota?: number;
  CpuPeriod?: number;
  CpuShares?: number;
  CpusetCpus?: string;
  Memory?: number;
  MemorySwap?: number;
  MemoryReservation?: number;
  PidsLimit?: number;
  OomScoreAdj?: number;
}

/** CFS period (100ms) used to express the CPU cap as quota/period. */
const CPU_PERIOD = 100_000;

/**
 * Parse a memory string the consumer-plugin / config-panel form uses
 * (`"512m"`, `"2g"`, `"1024k"`, `"536870912"`/`"...b"`) into bytes for
 * the Docker API. Uses binary units (1m = 1024*1024), matching how
 * `bytesToString` in containers.ts renders the round-trip.
 *
 * Throws on a malformed non-empty value (e.g. `"512mb"`, `"abc"`). This
 * is a system boundary: silently omitting the field would remove the cap
 * on create and let `tryLiveUpdate` report success after applying
 * nothing — a typo must fail loudly, before the container is touched.
 */
export function parseMemoryToBytes(value: string): number {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([bkmg]?)$/i);
  const n = m ? Number(m[1]) : NaN;
  if (!m || !Number.isFinite(n)) {
    throw new Error(
      `invalid memory value "${value}" (expected e.g. "512m", "2g", "1024k", or a byte count)`,
    );
  }
  const unit = (m[2] || "b").toLowerCase();
  const mult =
    unit === "g"
      ? 1024 ** 3
      : unit === "m"
        ? 1024 ** 2
        : unit === "k"
          ? 1024
          : 1;
  return Math.round(n * mult);
}

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
 *   - cpuShares: `podman update --cpu-shares 0` is a no-op (0 means
 *     "not specified" on the wire), so cpu.weight cannot be returned
 *     to the unset default (100) without a recreate.
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
> = new Set([
  "memory",
  "memorySwap",
  "memoryReservation",
  "cpuShares",
  "oomScoreAdj",
]);

/**
 * Fields the container runtime can inject without any user request.
 * Rootless Podman clamps a child container's `oom_score_adj` up to the
 * creating process's value (it can only raise, never lower), so a
 * managed container started under a signalk-server whose own
 * `oom_score_adj` is non-zero always shows a non-zero `oomScoreAdj`
 * that nobody asked for. When provenance is unknown, a live value in
 * this set cannot be attributed to a user request and is not reported
 * as an unset.
 */
const RUNTIME_INJECTED_FIELDS: ReadonlySet<keyof ContainerResourceLimits> =
  new Set(["oomScoreAdj"]);

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
 *
 * `priorRequested` (optional) is what the consumer plugin / user
 * actually *requested* before this reconcile — the pre-merge intent,
 * not the live cgroup state. When supplied, a field the runtime is
 * known to inject (`RUNTIME_INJECTED_FIELDS`) only counts as a
 * recreate-needing-unset if it was present in `priorRequested`. This
 * rules out values the runtime *injected* that the consumer never
 * asked for: rootless Podman clamps a child container's
 * `oom_score_adj` up to its parent's (it can only raise, never
 * lower), so a managed container started under a signalk-server whose
 * own `oom_score_adj` is non-zero (universal-installer Quadlet sets
 * `OOMScoreAdjust`, a hardened systemd user service, SK-in-a-container)
 * shows a non-zero `oomScoreAdj` in `current` that no plugin ever
 * requested. Without provenance, the diff misreads that artifact as
 * "user wants to unset a limit" and warns on every ensureRunning.
 *
 * The guard is deliberately limited to those fields: a live `memory`
 * or `cpuShares` the runtime never injects is a real request even
 * when `priorRequested` lacks it — typically applied later by a live
 * update, which cannot rewrite the create-time provenance label — and
 * dropping it must still take the recreate path.
 *
 * When `priorRequested` is omitted (no provenance at all — the
 * container predates the requested-resources label and the in-process
 * cache is cold), the check falls back to plain current-vs-target,
 * minus `RUNTIME_INJECTED_FIELDS`: a live value the runtime is known
 * to inject on its own is unattributable and would otherwise warn on
 * every server start, forever, on deployments where signalk-server
 * runs with a non-zero `oom_score_adj`.
 */
export function fieldsRequiringRecreateForUnset(
  current: ContainerResourceLimits,
  target: ContainerResourceLimits,
  priorRequested?: ContainerResourceLimits,
): Array<keyof ContainerResourceLimits> {
  const result: Array<keyof ContainerResourceLimits> = [];
  for (const field of FIELDS_THAT_CANNOT_LIVE_UNSET) {
    const wasSet = isSet(current[field]);
    const willBeSet = isSet(target[field]);
    if (priorRequested === undefined && RUNTIME_INJECTED_FIELDS.has(field)) {
      // No provenance: a live value here may well be runtime-injected
      // (see RUNTIME_INJECTED_FIELDS), so it can't be read as an unset.
      continue;
    }
    if (
      priorRequested &&
      RUNTIME_INJECTED_FIELDS.has(field) &&
      !isSet(priorRequested[field])
    ) {
      // The field exists only as a runtime artifact (an inherited
      // oom_score_adj), never a consumer request — not a real unset.
      continue;
    }
    if (wasSet && !willBeSet) {
      result.push(field);
    }
  }
  return result;
}

/**
 * Parse a requested-resources provenance label value back into
 * ContainerResourceLimits. The value crosses a system boundary (it is
 * read back from container runtime state and could have been written
 * by anything), so it is validated field by field: unknown keys and
 * wrong-typed values are dropped, and a value that is not a JSON
 * object at all yields `undefined` — "no provenance", never a throw.
 */
export function parseResourceLimits(
  raw: string,
): ContainerResourceLimits | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const source = parsed as Record<string, unknown>;
  const out: ContainerResourceLimits = {};
  for (const [field, type] of Object.entries(RESOURCE_LIMIT_VALUE_TYPES)) {
    const value = source[field];
    if (typeof value === type) {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  return out;
}

/** Expected primitive type per ContainerResourceLimits field. */
const RESOURCE_LIMIT_VALUE_TYPES: Record<
  keyof ContainerResourceLimits,
  "number" | "string"
> = {
  cpus: "number",
  cpuShares: "number",
  cpusetCpus: "string",
  memory: "string",
  memorySwap: "string",
  memoryReservation: "string",
  pidsLimit: "number",
  oomScoreAdj: "number",
};

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/**
 * Compute the minimal override: the subset of `limits` fields whose
 * values actually differ from the consumer plugin's default.
 *
 * The config panel's resource editor seeds its form from the current
 * effective state (plugin default + override applied), which means
 * users who only want to change ONE field end up submitting a payload
 * containing all visible fields. Without minimization, every such
 * submission would store a full snapshot as the override, which:
 *   1. Shows "Override active" even when the submission matches
 *      the plugin default exactly
 *   2. Pins the user to the old default values if the plugin author
 *      bumps the default in a future version (e.g. if mayara bumps
 *      memory from "512m" to "1g", a snapshot override from before
 *      the bump would silently keep the user on "512m")
 *
 * This helper compares each field in `limits` against `pluginDefault`
 * and returns only the fields that represent a real user intent
 * different from the default. Rules:
 *
 *   - `limits[k] === undefined` → drop (field not in submission)
 *   - `limits[k] === null`:
 *       - `pluginDefault[k] === undefined` → drop (both unset, no diff)
 *       - `pluginDefault[k]` is set → KEEP (user explicitly unsetting
 *         a value the plugin set — real intent)
 *   - `limits[k]` has a value:
 *       - equal to `pluginDefault[k]` → drop (redundant)
 *       - different → KEEP (real user override)
 *
 * An empty result `{}` means "no override" — caller should delete the
 * container's entry from `currentOverrides` rather than store `{}`.
 *
 * Equality comparison is `===` for primitives. The only complex field
 * is cpusetCpus (a string); `1.5 === 1.5` for cpus works correctly.
 */
export function minimizeOverride(
  limits: ContainerResourceLimits,
  pluginDefault: ContainerResourceLimits,
): ContainerResourceLimits {
  const result: ContainerResourceLimits = {};
  for (const key of Object.keys(limits) as Array<
    keyof ContainerResourceLimits
  >) {
    const value = limits[key];
    const defaultValue = pluginDefault[key];

    if (value === undefined) continue;
    if (value === null) {
      // Null = "explicitly unset this field". Only meaningful if the
      // plugin actually had it set in the first place.
      if (isSet(defaultValue)) {
        (result as Record<string, unknown>)[key] = null;
      }
      continue;
    }
    // Set value — compare to plugin default.
    if (value !== defaultValue) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
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
 * Cap `cpus` at the daemon's CPU count. Docker validates `NanoCpus` against
 * the host at container create AND update ("range of CPUs is from 0.01 to
 * N.00, as there are only N CPUs available", HTTP 400), so a plugin default
 * such as `cpus: 1.5` fails outright on a 1-vCPU Docker host — and only the
 * first time the container has to be (re)created, which is when it is
 * hardest to see coming. Podman does not validate, but a cap above the core
 * count grants nothing either. Runs after `filterUnsupportedLimits` on the
 * same object that is created, labelled and compared against the live
 * container, so the clamp is stable across reconciles (no live-update
 * ping-pong between 1.5 requested and 1.0 observed).
 *
 * `runtime.hostCpus` unknown → limits returned as-is, `clamped: null`.
 */
export function clampCpusToHost(
  limits: ContainerResourceLimits,
  runtime: ContainerRuntimeInfo,
): { accepted: ContainerResourceLimits; clamped: ResourceClamp | null } {
  const host = runtime.hostCpus;
  const cpus = limits.cpus;
  if (
    host === undefined ||
    host === null ||
    !(host > 0) ||
    typeof cpus !== "number" ||
    !(cpus > host)
  ) {
    return { accepted: limits, clamped: null };
  }
  return {
    accepted: { ...limits, cpus: host },
    clamped: {
      resource: "cpus",
      requested: cpus,
      granted: host,
      reason:
        `cpus ${cpus} exceeds the ${host} CPU${host === 1 ? "" : "s"} the ` +
        `${runtime.runtime} daemon reports; capped to ${host}`,
    },
  };
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
 * Translate ContainerResourceLimits into a dockerode `HostConfig`
 * resource fragment for `createContainer`. CPU becomes NanoCpus, memory
 * strings become byte counts.
 *
 * Fields whose backing cgroup controller is unavailable on the host are
 * silently dropped — caller should call `filterUnsupportedLimits`
 * separately if it wants to log the dropped set.
 */
export function resourcePayloadForRun(
  limits: ContainerResourceLimits | undefined,
  runtime: ContainerRuntimeInfo,
): ResourceHostConfig {
  if (!limits) return {};
  const { accepted } = filterUnsupportedLimits(limits, runtime);
  return limitsToHostConfig(accepted);
}

/**
 * Shared `ContainerResourceLimits` → `ResourceHostConfig` translation.
 * Skips null/undefined and unparseable memory values. `cpus` → NanoCpus
 * (integer; rounded to avoid float noise), memory strings → bytes.
 */
function limitsToHostConfig(
  limits: ContainerResourceLimits,
): ResourceHostConfig {
  const hc: ResourceHostConfig = {};
  if (limits.cpus !== undefined && limits.cpus !== null) {
    hc.NanoCpus = Math.round(limits.cpus * 1_000_000_000);
  }
  if (limits.cpuShares !== undefined && limits.cpuShares !== null) {
    hc.CpuShares = limits.cpuShares;
  }
  if (limits.cpusetCpus !== undefined && limits.cpusetCpus !== null) {
    hc.CpusetCpus = limits.cpusetCpus;
  }
  if (limits.memory !== undefined && limits.memory !== null) {
    hc.Memory = parseMemoryToBytes(limits.memory);
  }
  if (limits.memorySwap !== undefined && limits.memorySwap !== null) {
    hc.MemorySwap = parseMemoryToBytes(limits.memorySwap);
  }
  if (
    limits.memoryReservation !== undefined &&
    limits.memoryReservation !== null
  ) {
    hc.MemoryReservation = parseMemoryToBytes(limits.memoryReservation);
  }
  if (limits.pidsLimit !== undefined && limits.pidsLimit !== null) {
    hc.PidsLimit = limits.pidsLimit;
  }
  if (limits.oomScoreAdj !== undefined && limits.oomScoreAdj !== null) {
    hc.OomScoreAdj = limits.oomScoreAdj;
  }
  return hc;
}

/**
 * Translate ContainerResourceLimits into the flags accepted by
 * `podman update` / `docker update`. Returns null if the limits
 * contain a field that cannot be live-updated (e.g. cpuset on some
 * kernels, or oomScoreAdj which is set at create time only).
 *
 * Caller should fall back to recreate when this returns null.
 */
export function resourcePayloadForUpdate(
  limits: ContainerResourceLimits,
): ResourceHostConfig | null {
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
  // oomScoreAdj is excluded from LIVE_UPDATABLE_FIELDS, so the only fields
  // that reach here are CPU/memory/pids — all valid `container.update`
  // inputs. Reuse the shared translator and drop OomScoreAdj if present.
  const hc = limitsToHostConfig(limits);
  delete hc.OomScoreAdj;
  // The compat `/update` endpoint ignores NanoCpus (podman) — express the
  // CPU cap as CFS quota/period, which both runtimes honour on update.
  if (hc.NanoCpus !== undefined) {
    hc.CpuQuota = Math.round((hc.NanoCpus / 1_000_000_000) * CPU_PERIOD);
    hc.CpuPeriod = CPU_PERIOD;
    delete hc.NanoCpus;
  }
  return hc;
}

/**
 * Attempt a live resource update on the named
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
  client: ContainerClient = getClient(),
): Promise<{ ok: boolean; stderr?: string }> {
  const { accepted } = filterUnsupportedLimits(limits, runtime);
  const payload = resourcePayloadForUpdate(accepted);
  if (payload === null) {
    return { ok: false, stderr: "limits contain non-live-updatable fields" };
  }
  if (Object.keys(payload).length === 0) {
    // Nothing to apply via update. Don't claim vacuous success without
    // verifying the target exists — the caller may be operating on a
    // container that was removed out from under us.
    const info = await safeInspect(() =>
      client.getContainer(fullName).inspect(),
    );
    if (info === null) {
      return { ok: false, stderr: `container ${fullName} does not exist` };
    }
    return { ok: true };
  }
  const result = await safe(() =>
    client.getContainer(fullName).update(payload),
  );
  if (!result.ok) {
    return {
      ok: false,
      stderr: messageWithRaw(result.error.userMessage, result.error.raw),
    };
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
