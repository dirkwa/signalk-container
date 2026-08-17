import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CPU_PRIORITIES,
  CPU_PRIORITY_SHARES,
  DEFAULT_CONTAINER_CPU_PRIORITY,
  DEFAULT_JOB_CPU_PRIORITY,
  cpuPriorityForShares,
  cpuPriorityLimits,
  cpuSharesToWeight,
  normalizeCpuPriority,
} from "../configNormalize.js";
import { mergeResourceLimits } from "../resources.js";

describe("cpuSharesToWeight", () => {
  // Values measured live on podman 5.4.2 / cgroup v2: 256 → 10,
  // 1024 → 39, 2048 → 79; unset → 100.
  it("maps unset to the kernel default weight 100", () => {
    assert.equal(cpuSharesToWeight(undefined), 100);
    assert.equal(cpuSharesToWeight(null), 100);
  });

  it("follows runc's shares→weight translation", () => {
    assert.equal(cpuSharesToWeight(256), 10);
    assert.equal(cpuSharesToWeight(1024), 39);
    assert.equal(cpuSharesToWeight(2048), 79);
  });

  it("clamps to the runtime's accepted shares range", () => {
    assert.equal(cpuSharesToWeight(1), 1);
    assert.equal(cpuSharesToWeight(2), 1);
    assert.equal(cpuSharesToWeight(10_000_000), 10000);
  });
});

describe("CPU_PRIORITY_SHARES", () => {
  it("orders the tiers strictly by resulting weight", () => {
    const weights = CPU_PRIORITIES.map((t) =>
      cpuSharesToWeight(CPU_PRIORITY_SHARES[t]),
    );
    for (let i = 1; i < weights.length; i++) {
      assert.ok(
        weights[i - 1] > weights[i],
        `${CPU_PRIORITIES[i - 1]} (${weights[i - 1]}) must outrank ${CPU_PRIORITIES[i]} (${weights[i]})`,
      );
    }
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
