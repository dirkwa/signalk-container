import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cachedProbe, type ProbeCacheEntry } from "../devices.js";
import type { HostDeviceProbeResult } from "../types.js";

const FOUND: HostDeviceProbeResult = {
  exists: true,
  nodes: ["card0"],
  groups: ["video"],
};
const TTL = 60_000;

describe("cachedProbe", () => {
  it("runs the probe once and reuses the answer within the TTL", async () => {
    const cache = new Map<string, ProbeCacheEntry>();
    let runs = 0;
    const run = () => {
      runs++;
      return Promise.resolve(FOUND);
    };
    assert.deepEqual(await cachedProbe(cache, "/dev/dri", 0, TTL, run), FOUND);
    assert.deepEqual(await cachedProbe(cache, "/dev/dri", 100, TTL, run), FOUND);
    assert.equal(runs, 1);
  });

  // The containerized path spawns a container, so two callers racing on the
  // same path must not each start one.
  it("shares one in-flight probe between concurrent callers", async () => {
    const cache = new Map<string, ProbeCacheEntry>();
    let runs = 0;
    const run = () => {
      runs++;
      return new Promise<HostDeviceProbeResult>((resolve) =>
        setTimeout(() => resolve(FOUND), 10),
      );
    };
    const [a, b] = await Promise.all([
      cachedProbe(cache, "/dev/dri", 0, TTL, run),
      cachedProbe(cache, "/dev/dri", 0, TTL, run),
    ]);
    assert.equal(runs, 1);
    assert.deepEqual(a, b);
  });

  it("re-runs once the TTL has passed", async () => {
    const cache = new Map<string, ProbeCacheEntry>();
    let runs = 0;
    const run = () => {
      runs++;
      return Promise.resolve(FOUND);
    };
    await cachedProbe(cache, "/dev/dri", 0, TTL, run);
    await cachedProbe(cache, "/dev/dri", TTL + 1, TTL, run);
    assert.equal(runs, 2);
  });

  // null is "could not tell". Holding it for the whole TTL would suppress
  // retries after one inconclusive probe.
  it("does not cache an inconclusive result", async () => {
    const cache = new Map<string, ProbeCacheEntry>();
    let runs = 0;
    const run = () => {
      runs++;
      return Promise.resolve(null);
    };
    await cachedProbe(cache, "/dev/dri", 0, TTL, run);
    await cachedProbe(cache, "/dev/dri", 1, TTL, run);
    assert.equal(runs, 2);
  });

  it("does not cache a failure", async () => {
    const cache = new Map<string, ProbeCacheEntry>();
    let runs = 0;
    const run = () => {
      runs++;
      return Promise.reject(new Error("boom"));
    };
    await assert.rejects(() => cachedProbe(cache, "/dev/dri", 0, TTL, run));
    await assert.rejects(() => cachedProbe(cache, "/dev/dri", 1, TTL, run));
    assert.equal(runs, 2);
  });

  it("keeps entries for different paths apart", async () => {
    const cache = new Map<string, ProbeCacheEntry>();
    const seen: string[] = [];
    const run = (p: string) => () => {
      seen.push(p);
      return Promise.resolve(FOUND);
    };
    await cachedProbe(cache, "/dev/dri", 0, TTL, run("/dev/dri"));
    await cachedProbe(cache, "/dev/snd", 0, TTL, run("/dev/snd"));
    assert.deepEqual(seen, ["/dev/dri", "/dev/snd"]);
  });

  it("prunes expired entries rather than growing forever", async () => {
    const cache = new Map<string, ProbeCacheEntry>();
    await cachedProbe(cache, "/dev/dri", 0, TTL, () => Promise.resolve(FOUND));
    await cachedProbe(cache, "/dev/snd", TTL + 1, TTL, () =>
      Promise.resolve(FOUND),
    );
    assert.equal(cache.has("/dev/dri"), false, "expired entry pruned");
    assert.equal(cache.has("/dev/snd"), true);
  });
});
