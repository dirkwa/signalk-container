import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestStore } from "../manifest/store.js";
import type { ResolveResult } from "../types.js";

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);

function resolveAs(digest: string): ResolveResult {
  return {
    pullSpec: `docker.io/questdb/questdb:9.0.0`,
    resolvedDigest: digest,
    source: "resolved-from-tag",
  };
}

function commonParams(
  digest: string,
  overrides: Partial<{
    pluginId: string;
    pluginVersion: string;
    containerName: string;
  }> = {},
) {
  return {
    pluginId: overrides.pluginId ?? "signalk-questdb",
    pluginVersion: overrides.pluginVersion ?? "1.0.0",
    containerName: overrides.containerName ?? "questdb",
    config: { image: "questdb/questdb", tag: "9.0.0" },
    resolved: resolveAs(digest),
    reason: "plugin-install" as const,
  };
}

describe("ManifestStore", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "sk-manifest-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("first recordResolution writes a plugin-install entry", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await store.recordResolution(commonParams(DIGEST_A));
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    assert.equal(m.schemaVersion, 1);
    assert.equal(m.pluginId, "signalk-questdb");
    assert.equal(m.pluginVersion, "1.0.0");
    const entry = m.containers["questdb"];
    assert.ok(entry);
    assert.equal(entry.declaredDigest, null);
    assert.equal(entry.resolvedDigest, DIGEST_A);
    assert.equal(entry.updateChannel, "tag:9.0.0");
    assert.equal(entry.history.length, 1);
    assert.equal(entry.history[0].from, null);
    assert.equal(entry.history[0].to, DIGEST_A);
    assert.equal(entry.history[0].reason, "plugin-install");
    assert.equal(entry.history[0].triggeredBy, "1.0.0");
  });

  it("second recordResolution with same digest is idempotent (no history grow)", async () => {
    const ticks = ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"];
    let i = 0;
    const store = new ManifestStore(
      baseDir,
      () => {},
      () => ticks[i++] ?? "2026-12-31T00:00:00Z",
    );
    await store.recordResolution(commonParams(DIGEST_A));
    await store.recordResolution(commonParams(DIGEST_A));
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    assert.equal(m.containers["questdb"].history.length, 1);
    assert.equal(
      m.containers["questdb"].resolvedAt,
      "2026-01-02T00:00:00Z",
      "resolvedAt should be refreshed",
    );
  });

  it("digest change auto-detects plugin-update when caller omits reason", async () => {
    const store = new ManifestStore(baseDir, () => {});
    // Strip `reason` so the store auto-detects from the transition.
    const { reason: _u1, ...a } = commonParams(DIGEST_A);
    const { reason: _u2, ...b } = commonParams(DIGEST_B);
    void _u1;
    void _u2;
    await store.recordResolution(a);
    await store.recordResolution(b);
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    const history = m.containers["questdb"].history;
    assert.equal(history.length, 2);
    assert.equal(history[1].from, DIGEST_A);
    assert.equal(history[1].to, DIGEST_B);
    assert.equal(history[1].reason, "plugin-update");
  });

  it("trims history to 20 entries", async () => {
    const store = new ManifestStore(baseDir, () => {});
    for (let i = 0; i < 22; i++) {
      const digest = "sha256:" + i.toString(16).padStart(64, "0");
      await store.recordResolution(commonParams(digest));
    }
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    const history = m.containers["questdb"].history;
    assert.equal(history.length, 20);
    // Oldest two dropped; index 0 should now be the 3rd-written digest.
    assert.equal(history[0].to, "sha256:" + (2).toString(16).padStart(64, "0"));
  });

  it("concurrent recordResolution for the same pluginId is serialized", async () => {
    const ticks = ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"];
    let i = 0;
    const store = new ManifestStore(
      baseDir,
      () => {},
      () => ticks[i++] ?? "2026-12-31T00:00:00Z",
    );
    await Promise.all([
      store.recordResolution(commonParams(DIGEST_A)),
      store.recordResolution(commonParams(DIGEST_B)),
    ]);
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    const history = m.containers["questdb"].history;
    assert.equal(history.length, 2);
    assert.equal(history[0].to, DIGEST_A);
    assert.equal(history[1].from, DIGEST_A);
    assert.equal(history[1].to, DIGEST_B);
  });

  it("different pluginIds get independent files", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await store.recordResolution(commonParams(DIGEST_A));
    await store.recordResolution({
      ...commonParams(DIGEST_B),
      pluginId: "signalk-grafana",
      containerName: "grafana",
    });
    const list = await store.list();
    assert.equal(list.length, 2);
    const ids = list.map((m) => m.pluginId).sort();
    assert.deepEqual(ids, ["signalk-grafana", "signalk-questdb"]);
  });

  it("get() returns null for an absent pluginId", async () => {
    const store = new ManifestStore(baseDir, () => {});
    assert.equal(await store.get("nope"), null);
  });

  it("get() returns null and refuses to overwrite a schema-mismatched file", async () => {
    const store = new ManifestStore(baseDir, () => {});
    const filePath = join(baseDir, "signalk-questdb.json");
    writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 99, broken: true }),
    );
    assert.equal(await store.get("signalk-questdb"), null);
    await store.recordResolution(commonParams(DIGEST_A));
    // The bad file is preserved.
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(onDisk.schemaVersion, 99);
    assert.equal(onDisk.broken, true);
  });

  it("getContainerHistory finds history across manifests", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await store.recordResolution(commonParams(DIGEST_A));
    await store.recordResolution(commonParams(DIGEST_B));
    const history = await store.getContainerHistory("questdb");
    assert.equal(history.length, 2);
    assert.equal(history[0].to, DIGEST_A);
    assert.equal(history[1].to, DIGEST_B);
  });

  it("getContainerHistory returns [] for an unknown container", async () => {
    const store = new ManifestStore(baseDir, () => {});
    assert.deepEqual(await store.getContainerHistory("nobody"), []);
  });

  it("getContainerHistory throws when multiple manifests own the same container", async () => {
    const store = new ManifestStore(baseDir, () => {});
    // Two plugins both record an entry for the same containerName.
    await store.recordResolution({
      ...commonParams(DIGEST_A),
      pluginId: "container:questdb",
    });
    await store.recordResolution({
      ...commonParams(DIGEST_B),
      pluginId: "signalk-questdb",
    });
    await assert.rejects(
      () => store.getContainerHistory("questdb"),
      /Ambiguous container history/,
    );
  });

  it("synthetic pluginId fallback (container:<name>) works as a key", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await store.recordResolution({
      ...commonParams(DIGEST_A),
      pluginId: "container:questdb",
    });
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].pluginId, "container:questdb");
  });

  it("records declaredDigest when config has one", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await store.recordResolution({
      ...commonParams(DIGEST_A),
      config: {
        image: "questdb/questdb",
        tag: "9.0.0",
        digest: DIGEST_A,
        updateChannel: "digest:explicit",
      },
      resolved: {
        pullSpec: `docker.io/questdb/questdb@${DIGEST_A}`,
        resolvedDigest: DIGEST_A,
        source: "declared",
      },
    });
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    const entry = m.containers["questdb"];
    assert.equal(entry.declaredDigest, DIGEST_A);
    assert.equal(entry.updateChannel, "digest:explicit");
  });

  it("preserves registeredAt across writes", async () => {
    const ticks = [
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "2026-01-03T00:00:00Z",
    ];
    let i = 0;
    const store = new ManifestStore(
      baseDir,
      () => {},
      () => ticks[i++] ?? "2026-12-31T00:00:00Z",
    );
    await store.recordResolution(commonParams(DIGEST_A));
    await store.recordResolution(commonParams(DIGEST_B));
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    assert.equal(m.registeredAt, "2026-01-01T00:00:00Z");
  });

  it("creates baseDir lazily on first write", async () => {
    const subdir = join(baseDir, "nested", "manifests");
    assert.ok(!existsSync(subdir));
    const store = new ManifestStore(subdir, () => {});
    await store.recordResolution(commonParams(DIGEST_A));
    assert.ok(existsSync(subdir));
    const files = readdirSync(subdir);
    assert.ok(files.includes("signalk-questdb.json"));
  });

  it("returns [] from list() when baseDir does not exist", async () => {
    const subdir = join(baseDir, "never-created");
    const store = new ManifestStore(subdir, () => {});
    assert.deepEqual(await store.list(), []);
  });

  it("sweeps stale .tmp.* files left behind by a prior crash", async () => {
    const store = new ManifestStore(baseDir, () => {});
    // First write so the dir exists.
    await store.recordResolution(commonParams(DIGEST_A));
    // Drop a stale tmp file as if a prior write was killed.
    const stale = join(baseDir, "signalk-questdb.json.tmp.123.456.abc");
    writeFileSync(stale, "{}");
    // Backdate it past the 1h threshold.
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    // node:fs.utimesSync takes seconds.
    const fs = await import("node:fs");
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
    assert.ok(existsSync(stale));
    // The next write should sweep it away.
    await store.recordResolution(commonParams(DIGEST_B));
    assert.ok(!existsSync(stale), "stale tmp file should have been removed");
  });

  it("accepts a scoped npm pluginId (`@scope/name`)", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await store.recordResolution({
      ...commonParams(DIGEST_A),
      pluginId: "@signalk/foo",
    });
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].pluginId, "@signalk/foo");
    // Filename encoding round-trips: list() decodes from the on-disk
    // name back to the canonical pluginId.
    const files = readdirSync(baseDir);
    assert.ok(files.includes("@signalk%2Ffoo.json"));
  });

  it("encodes : in synthetic pluginId so the filename works on NTFS", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await store.recordResolution({
      ...commonParams(DIGEST_A),
      pluginId: "container:questdb",
    });
    const files = readdirSync(baseDir);
    assert.ok(files.includes("container%3Aquestdb.json"));
  });

  it("rejects pluginId containing path-traversal", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await assert.rejects(
      () =>
        store.recordResolution({
          ...commonParams(DIGEST_A),
          pluginId: "../escape",
        }),
      /Invalid pluginId/,
    );
  });

  it("rejects pluginId with control characters", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await assert.rejects(
      () =>
        store.recordResolution({
          ...commonParams(DIGEST_A),
          pluginId: "weird\0null",
        }),
      /Invalid pluginId/,
    );
  });

  it("rejects pluginId starting with a hyphen or dot", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await assert.rejects(
      () =>
        store.recordResolution({
          ...commonParams(DIGEST_A),
          pluginId: "-bad",
        }),
      /Invalid pluginId/,
    );
    await assert.rejects(
      () =>
        store.recordResolution({
          ...commonParams(DIGEST_A),
          pluginId: ".bad",
        }),
      /Invalid pluginId/,
    );
  });

  it("recordResolution without `reason` auto-detects plugin-install then plugin-update", async () => {
    const store = new ManifestStore(baseDir, () => {});
    // Drop reason entirely — store should auto-detect.
    const { reason: _unused, ...base } = commonParams(DIGEST_A);
    void _unused;
    await store.recordResolution(base);
    await store.recordResolution({
      ...base,
      resolved: { ...base.resolved, resolvedDigest: DIGEST_B },
    });
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    const history = m.containers["questdb"].history;
    assert.equal(history.length, 2);
    assert.equal(history[0].reason, "plugin-install");
    assert.equal(history[1].reason, "plugin-update");
  });

  it("recordResolution honors explicit `reason` on a digest transition", async () => {
    const store = new ManifestStore(baseDir, () => {});
    // First record establishes the prior; reason on the first is always plugin-install.
    await store.recordResolution({
      ...commonParams(DIGEST_A),
      reason: "user-pull", // ignored on first record per design
    });
    // Second record changes the digest; caller's user-pull reason wins.
    await store.recordResolution({
      ...commonParams(DIGEST_B),
      reason: "user-pull",
    });
    const m = await store.get("signalk-questdb");
    assert.ok(m);
    const history = m.containers["questdb"].history;
    assert.equal(history.length, 2);
    assert.equal(history[0].reason, "plugin-install");
    assert.equal(history[1].reason, "user-pull");
  });

  it("get() rejects invalid pluginId (defence in depth)", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await assert.rejects(() => store.get("../escape"), /Invalid pluginId/);
  });

  it("distinct allowed pluginIds get distinct filenames (no aliasing)", async () => {
    const store = new ManifestStore(baseDir, () => {});
    await store.recordResolution({
      ...commonParams(DIGEST_A),
      pluginId: "@signalk/foo",
    });
    await store.recordResolution({
      ...commonParams(DIGEST_B),
      pluginId: "container:foo",
    });
    const list = await store.list();
    assert.equal(list.length, 2);
    const ids = list.map((m) => m.pluginId).sort();
    assert.deepEqual(ids, ["@signalk/foo", "container:foo"]);
  });
});
