import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fieldsRequiringRecreateForUnset,
  filterUnsupportedLimits,
  mergeResourceLimits,
  minimizeOverride,
  parseMemoryToBytes,
  resourcePayloadForRun,
  resourcePayloadForUpdate,
  resourceLimitsEqual,
  tryLiveUpdate,
} from "../resources.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

// "Default" runtime: no probed cgroup controllers, treats all
// fields as supported. Matches docker (where we don't probe) and
// podman versions older than the v016 probing logic.
const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.0.0",
  isPodmanDockerShim: false,
};

// Realistic rootless-podman runtime: cpu/memory/pids delegated, but
// NOT cpuset. This is the actual config on Dirk's dev VM and matches
// systemd's default delegate-controllers list.
const restrictedRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  cgroupControllers: ["cpu", "memory", "pids"],
};

describe("parseMemoryToBytes", () => {
  it("parses binary units (m/g/k) and bare byte counts", () => {
    assert.equal(parseMemoryToBytes("512m"), 536870912);
    assert.equal(parseMemoryToBytes("2g"), 2147483648);
    assert.equal(parseMemoryToBytes("1024k"), 1048576);
    assert.equal(parseMemoryToBytes("536870912"), 536870912);
    assert.equal(parseMemoryToBytes("536870912b"), 536870912);
  });

  it("throws on a malformed value instead of silently dropping the cap", () => {
    // A typo must fail loudly at the boundary — omitting the field would
    // remove the limit on create and let tryLiveUpdate report success
    // after applying nothing.
    assert.throws(() => parseMemoryToBytes("512mb"), /invalid memory value/);
    assert.throws(() => parseMemoryToBytes("abc"), /invalid memory value/);
    assert.throws(() => parseMemoryToBytes(""), /invalid memory value/);
  });

  it("rejects a malformed memory limit through resourcePayloadForRun", () => {
    assert.throws(
      () => resourcePayloadForRun({ memory: "512mb" }, dummyRuntime),
      /invalid memory value/,
    );
  });
});

describe("mergeResourceLimits", () => {
  it("returns empty object for two undefined inputs", () => {
    assert.deepEqual(mergeResourceLimits(undefined, undefined), {});
  });

  it("returns base unchanged when override is undefined", () => {
    assert.deepEqual(
      mergeResourceLimits({ cpus: 1.5, memory: "512m" }, undefined),
      { cpus: 1.5, memory: "512m" },
    );
  });

  it("override field replaces base field", () => {
    assert.deepEqual(
      mergeResourceLimits({ cpus: 1.5, memory: "512m" }, { cpus: 2.0 }),
      { cpus: 2.0, memory: "512m" },
    );
  });

  it("undefined in override inherits base (no replace)", () => {
    assert.deepEqual(
      mergeResourceLimits({ cpus: 1.5, memory: "512m" }, { cpus: undefined }),
      { cpus: 1.5, memory: "512m" },
    );
  });

  it("null in override removes base field (RFC 7396 semantics)", () => {
    assert.deepEqual(
      mergeResourceLimits({ cpus: 1.5, memory: "512m" }, { memory: null }),
      { cpus: 1.5 },
    );
  });

  it("override can both add and remove fields in one call", () => {
    assert.deepEqual(
      mergeResourceLimits(
        { cpus: 1.5, memory: "512m" },
        { memory: null, pidsLimit: 100 },
      ),
      { cpus: 1.5, pidsLimit: 100 },
    );
  });

  it("strips null/undefined from final result", () => {
    assert.deepEqual(
      mergeResourceLimits({ cpus: undefined as any }, { memory: null }),
      {},
    );
  });

  it("override-only with empty base", () => {
    assert.deepEqual(
      mergeResourceLimits(undefined, { cpus: 2.0, memory: "1g" }),
      { cpus: 2.0, memory: "1g" },
    );
  });

  it("does not mutate the base argument", () => {
    const base = { cpus: 1.0, memory: "256m" };
    mergeResourceLimits(base, { cpus: 5.0, memory: null });
    assert.deepEqual(base, { cpus: 1.0, memory: "256m" });
  });
});

