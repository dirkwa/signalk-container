import type { TagKind } from "./types.js";

const FLOATING_TAG_NAMES = new Set([
  "latest",
  "main",
  "master",
  "edge",
  "nightly",
  "stable",
  "dev",
  "rolling",
  "head",
  "trunk",
]);

/**
 * Classify a container image tag as semver, floating, or unknown.
 * The service uses this to decide whether to compare versions
 * (semver) or compare digests (floating/unknown).
 *
 * - "9.2.0", "v1.5", "2.0.0-beta1" → semver
 * - "latest", "main", "master", "edge", "nightly", "v3" → floating
 * - "my-fork", "custom-build", "" → unknown (treated like floating
 *   for safety: digest drift only, never claims "newer-version")
 */
export function classifyTag(tag: string): TagKind {
  const t = tag.trim();
  if (!t) return "unknown";

  // Floating: well-known names
  if (FLOATING_TAG_NAMES.has(t.toLowerCase())) return "floating";

  // Floating: bare major version like "v3" or "3" — not a full pin
  if (/^v?\d+$/i.test(t)) return "floating";

  // Semver: major.minor or major.minor.patch with optional prerelease
  if (/^v?\d+\.\d+(\.\d+)?(-[\w.]+)?$/i.test(t)) return "semver";

  return "unknown";
}
