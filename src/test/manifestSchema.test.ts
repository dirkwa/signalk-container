import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Check, Errors } from "typebox/value";
import { ConsumerManifestSchema } from "../manifest/schema.js";

const DIGEST = "sha256:" + "a".repeat(64);

const validManifest = {
  schemaVersion: 1,
  pluginId: "signalk-questdb",
  pluginVersion: "1.0.0",
  registeredAt: "2026-05-13T00:00:00Z",
  containers: {
    questdb: {
      image: "questdb/questdb",
      declaredTag: "9.0.0",
      declaredDigest: null,
      resolvedDigest: DIGEST,
      resolvedAt: "2026-05-13T00:00:00Z",
      updateChannel: "tag:9.0.0",
      history: [
        {
          ts: "2026-05-13T00:00:00Z",
          from: null,
          to: DIGEST,
          reason: "plugin-install",
          triggeredBy: "1.0.0",
        },
      ],
    },
  },
};

describe("ConsumerManifestSchema", () => {
  it("accepts a valid manifest fixture", () => {
    assert.ok(Check(ConsumerManifestSchema, validManifest));
  });

  it("rejects a manifest with the wrong schemaVersion", () => {
    const bad = { ...validManifest, schemaVersion: 2 };
    assert.ok(!Check(ConsumerManifestSchema, bad));
  });

  it("rejects a manifest missing pluginId", () => {
    const bad = structuredClone(validManifest) as Partial<typeof validManifest>;
    delete bad.pluginId;
    assert.ok(!Check(ConsumerManifestSchema, bad));
  });

  it("rejects a history entry with an unknown reason", () => {
    const bad = structuredClone(validManifest);
    (bad.containers.questdb.history[0] as { reason: string }).reason =
      "made-up-reason";
    assert.ok(!Check(ConsumerManifestSchema, bad));
  });

  it("rejects a non-null declaredDigest that is not a string", () => {
    const bad = structuredClone(validManifest);
    (bad.containers.questdb as { declaredDigest: unknown }).declaredDigest = 42;
    assert.ok(!Check(ConsumerManifestSchema, bad));
  });

  it("Errors() produces a useful instancePath on invalid input", () => {
    const bad = { ...validManifest, schemaVersion: 2 };
    const errors = [...Errors(ConsumerManifestSchema, bad)];
    assert.ok(errors.length > 0);
    const paths = errors
      .map((e) => ("instancePath" in e ? e.instancePath : ""))
      .join(" ");
    assert.ok(paths.includes("schemaVersion"), `paths: ${paths}`);
  });
});