describe("resourcePayloadForRun", () => {
  it("returns empty for undefined limits", () => {
    assert.deepEqual(resourcePayloadForRun(undefined, dummyRuntime), {});
  });

  it("returns empty for empty limits object", () => {
    assert.deepEqual(resourcePayloadForRun({}, dummyRuntime), {});
  });

  it("translates cpus to NanoCpus", () => {
    assert.deepEqual(resourcePayloadForRun({ cpus: 1.5 }, dummyRuntime), {
      NanoCpus: 1500000000,
    });
  });

  it("translates memory string to bytes", () => {
    assert.deepEqual(resourcePayloadForRun({ memory: "512m" }, dummyRuntime), {
      Memory: 536870912,
    });
  });

  it("translates all fields together", () => {
    const payload = resourcePayloadForRun(
      {
        cpus: 1.5,
        cpuShares: 512,
        cpusetCpus: "1,2",
        memory: "512m",
        memorySwap: "512m",
        memoryReservation: "256m",
        pidsLimit: 200,
        oomScoreAdj: 500,
      },
      dummyRuntime,
    );
    assert.deepEqual(payload, {
      NanoCpus: 1500000000,
      CpuShares: 512,
      CpusetCpus: "1,2",
      Memory: 536870912,
      MemorySwap: 536870912,
      MemoryReservation: 268435456,
      PidsLimit: 200,
      OomScoreAdj: 500,
    });
  });

  it("skips null fields (treated like unset)", () => {
    assert.deepEqual(
      resourcePayloadForRun({ cpus: 1.25, memory: null }, dummyRuntime),
      { NanoCpus: 1250000000 },
    );
  });

  it("skips undefined fields", () => {
    assert.deepEqual(
      resourcePayloadForRun({ cpus: 1.25, memory: undefined }, dummyRuntime),
      { NanoCpus: 1250000000 },
    );
  });

  it("drops cpusetCpus when cpuset controller is unavailable", () => {
    // Bug B regression test: on a host without cpuset delegation
    // (like rootless podman on most systems), `CpusetCpus` must be
    // silently dropped from the payload rather than passed to the
    // runtime where it would fail at OCI runtime time.
    const payload = resourcePayloadForRun(
      { cpus: 1.5, cpusetCpus: "1,2", memory: "512m" },
      restrictedRuntime,
    );
    assert.deepEqual(payload, { NanoCpus: 1500000000, Memory: 536870912 });
  });

  it("keeps fields whose controller IS available", () => {
    const payload = resourcePayloadForRun(
      { cpus: 1.5, memory: "512m", pidsLimit: 200 },
      restrictedRuntime,
    );
    assert.deepEqual(payload, {
      NanoCpus: 1500000000,
      Memory: 536870912,
      PidsLimit: 200,
    });
  });

  it("oomScoreAdj is always allowed (not gated by cgroup controllers)", () => {
    const payload = resourcePayloadForRun(
      { oomScoreAdj: 500 },
      restrictedRuntime,
    );
    assert.deepEqual(payload, { OomScoreAdj: 500 });
  });
});

describe("resourcePayloadForUpdate", () => {
  it("returns payload for live-updatable fields (cpus as CpuQuota/Period)", () => {
    // The update path expresses the CPU cap as CFS quota/period, NOT
    // NanoCpus — podman's compat /update silently ignores NanoCpus.
    const payload = resourcePayloadForUpdate({
      cpus: 2.5,
      memory: "1g",
      pidsLimit: 300,
    });
    assert.deepEqual(payload, {
      CpuQuota: 250000,
      CpuPeriod: 100000,
      Memory: 1073741824,
      PidsLimit: 300,
    });
  });

  it("returns null when limits include cpusetCpus (not live-updatable)", () => {
    assert.equal(
      resourcePayloadForUpdate({ cpus: 2.5, cpusetCpus: "0,1" }),
      null,
    );
  });

  it("returns null when limits include oomScoreAdj (set at create time only)", () => {
    assert.equal(
      resourcePayloadForUpdate({ memory: "1g", oomScoreAdj: 100 }),
      null,
    );
  });

  it("ignores null fields when checking live-updatability", () => {
    // cpusetCpus: null means "explicit unset" — NOT a live update obstacle
    const payload = resourcePayloadForUpdate({ cpus: 2.5, cpusetCpus: null });
    assert.deepEqual(payload, { CpuQuota: 250000, CpuPeriod: 100000 });
  });

  it("returns empty object for empty limits (vacuously live-updatable)", () => {
    assert.deepEqual(resourcePayloadForUpdate({}), {});
  });

  it("includes only the live-updatable subset of all fields", () => {
    const payload = resourcePayloadForUpdate({
      cpus: 1.5,
      cpuShares: 1024,
      memory: "512m",
      memorySwap: "512m",
      memoryReservation: "256m",
      pidsLimit: 100,
    });
    assert.deepEqual(payload, {
      CpuQuota: 150000,
      CpuPeriod: 100000,
      CpuShares: 1024,
      Memory: 536870912,
      MemorySwap: 536870912,
      MemoryReservation: 268435456,
      PidsLimit: 100,
    });
  });
});

