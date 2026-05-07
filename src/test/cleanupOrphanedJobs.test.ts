import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOrphanLine } from "../jobs";

describe("parseOrphanLine", () => {
  it("parses a well-formed line with all our labels", () => {
    const line =
      "sk-job-7d4839a9\tghcr.io/dirkwa/.../tippecanoe:latest\tsk-charts-job=1,sk-job-owner=signalk-charts-provider-simple,sk-job-label=tippecanoe";
    const parsed = parseOrphanLine(line, "signalk-charts-provider-simple");
    assert.deepEqual(parsed, {
      name: "sk-job-7d4839a9",
      image: "ghcr.io/dirkwa/.../tippecanoe:latest",
      ownerPluginId: "signalk-charts-provider-simple",
      label: "tippecanoe",
    });
  });

  it("tolerates a missing user-supplied label", () => {
    const line =
      "sk-job-abc12345\tdocker.io/library/alpine:latest\tsk-charts-job=1,sk-job-owner=signalk-charts-provider-simple";
    const parsed = parseOrphanLine(line, "signalk-charts-provider-simple");
    assert.equal(parsed?.label, undefined);
    assert.equal(parsed?.name, "sk-job-abc12345");
  });

  it("tolerates label ordering — owner first, charts-marker second", () => {
    // Different runtime versions (and docker vs podman) emit labels in
    // different orders. The parser must not depend on order.
    const line =
      "sk-job-abc\timg:latest\tsk-job-owner=plugin-x,sk-charts-job=1,sk-job-label=lbl";
    const parsed = parseOrphanLine(line, "plugin-x");
    assert.equal(parsed?.label, "lbl");
  });

  it("returns null on a blank line", () => {
    assert.equal(parseOrphanLine("", "x"), null);
    assert.equal(parseOrphanLine("   \t  \t  ", "x"), null);
  });

  it("returns null when name or image is missing", () => {
    // Three columns required (name, image, labels). A line with
    // fewer columns ("only-one-column"), or with an empty name or
    // image column ("name-only\t\tlabels", "\timg\tlabels"), means
    // the ps emitter shifted shape — refuse to invent data.
    assert.equal(parseOrphanLine("only-one-column", "x"), null);
    assert.equal(parseOrphanLine("name-only\t\tlabels", "x"), null);
    assert.equal(parseOrphanLine("\timg\tlabels", "x"), null);
  });

  it("returns null when the owner label does not match ownerPluginId", () => {
    // The `--filter label=sk-job-owner=...` query at runtime should
    // restrict ps output to the caller's plugin, but defense in depth
    // — if a mismatched row ever appears, refuse to claim it rather
    // than reap someone else's container.
    const line =
      "sk-job-x\timg:latest\tsk-charts-job=1,sk-job-owner=plugin-a,sk-job-label=lbl";
    assert.equal(parseOrphanLine(line, "plugin-b"), null);
  });

  it("survives an empty labels column", () => {
    // Some runtimes will emit a trailing empty string for unlabelled
    // containers. We're filtering by label so this shouldn't happen
    // for our jobs in practice, but the parser must not throw.
    const line = "sk-job-x\timg:latest\t";
    const parsed = parseOrphanLine(line, "owner-x");
    assert.equal(parsed?.label, undefined);
    assert.equal(parsed?.name, "sk-job-x");
  });

  it("decodes percent-encoded labels back to the original value", () => {
    // The labels column from `podman ps` is comma-delimited. runJob
    // percent-encodes value text on write so a comma inside a label
    // doesn't truncate. Verify the parser reverses the encoding.
    const line =
      "sk-job-x\timg:latest\tsk-charts-job=1,sk-job-owner=plugin,sk-job-label=tippecanoe%2Cwith%2Ccommas";
    const parsed = parseOrphanLine(line, "plugin");
    assert.equal(parsed?.label, "tippecanoe,with,commas");
  });

  it("falls back to the raw value when label decoding fails", () => {
    // %ZZ isn't a valid percent-escape. Better to surface the raw
    // string than silently drop the entry — the user can still see
    // SOMETHING in the rollback log.
    const line =
      "sk-job-x\timg:latest\tsk-charts-job=1,sk-job-owner=plugin,sk-job-label=bad%ZZencoding";
    const parsed = parseOrphanLine(line, "plugin");
    assert.equal(parsed?.label, "bad%ZZencoding");
  });
});
