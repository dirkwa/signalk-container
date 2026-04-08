import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fieldsRequiringRecreateForUnset,
  filterUnsupportedLimits,
  mergeResourceLimits,
  minimizeOverride,
  resourceFlagsForRun,
  resourceFlagsForUpdate,
  resourceLimitsEqual,
  tryLiveUpdate,
  type ExecRuntimeFn,
} from "../resources";
import type { ContainerRuntimeInfo } from "../types";

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

function fakeExec(
  result: { exitCode: number; stdout?: string; stderr?: string },
  capturedArgs?: { args: string[] },
): ExecRuntimeFn {
  return async (_runtime, args) => {
    if (capturedArgs) capturedArgs.args = args;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

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

describe("resourceFlagsForRun", () => {
  it("returns empty for undefined limits", () => {
    assert.deepEqual(resourceFlagsForRun(undefined, dummyRuntime), []);
  });

  it("returns empty for empty limits object", () => {
    assert.deepEqual(resourceFlagsForRun({}, dummyRuntime), []);
  });

  it("translates cpus", () => {
    assert.deepEqual(resourceFlagsForRun({ cpus: 1.5 }, dummyRuntime), [
      "--cpus",
      "1.5",
    ]);
  });

  it("translates memory", () => {
    assert.deepEqual(resourceFlagsForRun({ memory: "512m" }, dummyRuntime), [
      "--memory",
      "512m",
    ]);
  });

  it("translates all fields together", () => {
    const flags = resourceFlagsForRun(
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
    assert.deepEqual(flags, [
      "--cpus",
      "1.5",
      "--cpu-shares",
      "512",
      "--cpuset-cpus",
      "1,2",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--memory-reservation",
      "256m",
      "--pids-limit",
      "200",
      "--oom-score-adj",
      "500",
    ]);
  });

  it("skips null fields (treated like unset)", () => {
    assert.deepEqual(
      resourceFlagsForRun({ cpus: 1.25, memory: null }, dummyRuntime),
      ["--cpus", "1.25"],
    );
  });

  it("skips undefined fields", () => {
    assert.deepEqual(
      resourceFlagsForRun({ cpus: 1.25, memory: undefined }, dummyRuntime),
      ["--cpus", "1.25"],
    );
  });

  it("drops cpusetCpus when cpuset controller is unavailable", () => {
    // Bug B regression test: on a host without cpuset delegation
    // (like rootless podman on most systems), `cpusetCpus` must be
    // silently dropped from the flag list rather than passed to
    // podman where it would fail at OCI runtime time.
    const flags = resourceFlagsForRun(
      { cpus: 1.5, cpusetCpus: "1,2", memory: "512m" },
      restrictedRuntime,
    );
    assert.deepEqual(flags, ["--cpus", "1.5", "--memory", "512m"]);
  });

  it("keeps fields whose controller IS available", () => {
    const flags = resourceFlagsForRun(
      { cpus: 1.5, memory: "512m", pidsLimit: 200 },
      restrictedRuntime,
    );
    assert.deepEqual(flags, [
      "--cpus",
      "1.5",
      "--memory",
      "512m",
      "--pids-limit",
      "200",
    ]);
  });

  it("oomScoreAdj is always allowed (not gated by cgroup controllers)", () => {
    const flags = resourceFlagsForRun({ oomScoreAdj: 500 }, restrictedRuntime);
    assert.deepEqual(flags, ["--oom-score-adj", "500"]);
  });
});

describe("resourceFlagsForUpdate", () => {
  it("returns flags for live-updatable fields", () => {
    const flags = resourceFlagsForUpdate({
      cpus: 2.5,
      memory: "1g",
      pidsLimit: 300,
    });
    assert.deepEqual(flags, [
      "--cpus",
      "2.5",
      "--memory",
      "1g",
      "--pids-limit",
      "300",
    ]);
  });

  it("returns null when limits include cpusetCpus (not live-updatable)", () => {
    assert.equal(
      resourceFlagsForUpdate({ cpus: 2.5, cpusetCpus: "0,1" }),
      null,
    );
  });

  it("returns null when limits include oomScoreAdj (set at create time only)", () => {
    assert.equal(
      resourceFlagsForUpdate({ memory: "1g", oomScoreAdj: 100 }),
      null,
    );
  });

  it("ignores null fields when checking live-updatability", () => {
    // cpusetCpus: null means "explicit unset" — NOT a live update obstacle
    const flags = resourceFlagsForUpdate({ cpus: 2.5, cpusetCpus: null });
    assert.deepEqual(flags, ["--cpus", "2.5"]);
  });

  it("returns empty array for empty limits (vacuously live-updatable)", () => {
    assert.deepEqual(resourceFlagsForUpdate({}), []);
  });

  it("includes only the live-updatable subset of all fields", () => {
    const flags = resourceFlagsForUpdate({
      cpus: 1.5,
      cpuShares: 1024,
      memory: "512m",
      memorySwap: "512m",
      memoryReservation: "256m",
      pidsLimit: 100,
    });
    assert.deepEqual(flags, [
      "--cpus",
      "1.5",
      "--cpu-shares",
      "1024",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--memory-reservation",
      "256m",
      "--pids-limit",
      "100",
    ]);
  });
});

describe("tryLiveUpdate", () => {
  it("returns ok=true when exec succeeds", async () => {
    const captured = { args: [] as string[] };
    const exec = fakeExec({ exitCode: 0 }, captured);
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-mayara-server",
      { cpus: 1.5 },
      exec,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(captured.args, [
      "update",
      "--cpus",
      "1.5",
      "sk-mayara-server",
    ]);
  });

  it("returns ok=false with stderr when exec fails", async () => {
    const exec = fakeExec({ exitCode: 1, stderr: "no such container" });
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-nope",
      { cpus: 1.5 },
      exec,
    );
    assert.equal(result.ok, false);
    assert.equal(result.stderr, "no such container");
  });

  it("falls back to stdout when stderr is empty", async () => {
    const exec = fakeExec({ exitCode: 1, stdout: "boom on stdout" });
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-mayara",
      { memory: "1g" },
      exec,
    );
    assert.equal(result.ok, false);
    assert.equal(result.stderr, "boom on stdout");
  });

  it("returns ok=false WITHOUT calling exec when limits include cpusetCpus", async () => {
    let called = false;
    const exec: ExecRuntimeFn = async () => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-mayara",
      { cpus: 1.5, cpusetCpus: "0,1" },
      exec,
    );
    assert.equal(result.ok, false);
    assert.match(result.stderr ?? "", /non-live-updatable/);
    assert.equal(called, false, "exec must not be called for non-live limits");
  });

  it("for empty limits, calls exec with `inspect` to verify container exists (Bug C fix)", async () => {
    // Old behavior was to return ok=true vacuously without any exec
    // call, which meant `updateResources({})` against a removed
    // container claimed success and corrupted the internal cache.
    // The new behavior is: call `inspect` first; only return ok=true
    // if the container actually exists.
    const captured = { args: [] as string[] };
    const exec: ExecRuntimeFn = async (_runtime, args) => {
      captured.args = args;
      return { exitCode: 0, stdout: "[{}]", stderr: "" };
    };
    const result = await tryLiveUpdate(dummyRuntime, "sk-x", {}, exec);
    assert.equal(result.ok, true);
    assert.deepEqual(captured.args, ["inspect", "sk-x"]);
  });

  it("for empty limits AND missing container, returns ok=false", async () => {
    const exec: ExecRuntimeFn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "no such object: sk-x",
    });
    const result = await tryLiveUpdate(dummyRuntime, "sk-x", {}, exec);
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
    // After filtering, no flags need to be applied. The old code
    // would vacuously return ok=true here, even if the container
    // doesn't exist. The new code MUST verify existence first.
    const exec = fakeExec({ exitCode: 1, stderr: "no such object" });
    const result = await tryLiveUpdate(
      restrictedRuntime,
      "sk-mayara",
      // Only field is cpusetCpus, which gets filtered out → empty
      { cpusetCpus: "0,1" },
      exec,
    );
    assert.equal(result.ok, false);
    assert.match(result.stderr ?? "", /does not exist/);
  });

  it("with empty filtered limits AND existing container, returns ok=true", async () => {
    const exec = fakeExec({ exitCode: 0, stdout: "[{}]" });
    const result = await tryLiveUpdate(
      restrictedRuntime,
      "sk-mayara",
      { cpusetCpus: "0,1" },
      exec,
    );
    assert.equal(result.ok, true);
  });

  it("with normal limits, no existence check is performed (delegated to update command)", async () => {
    const exec = fakeExec({ exitCode: 0 });
    const result = await tryLiveUpdate(
      dummyRuntime,
      "sk-mayara",
      { cpus: 1.5 },
      exec,
    );
    assert.equal(result.ok, true);
  });

  it("filters cgroup-unavailable fields BEFORE deciding live-update viability", async () => {
    // Pure regression test for the integration: cpusetCpus + cpus, on
    // a runtime with no cpuset → cpusetCpus is dropped → only cpus
    // remains → live-updatable → exec gets called with --cpus only.
    const captured = { args: [] as string[] };
    const exec = fakeExec({ exitCode: 0 }, captured);
    const result = await tryLiveUpdate(
      restrictedRuntime,
      "sk-mayara",
      { cpus: 1.5, cpusetCpus: "0,1" },
      exec,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(captured.args, ["update", "--cpus", "1.5", "sk-mayara"]);
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

  it("real-world scenario: removing oomScoreAdj while keeping cpus/memory", () => {
    // This is the exact case that surfaced Bug E in the smoke test:
    // mayara had oomScoreAdj: 500 from a prior update, user removes it.
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