describe("tryLiveUpdate", () => {
  it("returns ok=true and applies the update payload when update succeeds", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-mayara-server": { update: () => Promise.resolve() },
      },
      calls,
    });
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-mayara-server",
      { cpus: 1.5 },
      client,
    );
    assert.equal(result.ok, true);
    const update = calls.get("update") as Array<{ payload: unknown }>;
    assert.equal(update.length, 1);
    // cpus is sent as CFS quota/period on update (podman compat ignores NanoCpus).
    assert.deepEqual(update[0].payload, {
      CpuQuota: 150000,
      CpuPeriod: 100000,
    });
  });

  it("returns ok=false when update rejects", async () => {
    const client = makeMockClient({
      containers: {
        "sk-nope": {
          update: () =>
            Promise.reject(
              Object.assign(new Error("no such container"), {
                statusCode: 500,
              }),
            ),
        },
      },
    });
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-nope",
      { cpus: 1.5 },
      client,
    );
    assert.equal(result.ok, false);
  });

  it("returns ok=false WITHOUT calling update when limits include cpusetCpus", async () => {
    const calls = new Map<string, unknown[]>();
    // No update behaviour: payload is null, so update must never be reached.
    const client = makeMockClient({
      containers: { "sk-mayara": {} },
      calls,
    });
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-mayara",
      { cpus: 1.5, cpusetCpus: "0,1" },
      client,
    );
    assert.equal(result.ok, false);
    assert.match(result.stderr ?? "", /non-live-updatable/);
    assert.equal(
      calls.get("update"),
      undefined,
      "update must not be called for non-live limits",
    );
  });

  it("for empty limits, inspects to verify container exists (Bug C fix)", async () => {
    // Old behavior was to return ok=true vacuously without any runtime
    // call, which meant `updateResources({})` against a removed
    // container claimed success and corrupted the internal cache.
    // The new behavior is: inspect first; only return ok=true if the
    // container actually exists.
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: { "sk-x": { inspect: {} } },
      calls,
    });
    const result = await tryLiveUpdate(dummyRuntime, "sk-x", {}, client);
    assert.equal(result.ok, true);
    assert.equal(
      calls.get("update"),
      undefined,
      "update must not be called when there is nothing to apply",
    );
  });

  it("for empty limits AND missing container, returns ok=false", async () => {
    // Container not listed → inspect throws 404 → existence check fails.
    const client = makeMockClient({});
    const result = await tryLiveUpdate(dummyRuntime, "sk-x", {}, client);
    assert.equal(result.ok, false);
    assert.match(result.stderr ?? "", /does not exist/);
  });
});

describe("resourceLimitsEqual", () => {
  it("two undefined are equal", () => {
    assert.equal(resourceLimitsEqual(undefined, undefined), true);
  });

  it("undefined and {} are equal", () => {
    assert.equal(resourceLimitsEqual(undefined, {}), true);
  });

  it("identical objects are equal", () => {
    assert.equal(
      resourceLimitsEqual(
        { cpus: 1.5, memory: "512m" },
        { cpus: 1.5, memory: "512m" },
      ),
      true,
    );
  });

  it("different values are not equal", () => {
    assert.equal(
      resourceLimitsEqual(
        { cpus: 1.5, memory: "512m" },
        { cpus: 2.0, memory: "512m" },
      ),
      false,
    );
  });

  it("different keys are not equal", () => {
    assert.equal(
      resourceLimitsEqual({ cpus: 1.5 }, { cpus: 1.5, memory: "512m" }),
      false,
    );
  });

  it("nulls are treated as missing for equality", () => {
    assert.equal(
      resourceLimitsEqual({ cpus: 1.5, memory: null }, { cpus: 1.5 }),
      true,
    );
  });
});

