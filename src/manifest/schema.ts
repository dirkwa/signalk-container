import * as Type from "typebox";
import type { Static } from "typebox";

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

export type HistoryEntry = Static<typeof HistoryEntrySchema>;
export type ContainerManifestEntry = Static<
  typeof ContainerManifestEntrySchema
>;
export type ConsumerManifest = Static<typeof ConsumerManifestSchema>;
