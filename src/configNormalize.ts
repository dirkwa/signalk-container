/**
 * Browser-safe config-normalization helpers shared between the plugin
 * backend (`index.ts`) and the React config panel. Kept free of any
 * node-only imports so it can be bundled into the configpanel.
 */

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
