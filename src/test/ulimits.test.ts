import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureRunning,
  ulimitsForRun,
  readNofileHardCeiling,
} from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type {
  ContainerConfig,
  ContainerRuntimeInfo,
  UlimitClamp,
} from "../types.js";

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

describe("ulimitsForRun — validation", () => {
  it("rejects a negative limit", () => {
    assert.throws(() => ulimitsForRun({ nofile: -1 }), /non-negative integer/);
  });

  it("rejects a non-integer limit", () => {
    assert.throws(
      () => ulimitsForRun({ nofile: 1024.5 }),
      /non-negative integer/,
    );
    assert.throws(() => ulimitsForRun({ nofile: NaN }), /non-negative integer/);
  });

  it("rejects hard < soft", () => {
    assert.throws(
      () => ulimitsForRun({ nofile: { soft: 1048576, hard: 65536 } }),
      /hard \(65536\) must be >= soft \(1048576\)/,
    );
  });

  it("names the offending ulimit and bound in the error", () => {
    assert.throws(
      () => ulimitsForRun({ nproc: { soft: -5, hard: 10 } }),
      /soft ulimit for "nproc"/,
    );
  });

  it("accepts zero", () => {
    assert.deepEqual(ulimitsForRun({ memlock: 0 }), [
      { Name: "memlock", Soft: 0, Hard: 0 },
    ]);
  });
});

describe("ulimitsForRun — nofile clamp to host ceiling", () => {
  it("clamps soft and hard down to the ceiling and notifies", () => {
    let clamped: { requested: number; granted: number } | null = null;
    const result = ulimitsForRun({ nofile: 1048576 }, 524288, (r, g) => {
      clamped = { requested: r, granted: g };
    });
    assert.deepEqual(result, [{ Name: "nofile", Soft: 524288, Hard: 524288 }]);
    assert.deepEqual(clamped, { requested: 1048576, granted: 524288 });
  });

  it("does not clamp or notify when the request fits under the ceiling", () => {
    let notified = false;
    const result = ulimitsForRun({ nofile: 65536 }, 524288, () => {
      notified = true;
    });
    assert.deepEqual(result, [{ Name: "nofile", Soft: 65536, Hard: 65536 }]);
    assert.equal(notified, false);
  });

  it("only clamps nofile, leaving other ulimits untouched", () => {
    const result = ulimitsForRun({ nofile: 1048576, nproc: 999999 }, 524288);
    assert.deepEqual(result, [
      { Name: "nofile", Soft: 524288, Hard: 524288 },
      { Name: "nproc", Soft: 999999, Hard: 999999 },
    ]);
  });

  it("passes the request through unchanged when the ceiling is null", () => {
    assert.deepEqual(ulimitsForRun({ nofile: 1048576 }, null), [
      { Name: "nofile", Soft: 1048576, Hard: 1048576 },
    ]);
  });
});

describe("readNofileHardCeiling", () => {
  it("returns a positive ceiling on this Linux host (rootful → fs.nr_open)", () => {
    const ceiling = readNofileHardCeiling({
      runtime: "podman",
      version: "5.4.2",
      isPodmanDockerShim: false,
      isRootless: false,
    });
    // fs.nr_open exists on any Linux host; null only on non-Linux.
    if (ceiling !== null) assert.ok(ceiling > 0);
  });

  it("reads the calling process's hard limit when rootless", () => {
    const ceiling = readNofileHardCeiling({
      runtime: "podman",
      version: "5.4.2",
      isPodmanDockerShim: false,
      isRootless: true,
    });
    // /proc/self/limits exists on Linux; the value is this process's hard
    // nofile, which a rootless container cannot exceed.
    if (ceiling !== null) assert.ok(ceiling > 0);
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

  it("fires onUlimitClamped when nofile exceeds the host ceiling", async (t) => {
    // The clamp only fires when a host ceiling is readable. On macOS/Windows
    // there is no /proc/self/limits or fs.nr_open, so readNofileHardCeiling
    // returns null and the request passes through unclamped (correct
    // behaviour) — skip the assertion there rather than fail it.
    if (readNofileHardCeiling(docker) === null) {
      t.skip("no readable nofile ceiling on this platform");
      return;
    }
    const { client, calls } = makeClient();
    const events: UlimitClamp[] = [];
    // MAX_SAFE_INTEGER exceeds any real host ceiling (fs.nr_open on this
    // rootful path), so the clamp always fires regardless of the test box.
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, ulimits: { nofile: Number.MAX_SAFE_INTEGER } },
      () => {},
      {
        onUlimitClamped: (e) => {
          events.push(e);
        },
      },
      client,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].ulimit, "nofile");
    assert.equal(events[0].requested, Number.MAX_SAFE_INTEGER);
    assert.ok(events[0].granted > 0 && events[0].granted < events[0].requested);
    assert.match(events[0].reason, /nofile ulimit .* clamped to/);
    // The payload that reached the runtime carries the clamped value.
    assert.equal(ulimitsFrom(calls)?.[0]?.Hard, events[0].granted);
  });

  it("does not fire onUlimitClamped when the request fits", async () => {
    const { client } = makeClient();
    let fired = false;
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, ulimits: { nofile: 1024 } },
      () => {},
      {
        onUlimitClamped: () => {
          fired = true;
        },
      },
      client,
    );
    assert.equal(fired, false);
  });
});
