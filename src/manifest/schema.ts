import * as Type from "typebox";
import type { Static } from "typebox";

export const HistoryEntrySchema = Type.Object({
  ts: Type.String({ format: "date-time" }),
  from: Type.Union([Type.String(), Type.Null()]),
  to: Type.String(),
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
  declaredDigest: Type.Union([Type.String(), Type.Null()]),
  resolvedDigest: Type.String(),
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