describe("filterUnsupportedLimits (Bug B)", () => {
  it("accepts everything when cgroupControllers is undefined (not probed)", () => {
    const { accepted, dropped } = filterUnsupportedLimits(
      { cpus: 1.5, cpusetCpus: "0,1", memory: "512m", oomScoreAdj: 100 },
      dummyRuntime,
    );
    assert.deepEqual(accepted, {
      cpus: 1.5,
      cpusetCpus: "0,1",
      memory: "512m",
      oomScoreAdj: 100,
    });
    assert.deepEqual(dropped, []);
  });

  it("accepts everything when cgroupControllers is null", () => {
    const runtime: ContainerRuntimeInfo = {
      ...dummyRuntime,
      cgroupControllers: null,
    };
    const { accepted, dropped } = filterUnsupportedLimits(
      { cpusetCpus: "0,1" },
      runtime,
    );
    assert.deepEqual(accepted, { cpusetCpus: "0,1" });
    assert.deepEqual(dropped, []);
  });

  it("drops cpusetCpus when cpuset controller is missing", () => {
    const { accepted, dropped } = filterUnsupportedLimits(
      { cpus: 1.5, cpusetCpus: "0,1", memory: "512m" },
      restrictedRuntime,
    );
    assert.deepEqual(accepted, { cpus: 1.5, memory: "512m" });
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].field, "cpusetCpus");
    assert.match(dropped[0].reason, /cpuset/);
    assert.match(dropped[0].reason, /podman/);
  });

  it("oomScoreAdj is always allowed (no cgroup controller dependency)", () => {
    const { accepted, dropped } = filterUnsupportedLimits(
      { oomScoreAdj: 500 },
      restrictedRuntime,
    );
    assert.deepEqual(accepted, { oomScoreAdj: 500 });
    assert.deepEqual(dropped, []);
  });

  it("preserves null and undefined fields verbatim (merge layer handles them)", () => {
    const { accepted } = filterUnsupportedLimits(
      { cpus: 1.0, memory: null, cpusetCpus: undefined },
      restrictedRuntime,
    );
    assert.equal(accepted.cpus, 1.0);
    assert.equal(accepted.memory, null);
    assert.ok(!("cpusetCpus" in accepted) || accepted.cpusetCpus === undefined);
  });

  it("drops multiple fields and reports each separately", () => {
    const stripped: ContainerRuntimeInfo = {
      ...dummyRuntime,
      // Only memory available — wildly restricted setup
      cgroupControllers: ["memory"],
    };
    const { accepted, dropped } = filterUnsupportedLimits(
      {
        cpus: 1.5,
        cpuShares: 512,
        cpusetCpus: "0",
        memory: "512m",
        pidsLimit: 100,
      },
      stripped,
    );
    assert.deepEqual(accepted, { memory: "512m" });
    assert.equal(dropped.length, 4);
    const droppedFields = new Set(dropped.map((d) => d.field));
    assert.ok(droppedFields.has("cpus"));
    assert.ok(droppedFields.has("cpuShares"));
    assert.ok(droppedFields.has("cpusetCpus"));
    assert.ok(droppedFields.has("pidsLimit"));
  });

  it("does not mutate the input limits", () => {
    const input = { cpus: 1.5, cpusetCpus: "0,1" };
    filterUnsupportedLimits(input, restrictedRuntime);
    assert.deepEqual(input, { cpus: 1.5, cpusetCpus: "0,1" });
  });
});

