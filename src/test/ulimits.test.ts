import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning, ulimitsForRun } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

// signalk-container forwards `ContainerConfig.ulimits` to the runtime as
// `HostConfig.Ulimits` ({ Name, Soft, Hard }) in the createContainer payload.
// The motivating case is `nofile`: a containerized process inherits its
// open-files limit from the runtime, not the host's `fs.file-max`, so pinning
// it here is the only reliable way to give e.g. QuestDB the high limit it
// needs.

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

const baseConfig: ContainerConfig = {
  image: "questdb/questdb",
  tag: "latest",
};

interface Ulimit {
  Name?: string;
  Soft?: number;
  Hard?: number;
}

function makeClient(): {
  client: ReturnType<typeof makeMockClient>;
  calls: Map<string, unknown[]>;
} {
  const calls = new Map<string, unknown[]>();
  const client = makeMockClient({
    images: { "questdb/questdb:latest": { Id: "sha256:abc", Config: {} } },
    calls,
  });
  return { client, calls };
}

function ulimitsFrom(calls: Map<string, unknown[]>): Ulimit[] | undefined {
  const created = calls.get("createContainer");
  if (!created || created.length === 0) {
    throw new Error("no `createContainer` call captured");
  }
  return (created[0] as { HostConfig?: { Ulimits?: Ulimit[] } }).HostConfig
    ?.Ulimits;
}

describe("ulimitsForRun", () => {
  it("returns undefined when no ulimits are configured", () => {
    assert.equal(ulimitsForRun(undefined), undefined);
    assert.equal(ulimitsForRun({}), undefined);
  });

  it("expands a bare number to equal soft and hard limits", () => {
    assert.deepEqual(ulimitsForRun({ nofile: 1048576 }), [
      { Name: "nofile", Soft: 1048576, Hard: 1048576 },
    ]);
  });

  it("passes through independent soft and hard limits", () => {
    assert.deepEqual(
      ulimitsForRun({ nofile: { soft: 65536, hard: 1048576 } }),
      [{ Name: "nofile", Soft: 65536, Hard: 1048576 }],
    );
  });

  it("emits one entry per named ulimit", () => {
    const result = ulimitsForRun({ nofile: 1048576, nproc: 4096 });
    assert.deepEqual(result, [
      { Name: "nofile", Soft: 1048576, Hard: 1048576 },
      { Name: "nproc", Soft: 4096, Hard: 4096 },
    ]);
  });
});

describe("ensureRunning — ulimits", () => {
  it("maps ulimits onto HostConfig.Ulimits in the create payload", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, ulimits: { nofile: 1048576 } },
      () => {},
      undefined,
      client,
    );
    assert.deepEqual(ulimitsFrom(calls), [
      { Name: "nofile", Soft: 1048576, Hard: 1048576 },
    ]);
  });

  it("leaves HostConfig.Ulimits unset when no ulimits are configured", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      () => {},
      undefined,
      client,
    );
    assert.equal(ulimitsFrom(calls), undefined);
  });
});
