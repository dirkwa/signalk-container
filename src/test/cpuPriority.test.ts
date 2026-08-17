import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CPU_PRIORITIES,
  CPU_PRIORITY_SHARES,
  DEFAULT_CONTAINER_CPU_PRIORITY,
  DEFAULT_JOB_CPU_PRIORITY,
  cpuPriorityForShares,
  cpuPriorityLimits,
  normalizeCpuPriority,
} from "../configNormalize.js";
import { mergeResourceLimits } from "../resources.js";

describe("CPU_PRIORITY_SHARES", () => {
  it("orders the tiers strictly by shares, normal being unset", () => {
    // Both runtime formulas (crun/runc<1.3.2 linear, runc>=1.3.2
    // quadratic) are monotonic in shares, so shares order = weight order.
    const shares = CPU_PRIORITIES.map((t) => CPU_PRIORITY_SHARES[t]);
    assert.deepEqual(shares, [5120, null, 512, 128]);
    assert.ok(
      shares[0]! > 1024 && shares[2]! < 1024 && shares[3]! < shares[2]!,
    );
  });

  it("makes normal the absence of a request", () => {
    assert.equal(CPU_PRIORITY_SHARES.normal, null);
    assert.deepEqual(cpuPriorityLimits("normal"), {});
  });

  it("expresses every other tier as cpuShares", () => {
    assert.deepEqual(cpuPriorityLimits("high"), { cpuShares: 5120 });
    assert.deepEqual(cpuPriorityLimits("low"), { cpuShares: 512 });
    assert.deepEqual(cpuPriorityLimits("lowest"), { cpuShares: 128 });
  });

  it("defaults containers to normal and jobs to lowest", () => {
    assert.equal(DEFAULT_CONTAINER_CPU_PRIORITY, "normal");
    assert.equal(DEFAULT_JOB_CPU_PRIORITY, "lowest");
  });
});

describe("cpuPriorityForShares", () => {
  it("reads unset as normal", () => {
    assert.equal(cpuPriorityForShares(undefined), "normal");
    assert.equal(cpuPriorityForShares(null), "normal");
  });

  it("recognises each tier's shares value", () => {
    for (const tier of CPU_PRIORITIES) {
      const shares = CPU_PRIORITY_SHARES[tier];
      if (shares !== null) assert.equal(cpuPriorityForShares(shares), tier);
    }
  });

  it("returns null for a value that is not a tier", () => {
    assert.equal(cpuPriorityForShares(1024), null);
  });
});

describe("normalizeCpuPriority", () => {
  it("passes through a known tier", () => {
    assert.equal(normalizeCpuPriority("low", "normal"), "low");
  });

  it("falls back for unknown, wrong-typed, or missing values", () => {
    assert.equal(normalizeCpuPriority("medium", "normal"), "normal");
    assert.equal(normalizeCpuPriority(512, "lowest"), "lowest");
    assert.equal(normalizeCpuPriority(undefined, "lowest"), "lowest");
    assert.equal(normalizeCpuPriority(null, "high"), "high");
  });
});

describe("tier precedence through mergeResourceLimits", () => {
  // The plugin default is `tier ⊕ consumer resources`; the user override
  // merges on top of that. Both entry points (ensureRunning, runJob) use
  // this exact composition.
  it("lets a consumer's own cpuShares beat the tier", () => {
    const merged = mergeResourceLimits(cpuPriorityLimits("low"), {
      cpuShares: 256,
      memory: "512m",
    });
    assert.deepEqual(merged, { cpuShares: 256, memory: "512m" });
  });

  it("keeps the tier when the consumer sets other limits only", () => {
    const merged = mergeResourceLimits(cpuPriorityLimits("low"), {
      memory: "512m",
    });
    assert.deepEqual(merged, { cpuShares: 512, memory: "512m" });
  });

  it("lets a consumer opt out of the tier with null", () => {
    const merged = mergeResourceLimits(cpuPriorityLimits("lowest"), {
      cpuShares: null,
    });
    assert.deepEqual(merged, {});
  });

  it("lets a user override beat both tier and consumer", () => {
    const pluginDefault = mergeResourceLimits(cpuPriorityLimits("low"), {
      cpuShares: 256,
    });
    assert.deepEqual(mergeResourceLimits(pluginDefault, { cpuShares: 5120 }), {
      cpuShares: 5120,
    });
    assert.deepEqual(
      mergeResourceLimits(pluginDefault, { cpuShares: null }),
      {},
    );
  });
});