describe("tryLiveUpdate Bug C: container existence check", () => {
  it("with empty filtered limits AND missing container, returns ok=false", async () => {
    // After filtering, no payload needs to be applied. The old code
    // would vacuously return ok=true here, even if the container
    // doesn't exist. The new code MUST verify existence first.
    const client = makeMockClient({});
    const result = await tryLiveUpdate(
      restrictedRuntime,
      "sk-mayara",
      // Only field is cpusetCpus, which gets filtered out → empty
      { cpusetCpus: "0,1" },
      client,
    );
    assert.equal(result.ok, false);
    assert.match(result.stderr ?? "", /does not exist/);
  });

  it("with empty filtered limits AND existing container, returns ok=true", async () => {
    const client = makeMockClient({
      containers: { "sk-mayara": { inspect: {} } },
    });
    const result = await tryLiveUpdate(
      restrictedRuntime,
      "sk-mayara",
      { cpusetCpus: "0,1" },
      client,
    );
    assert.equal(result.ok, true);
  });

  it("with normal limits, no existence check is performed (delegated to update)", async () => {
    // No `inspect` behaviour configured — if existence were checked it
    // would 404. update succeeds, so ok=true.
    const client = makeMockClient({
      containers: { "sk-mayara": { update: () => Promise.resolve() } },
    });
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-mayara",
      { cpus: 1.5 },
      client,
    );
    assert.equal(result.ok, true);
  });

  it("filters cgroup-unavailable fields BEFORE deciding live-update viability", async () => {
    // Pure regression test for the integration: cpusetCpus + cpus, on
    // a runtime with no cpuset → cpusetCpus is dropped → only cpus
    // remains → live-updatable → update gets the CPU quota/period payload only.
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: { "sk-mayara": { update: () => Promise.resolve() } },
      calls,
    });
    const result = await tryLiveUpdate(
      restrictedRuntime,
      "sk-mayara",
      { cpus: 1.5, cpusetCpus: "0,1" },
      client,
    );
    assert.equal(result.ok, true);
    const update = calls.get("update") as Array<{ payload: unknown }>;
    assert.equal(update.length, 1);
    // cpus is sent as CFS quota/period on update (podman compat ignores NanoCpus).
    assert.deepEqual(update[0].payload, {
      CpuQuota: 150000,
      CpuPeriod: 100000,
    });
  });
});

