import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileUpdateCache, MemoryUpdateCache } from "../updates/cache.js";
import type { UpdateCheckResult } from "../updates/types.js";

function sampleResult(pluginId: string): UpdateCheckResult {
  return {
    pluginId,
    containerName: pluginId,
    runningTag: "1.0.0",
    tagKind: "semver",
    currentVersion: "1.0.0",
    latestVersion: "1.0.1",
    updateAvailable: true,
    reason: "newer-version",
    checkedAt: "2026-04-08T12:00:00.000Z",
    lastSuccessfulCheckAt: "2026-04-08T12:00:00.000Z",
    fromCache: false,
  };
}

describe("FileUpdateCache", () => {
  it("round-trips a result through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "skc-cache-"));
    try {
      const cache = new FileUpdateCache(join(dir, "cache.json"));
      const data = { foo: sampleResult("foo") };
      cache.save(data);
      const loaded = cache.load();
      assert.deepEqual(loaded, data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty object for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "skc-cache-"));
    try {
      const cache = new FileUpdateCache(join(dir, "does-not-exist.json"));
      assert.deepEqual(cache.load(), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty object for corrupted JSON, does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "skc-cache-"));
    try {
      const path = join(dir, "broken.json");
      writeFileSync(path, "{not valid json", "utf-8");
      const cache = new FileUpdateCache(path);
      assert.deepEqual(cache.load(), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty object for wrong-shape JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "skc-cache-"));
    try {
      const path = join(dir, "wrong.json");
      writeFileSync(
        path,
        JSON.stringify({ version: 99, results: {} }),
        "utf-8",
      );
      const cache = new FileUpdateCache(path);
      assert.deepEqual(cache.load(), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directory if missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "skc-cache-"));
    try {
      const path = join(dir, "nested", "deeper", "cache.json");
      const cache = new FileUpdateCache(path);
      cache.save({ foo: sampleResult("foo") });
      const loaded = cache.load();
      assert.equal(loaded.foo?.pluginId, "foo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MemoryUpdateCache", () => {
  it("round-trips through memory", () => {
    const cache = new MemoryUpdateCache();
    const data = { bar: sampleResult("bar") };
    cache.save(data);
    assert.deepEqual(cache.load(), data);
  });

  it("returns a copy, not the live reference", () => {
    const cache = new MemoryUpdateCache();
    cache.save({ a: sampleResult("a") });
    const loaded = cache.load();
    delete loaded.a;
    // Mutation of returned object must not affect cache state.
    assert.equal(cache.load().a?.pluginId, "a");
  });
});
