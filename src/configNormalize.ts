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
 * ranks cgroup siblings by cgroup v2 `cpu.weight`, and the OCI runtime
 * translates shares into a weight. That translation is the runtime's:
 * crun and runc before 1.3.2 use a linear formula (1024 → 39), runc
 * 1.3.2+ a quadratic one (1024 → 100). Unset is weight 100 everywhere,
 * so `normal` is deliberately *no request* — the only value that means
 * the same on every runtime — and the tiers are ordered by shares,
 * which both formulas preserve.
 *
 * Weights only arbitrate among cgroup siblings under contention; hard
 * caps are `cpus`.
 */
export const CPU_PRIORITY_SHARES: Readonly<Record<CpuPriority, number | null>> =
  {
    high: 5120,
    normal: null,
    low: 512,
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