describe("fieldsRequiringRecreateForUnset (Bug E)", () => {
  it("returns empty when current and target both have memory set", () => {
    const result = fieldsRequiringRecreateForUnset(
      { memory: "512m" },
      { memory: "1g" },
    );
    assert.deepEqual(result, []);
  });

  it("returns empty when neither has memory set", () => {
    const result = fieldsRequiringRecreateForUnset(
      { cpus: 1.0 },
      { cpus: 2.0 },
    );
    assert.deepEqual(result, []);
  });

  it("returns ['memory'] when current has memory set and target drops it", () => {
    const result = fieldsRequiringRecreateForUnset({ memory: "512m" }, {});
    assert.deepEqual(result, ["memory"]);
  });

  it("treats null in target as unset", () => {
    const result = fieldsRequiringRecreateForUnset(
      { memory: "512m" },
      { memory: null },
    );
    assert.deepEqual(result, ["memory"]);
  });

  it("treats undefined in target as unset", () => {
    const result = fieldsRequiringRecreateForUnset(
      { memory: "512m", cpus: 1.0 },
      { memory: undefined, cpus: 2.0 },
    );
    assert.deepEqual(result, ["memory"]);
  });

  it("returns ['oomScoreAdj'] when oom-score-adj is being unset", () => {
    const result = fieldsRequiringRecreateForUnset({ oomScoreAdj: 500 }, {});
    assert.deepEqual(result, ["oomScoreAdj"]);
  });

  it("returns multiple fields when several are being unset", () => {
    const result = fieldsRequiringRecreateForUnset(
      {
        memory: "512m",
        memorySwap: "512m",
        memoryReservation: "256m",
        oomScoreAdj: 500,
        cpus: 1.5,
      },
      { cpus: 2.0 },
    );
    // All four memory/oom fields are being unset
    assert.equal(result.length, 4);
    assert.ok(result.includes("memory"));
    assert.ok(result.includes("memorySwap"));
    assert.ok(result.includes("memoryReservation"));
    assert.ok(result.includes("oomScoreAdj"));
  });

  it("does NOT include cpus or pidsLimit (they CAN be live-unset)", () => {
    const result = fieldsRequiringRecreateForUnset(
      { cpus: 1.5, pidsLimit: 200, memory: "512m" },
      { memory: "512m" }, // unsetting cpus and pidsLimit
    );
    // Only memory is in the cannot-unset set, and it's still set in target
    assert.deepEqual(result, []);
  });

  it("does NOT include cpusetCpus (CAN be live-unset)", () => {
    const result = fieldsRequiringRecreateForUnset({ cpusetCpus: "0,1" }, {});
    assert.deepEqual(result, []);
  });

  it("backward-compat (2-arg, no provenance): removing oomScoreAdj while keeping cpus/memory", () => {
    // The 2-arg form keeps the original current-vs-target behaviour. Real
    // call sites now pass a 3rd `priorRequested` arg; the provenance-aware
    // equivalent of this scenario is covered below.
    const result = fieldsRequiringRecreateForUnset(
      { cpus: 1.5, memory: "512m", memorySwap: "512m", oomScoreAdj: 500 },
      { cpus: 1.5, memory: "512m", memorySwap: "512m" },
    );
    assert.deepEqual(result, ["oomScoreAdj"]);
  });

  it("does not mutate either input", () => {
    const current = { memory: "512m", oomScoreAdj: 500 };
    const target = { cpus: 1.0 };
    fieldsRequiringRecreateForUnset(current, target);
    assert.deepEqual(current, { memory: "512m", oomScoreAdj: 500 });
    assert.deepEqual(target, { cpus: 1.0 });
  });

  describe("priorRequested provenance guard", () => {
    it("ignores a runtime-injected oomScoreAdj the consumer never requested", () => {
      // The reported bug: rootless Podman clamps a managed container's
      // oom_score_adj up to signalk-server's, so getLiveResources reports
      // oomScoreAdj though no plugin ever set it. priorRequested ({}) has
      // no oomScoreAdj → not a real unset → no warning/recreate.
      const result = fieldsRequiringRecreateForUnset(
        { cpus: 1.5, oomScoreAdj: 200 },
        { cpus: 1.5 },
        {},
      );
      assert.deepEqual(result, []);
    });

    it("still flags oomScoreAdj the consumer actually requested then dropped", () => {
      // User set oomScoreAdj via the UI (prior override), now clears it.
      const result = fieldsRequiringRecreateForUnset(
        { cpus: 1.5, oomScoreAdj: 500 },
        { cpus: 1.5 },
        { cpus: 1.5, oomScoreAdj: 500 },
      );
      assert.deepEqual(result, ["oomScoreAdj"]);
    });

    it("still flags a genuinely-requested memory unset", () => {
      const result = fieldsRequiringRecreateForUnset(
        { memory: "512m" },
        {},
        { memory: "512m" },
      );
      assert.deepEqual(result, ["memory"]);
    });

    it("ignores an injected oomScoreAdj even while a real memory unset is flagged", () => {
      const result = fieldsRequiringRecreateForUnset(
        { memory: "512m", oomScoreAdj: 200 },
        {},
        { memory: "512m" }, // memory requested before, oomScoreAdj never
      );
      assert.deepEqual(result, ["memory"]);
    });

    it("matches the no-provenance behaviour when priorRequested is omitted", () => {
      assert.deepEqual(
        fieldsRequiringRecreateForUnset({ oomScoreAdj: 200 }, {}),
        ["oomScoreAdj"],
      );
    });

    // The two scenarios reachable through the ensureRunning no-op call
    // site, where priorRequested is the PRIOR request (priorConfig.resources),
    // not the current target. They must not collapse into each other.
    it("ensureRunning path: suppresses inherited oomScoreAdj (never in prior request)", () => {
      // postLimits carries the rootless-Podman-inherited value; neither the
      // current nor the prior request ever asked for it.
      const result = fieldsRequiringRecreateForUnset(
        { cpus: 1.5, oomScoreAdj: 200 }, // postLimits
        { cpus: 1.5 }, // filteredMerged (current request)
        { cpus: 1.5 }, // priorConfig.resources (prior request)
      );
      assert.deepEqual(result, []);
    });

    it("ensureRunning path: still flags a memory cap removed via containerOverrides edit", () => {
      // User removed the memory cap by editing signalk-container's config;
      // the prior request had it, the live container still has it.
      const result = fieldsRequiringRecreateForUnset(
        { cpus: 1.5, memory: "1g" }, // postLimits (stale live cap)
        { cpus: 1.5 }, // filteredMerged (memory now gone)
        { cpus: 1.5, memory: "1g" }, // priorConfig.resources (had memory)
      );
      assert.deepEqual(result, ["memory"]);
    });

    it("ensureRunning first call (priorConfig undefined → {}): nothing flagged", () => {
      // priorConfig?.resources ?? {} on the very first ensureRunning. The
      // container was just created with the current request, so there is no
      // stale live limit to unset.
      const result = fieldsRequiringRecreateForUnset(
        { cpus: 1.5 },
        { cpus: 1.5 },
        {},
      );
      assert.deepEqual(result, []);
    });
  });
});

