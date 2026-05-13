import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLiveResources } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

interface FakeResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

function fakeExec(result: FakeResult) {
  return async () => ({
    stdout: result.stdout,
    stderr: result.stderr ?? "",
    exitCode: result.exitCode,
  });
}

describe("getLiveResources (Bug A/D support)", () => {
  it("returns empty when container is missing", async () => {
    const exec = fakeExec({
      stdout: "",
      stderr: "no such object",
      exitCode: 1,
    });
    const result = await getLiveResources(dummyRuntime, "ghost", exec);
    assert.deepEqual(result, {});
  });

  it("parses NanoCpus into cpus (1.5 cores)", async () => {
    // 1.5 cores in NanoCpus = 1.5 * 1e9 = 1500000000
    const exec = fakeExec({
      stdout: "1500000000|0||0|0|0|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.equal(result.cpus, 1.5);
  });

  it("parses Memory bytes into memory string", async () => {
    // 512 MiB = 512 * 1024 * 1024 = 536870912
    const exec = fakeExec({
      stdout: "0|0||536870912|0|0|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.equal(result.memory, "512m");
  });

  it("parses MemorySwap and MemoryReservation", async () => {
    const exec = fakeExec({
      stdout: "0|0||536870912|536870912|268435456|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.equal(result.memory, "512m");
    assert.equal(result.memorySwap, "512m");
    assert.equal(result.memoryReservation, "256m");
  });

  it("parses cpusetCpus when set", async () => {
    const exec = fakeExec({
      stdout: "0|0|1,2|0|0|0|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.equal(result.cpusetCpus, "1,2");
  });

  it("does NOT emit cpusetCpus when empty string", async () => {
    const exec = fakeExec({
      stdout: "0|0||0|0|0|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.ok(!("cpusetCpus" in result));
  });

  it("treats cpuShares=1024 as default (not emitted)", async () => {
    // 1024 is the kernel default; emitting it would create false
    // diffs in ensureRunning's change detection.
    const exec = fakeExec({
      stdout: "0|1024||0|0|0|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.ok(!("cpuShares" in result));
  });

  it("emits cpuShares when explicitly set to non-default", async () => {
    const exec = fakeExec({
      stdout: "0|512||0|0|0|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.equal(result.cpuShares, 512);
  });

  it("treats pidsLimit=2048 as default (not emitted)", async () => {
    // 2048 is podman's default; same logic as cpuShares=1024.
    const exec = fakeExec({
      stdout: "0|0||0|0|0|2048|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.ok(!("pidsLimit" in result));
  });

  it("emits pidsLimit when explicitly set to non-default", async () => {
    const exec = fakeExec({
      stdout: "0|0||0|0|0|200|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.equal(result.pidsLimit, 200);
  });

  it("emits oomScoreAdj when non-zero", async () => {
    const exec = fakeExec({
      stdout: "0|0||0|0|0|0|500",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.equal(result.oomScoreAdj, 500);
  });

  it("does NOT emit oomScoreAdj when zero (kernel default)", async () => {
    const exec = fakeExec({
      stdout: "0|0||0|0|0|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.ok(!("oomScoreAdj" in result));
  });

  it("emits gigabyte memory in 'g' units (not bloated 'm')", async () => {
    // 2 GiB = 2 * 1024^3 = 2147483648
    const exec = fakeExec({
      stdout: "0|0||2147483648|0|0|0|0",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.equal(result.memory, "2g");
  });

  it("parses a fully-loaded container snapshot end-to-end", async () => {
    // 1.5 cores, 512 MiB mem + swap disabled, 200 pids, oom 500
    const exec = fakeExec({
      stdout: "1500000000|0||536870912|536870912|0|200|500",
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.deepEqual(result, {
      cpus: 1.5,
      memory: "512m",
      memorySwap: "512m",
      pidsLimit: 200,
      oomScoreAdj: 500,
    });
  });

  it("returns {} when output has unexpected number of fields", async () => {
    // Defensive: don't parse a malformed line into bogus values.
    const exec = fakeExec({
      stdout: "1500000000|0|", // only 3 fields, expected 8
      exitCode: 0,
    });
    const result = await getLiveResources(dummyRuntime, "x", exec);
    assert.deepEqual(result, {});
  });
});
