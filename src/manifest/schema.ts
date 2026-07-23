import * as Type from "typebox";
import type { Static } from "typebox";
import type {
  ConsumerManifest,
  ContainerManifestEntry,
  HistoryEntry,
} from "../types.js";

// Digest formats accepted on disk:
//   - `sha256:<64-hex>` — the canonical RepoDigest from a registry pull.
//   - `local:<image-id>` — synthetic identity for locally-built images
//     that have no RepoDigests. Used as `resolvedDigest` only;
//     `declaredDigest` is always a `sha256:` digest (or null), since
//     a plugin can only declare what a registry produced.
/** Matches a canonical registry digest: `sha256:<64-hex>`. */
export const SHA256_DIGEST_PATTERN = "^sha256:[a-f0-9]{64}$";
/** Matches a resolved digest: `sha256:<hex>` or the `local:<image-id>` fallback. */
export const RESOLVED_DIGEST_PATTERN = "^(sha256:[a-f0-9]{64}|local:.+)$";

export const HistoryEntrySchema = Type.Object({
  ts: Type.String({ format: "date-time" }),
  from: Type.Union([
    Type.String({ pattern: RESOLVED_DIGEST_PATTERN }),
    Type.Null(),
  ]),
  to: Type.String({ pattern: RESOLVED_DIGEST_PATTERN }),
  reason: Type.Union([
    Type.Literal("plugin-install"),
    Type.Literal("plugin-update"),
    Type.Literal("user-pull"),
    Type.Literal("auto-update"),
    Type.Literal("manual-check"),
  ]),
  triggeredBy: Type.Optional(Type.String()),
});

export const ContainerManifestEntrySchema = Type.Object({
  image: Type.String(),
  declaredTag: Type.String(),
  declaredDigest: Type.Union([
    Type.String({ pattern: SHA256_DIGEST_PATTERN }),
    Type.Null(),
  ]),
  resolvedDigest: Type.String({ pattern: RESOLVED_DIGEST_PATTERN }),
  resolvedAt: Type.String({ format: "date-time" }),
  updateChannel: Type.String(),
  history: Type.Array(HistoryEntrySchema),
});

export const ConsumerManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  pluginId: Type.String(),
  pluginVersion: Type.String(),
  registeredAt: Type.String({ format: "date-time" }),
  containers: Type.Record(Type.String(), ContainerManifestEntrySchema),
});

// The manifest types are hand-written in ../types.ts (the public type
// home, kept free of any `typebox` dependency so "signalk-container/types"
// stays self-contained). These assertions fail the build if a schema and
// its interface ever drift — the schema is the runtime validator, the
// interface is the compile-time contract, and they must stay identical.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function assertEquivalent<A, B>(
  ok: Equals<A, B> extends true ? true : never,
): void {
  void ok;
}
assertEquivalent<Static<typeof HistoryEntrySchema>, HistoryEntry>(true);
assertEquivalent<
  Static<typeof ContainerManifestEntrySchema>,
  ContainerManifestEntry
>(true);
assertEquivalent<Static<typeof ConsumerManifestSchema>, ConsumerManifest>(true);