describe("minimizeOverride (Bug Z: snapshot-override noise)", () => {
  // Mayara's actual plugin default from src/index.ts DEFAULT_RESOURCES.
  const mayaraDefault = {
    cpus: 1.5,
    memory: "512m",
    memorySwap: "512m",
    pidsLimit: 200,
  };

  it("returns empty when limits exactly match plugin default", () => {
    // This is the user's exact bug: form was seeded from effective
    // state which equals the plugin default, they click Apply without
    // actually changing anything. Should NOT store an override.
    const result = minimizeOverride(mayaraDefault, mayaraDefault);
    assert.deepEqual(result, {});
  });

  it("returns only the differing field when user changes one value", () => {
    // User opens the editor, cpus field shows 1.5 (default), they
    // change it to 3, click Apply. Payload contains all 4 fields
    // (the other 3 unchanged because the form is seeded). Only cpus
    // should be stored.
    const result = minimizeOverride(
      { cpus: 3, memory: "512m", memorySwap: "512m", pidsLimit: 200 },
      mayaraDefault,
    );
    assert.deepEqual(result, { cpus: 3 });
  });

  it("keeps explicit null (unsetting a field the plugin set)", () => {
    // User clicks × on cpus to remove the limit entirely. The other
    // fields remain at plugin default. Should store {cpus: null}
    // (real intent: override mayara's cpus limit to "none").
    const result = minimizeOverride(
      { cpus: null, memory: "512m", memorySwap: "512m", pidsLimit: 200 },
      mayaraDefault,
    );
    assert.deepEqual(result, { cpus: null });
  });

  it("drops null for a field the plugin never set", () => {
    // User clicks × on oomScoreAdj (mayara default doesn't have it).
    // No-op — both are "unset", no override needed.
    const result = minimizeOverride(
      { oomScoreAdj: null },
      mayaraDefault, // has no oomScoreAdj
    );
    assert.deepEqual(result, {});
  });

  it("drops undefined fields", () => {
    const result = minimizeOverride(
      { cpus: 3, memory: undefined as unknown as string },
      mayaraDefault,
    );
    assert.deepEqual(result, { cpus: 3 });
  });

  it("keeps a value that differs from default even if other fields match", () => {
    const result = minimizeOverride(
      { cpus: 1.5, memory: "1g", memorySwap: "1g", pidsLimit: 200 },
      mayaraDefault,
    );
    // cpus matches (drop), memory differs (keep), memorySwap differs (keep), pidsLimit matches (drop)
    assert.deepEqual(result, { memory: "1g", memorySwap: "1g" });
  });

  it("handles empty plugin default (plugin sets no resources)", () => {
    // If the consumer plugin passes resources: undefined or {} to
    // ensureRunning, the plugin default map stores {}. Any user-set
    // fields are then all overrides, any user-null fields are dropped
    // (can't unset what was never set).
    const result = minimizeOverride(
      { cpus: 3, memory: null, memorySwap: null },
      {},
    );
    assert.deepEqual(result, { cpus: 3 });
  });

  it("empty limits against any default returns empty", () => {
    const result = minimizeOverride({}, mayaraDefault);
    assert.deepEqual(result, {});
  });

  it("does not mutate inputs", () => {
    const limits = { cpus: 3, memory: "512m" };
    const defaults = { cpus: 1.5, memory: "512m" };
    minimizeOverride(limits, defaults);
    assert.deepEqual(limits, { cpus: 3, memory: "512m" });
    assert.deepEqual(defaults, { cpus: 1.5, memory: "512m" });
  });

  it("cpuset string comparison is exact", () => {
    // '0,1' and '0-1' describe the same set but are not string-equal.
    // Minimize is conservative: different strings count as an override.
    assert.deepEqual(
      minimizeOverride({ cpusetCpus: "0-1" }, { cpusetCpus: "0,1" }),
      {
        cpusetCpus: "0-1",
      },
    );
    // Identical strings are dropped.
    assert.deepEqual(
      minimizeOverride({ cpusetCpus: "0,1" }, { cpusetCpus: "0,1" }),
      {},
    );
  });
});
