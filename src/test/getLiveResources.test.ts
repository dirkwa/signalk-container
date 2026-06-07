import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLiveResources } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

interface HostResources {
  NanoCpus?: number;
  CpuShares?: number;
  CpusetCpus?: string;
  Memory?: number;
  MemorySwap?: number;
  MemoryReservation?: number;
  PidsLimit?: number;
  OomScoreAdj?: number;
}

/** Build a mock client whose `sk-x` container inspects with the given HostConfig. */
function clientWith(hostConfig: HostResources) {
  return makeMockClient({
    containers: { "sk-x": { inspect: { HostConfig: hostConfig } } },
  });
}

describe("getLiveResources (Bug A/D support)", () => {
  it("returns empty when container is missing", async () => {
    const client = makeMockClient({});
    const result = await getLiveResources(dummyRuntime, "ghost", client);
    assert.deepEqual(result, {});
  });

  it("parses NanoCpus into cpus (1.5 cores)", async () => {
    // 1.5 cores in NanoCpus = 1.5 * 1e9 = 1500000000
    const client = clientWith({ NanoCpus: 1500000000 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.equal(result.cpus, 1.5);
  });

  it("parses Memory bytes into memory string", async () => {
    // 512 MiB = 512 * 1024 * 1024 = 536870912
    const client = clientWith({ Memory: 536870912 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.equal(result.memory, "512m");
  });

  it("parses MemorySwap and MemoryReservation", async () => {
    const client = clientWith({
      Memory: 536870912,
      MemorySwap: 536870912,
      MemoryReservation: 268435456,
    });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.equal(result.memory, "512m");
    assert.equal(result.memorySwap, "512m");
    assert.equal(result.memoryReservation, "256m");
  });

  it("parses cpusetCpus when set", async () => {
    const client = clientWith({ CpusetCpus: "1,2" });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.equal(result.cpusetCpus, "1,2");
  });

  it("does NOT emit cpusetCpus when empty string", async () => {
    const client = clientWith({ CpusetCpus: "" });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.ok(!("cpusetCpus" in result));
  });

  it("treats cpuShares=1024 as default (not emitted)", async () => {
    // 1024 is the kernel default; emitting it would create false
    // diffs in ensureRunning's change detection.
    const client = clientWith({ CpuShares: 1024 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.ok(!("cpuShares" in result));
  });

  it("emits cpuShares when explicitly set to non-default", async () => {
    const client = clientWith({ CpuShares: 512 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.equal(result.cpuShares, 512);
  });

  it("treats pidsLimit=2048 as default (not emitted)", async () => {
    // 2048 is podman's default; same logic as cpuShares=1024.
    const client = clientWith({ PidsLimit: 2048 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.ok(!("pidsLimit" in result));
  });

  it("emits pidsLimit when explicitly set to non-default", async () => {
    const client = clientWith({ PidsLimit: 200 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.equal(result.pidsLimit, 200);
  });

  it("emits oomScoreAdj when non-zero", async () => {
    const client = clientWith({ OomScoreAdj: 500 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.equal(result.oomScoreAdj, 500);
  });

  it("does NOT emit oomScoreAdj when zero (kernel default)", async () => {
    const client = clientWith({ OomScoreAdj: 0 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.ok(!("oomScoreAdj" in result));
  });

  it("emits gigabyte memory in 'g' units (not bloated 'm')", async () => {
    // 2 GiB = 2 * 1024^3 = 2147483648
    const client = clientWith({ Memory: 2147483648 });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.equal(result.memory, "2g");
  });

  it("parses a fully-loaded container snapshot end-to-end", async () => {
    // 1.5 cores, 512 MiB mem + swap disabled, 200 pids, oom 500
    const client = clientWith({
      NanoCpus: 1500000000,
      Memory: 536870912,
      MemorySwap: 536870912,
      PidsLimit: 200,
      OomScoreAdj: 500,
    });
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.deepEqual(result, {
      cpus: 1.5,
      memory: "512m",
      memorySwap: "512m",
      pidsLimit: 200,
      oomScoreAdj: 500,
    });
  });

  it("returns {} when HostConfig carries no resource fields", async () => {
    // Defensive: an inspect with an empty HostConfig (all fields unset)
    // must not synthesize bogus values.
    const client = clientWith({});
    const result = await getLiveResources(dummyRuntime, "x", client);
    assert.deepEqual(result, {});
  });
});
