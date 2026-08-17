/**
 * Browser-safe config-normalization helpers shared between the plugin
 * backend (`index.ts`) and the React config panel. Kept free of any
 * node-only imports so it can be bundled into the configpanel.
 */

import type { ContainerResourceLimits, CpuPriority } from "./types.js";

/**
 * Prior managed-image versions the reaper keeps by default, in addition
 * to the running one. Shared between the config schema's `default`, the
 * runtime fallback, and the config panel so they can't drift.
 */
export const DEFAULT_KEEP_IMAGE_VERSIONS = 1;

/**
 * Coerce the `keepImageVersions` config value to a non-negative integer.
 * The schema and the panel dropdown constrain it for normal saves, but a
 * config edited by hand or supplied by an API caller can carry a decimal,
 * a negative, or a non-number. A malformed value falls back to the
 * default rather than to `0` — `0` is the most aggressive policy (reap
 * every superseded version), which a typo must never silently select.
 */
export function normalizeKeepImageVersions(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_KEEP_IMAGE_VERSIONS;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Seed value for the config panel's keep-versions `<select>`: the
 * normalized number rendered as a string. A `<select>` compares option
 * `value`s as strings, so the stored config must round-trip through the
 * same normalization the backend applies before it can match an option.
 */
export function keepImageVersionsSelectValue(value: unknown): string {
  return String(normalizeKeepImageVersions(value));
}

/**
 * The number written back when the panel saves the `<select>`'s current
 * string value. Goes through the same normalization so a stale/foreign
 * string can never persist a worse policy than the contract allows.
 */
export function keepImageVersionsFromSelectValue(selectValue: string): number {
  // `Number("")` is 0, not NaN — guard so a blank value falls back to the
  // default rather than silently selecting the most aggressive policy.
  if (selectValue.trim() === "") return DEFAULT_KEEP_IMAGE_VERSIONS;
  return normalizeKeepImageVersions(Number(selectValue));
}

/**
 * CPU priority tiers, expressed as the `--cpu-shares` value each one
 * maps to. Shares are the wire format the runtime takes; the kernel
 * ranks siblings by cgroup v2 `cpu.weight`, and runc translates
 * `weight = 1 + (shares - 2) * 9999 / 262142`. `normal` is deliberately
 * *no request*: an unset container sits at weight 100, whereas an
 * explicit 1024 lands at 39 — "1024 is the default" is a cgroup v1
 * notion that no longer holds.
 *
 * Weights only arbitrate among cgroup siblings under contention; hard
 * caps are `cpus`.
 */
export const CPU_PRIORITY_SHARES: Readonly<Record<CpuPriority, number | null>> =
  {
    /** ≈ weight 196 */
    high: 5120,
    /** unset → weight 100 */
    normal: null,
    /** ≈ weight 20 */
    low: 512,
    /** ≈ weight 5 */
    lowest: 128,
  };

/** Tier keys in descending priority order, for select widgets. */
export const CPU_PRIORITIES: readonly CpuPriority[] = [
  "high",
  "normal",
  "low",
  "lowest",
];

export const DEFAULT_CONTAINER_CPU_PRIORITY: CpuPriority = "normal";
/**
 * One-shot helpers (chart imports, GDAL, wipe jobs) are the workloads
 * that saturate every core on a small host; they yield to the
 * long-running services by default.
 */
export const DEFAULT_JOB_CPU_PRIORITY: CpuPriority = "lowest";

/**
 * Coerce a stored config value to a tier name. Anything that is not
 * a known tier (hand-edited config, older panel) falls back to the
 * given default so a typo can never select a priority nobody asked for.
 */
export function normalizeCpuPriority(
  value: unknown,
  fallback: CpuPriority,
): CpuPriority {
  return typeof value === "string" &&
    (CPU_PRIORITIES as readonly string[]).includes(value)
    ? (value as CpuPriority)
    : fallback;
}

/**
 * The resource-limits fragment a tier contributes. `normal` contributes
 * nothing, so it never shows up as a limit and cannot mask a
 * consumer's or user's own `cpuShares`.
 */
export function cpuPriorityLimits(
  tier: CpuPriority,
): Pick<ContainerResourceLimits, "cpuShares"> {
  const shares = CPU_PRIORITY_SHARES[tier];
  return shares === null ? {} : { cpuShares: shares };
}

/** Reverse lookup for display: the tier a shares value stands for, if any. */
export function cpuPriorityForShares(
  shares: number | null | undefined,
): CpuPriority | null {
  if (shares === undefined || shares === null) return "normal";
  for (const tier of CPU_PRIORITIES) {
    if (CPU_PRIORITY_SHARES[tier] === shares) return tier;
  }
  return null;
}

/** Bounds the runtime accepts for `--cpu-shares`. */
const CPU_SHARES_MIN = 2;
const CPU_SHARES_MAX = 262144;

/**
 * runc's cgroup v2 translation of `--cpu-shares` into `cpu.weight`
 * (integer division). Unset shares are weight 100.
 */
export function cpuSharesToWeight(shares: number | null | undefined): number {
  if (shares === undefined || shares === null) return 100;
  const s = Math.min(CPU_SHARES_MAX, Math.max(CPU_SHARES_MIN, shares));
  return 1 + Math.floor(((s - 2) * 9999) / 262142);
}
