import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveSignalkDataSource } from "../containers.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo } from "../types.js";

/**
 * Drives `resolveSignalkDataSource` itself. `signalkDataMountVolumeScope`
 * covers `assertVolumeIsNotBroaderThanRequested` as a pure function, which
 * leaves the call site untested: deleting the guard from the resolver keeps
 * that suite green.
 *
 * Reaching the volume branch takes two things a bare-metal test host does
 * not give for free. `resolveSignalkDataSource` returns immediately unless
 * `isContainerized()`, which consults `/.dockerenv`, `/run/.containerenv`
 * and `process.env.container` — only the last is settable here. Then
 * `findSelfContainerId` runs a four-step cascade whose later steps read the
 * real `/proc/self/cgroup` and `/proc/self/mountinfo`; pinning step 1 with
 * `SIGNALK_CONTAINER_ID` keeps it on the mock instead of this machine.
 *
 * Both are load-bearing: without them the resolver returns `dataDir`
 * unchanged. The refusal cases assert through `assert.rejects`, so that
 * shows up as a failure rather than a false pass.
 */

const SELF = "mock-self-container-id";
const DATA_DIR = "/var/lib/signalk/plugin-config-data/signalk-container";

const RUNTIME = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
} satisfies ContainerRuntimeInfo;

function selfWithMount(mount: {
  Type: string;
  Name?: string;
  Source?: string;
  Destination: string;
}) {
  return {
    containers: {
      [SELF]: { inspect: { Id: SELF, Mounts: [mount] } },
    },
  };
}

let priorContainerEnv: string | undefined;
let priorSelfId: string | undefined;

beforeEach(() => {
  priorContainerEnv = process.env.container;
  priorSelfId = process.env.SIGNALK_CONTAINER_ID;
  // Make isContainerized() true and pin self-detection to the mock, so the
  // resolver takes its containerized path deterministically.
  process.env.container = "podman";
  process.env.SIGNALK_CONTAINER_ID = SELF;
});

afterEach(() => {
  if (priorContainerEnv === undefined) delete process.env.container;
  else process.env.container = priorContainerEnv;
  if (priorSelfId === undefined) delete process.env.SIGNALK_CONTAINER_ID;
  else process.env.SIGNALK_CONTAINER_ID = priorSelfId;
});

describe("resolveSignalkDataSource — named volume backing", () => {
  it("returns the volume when it is mounted on the data dir", async () => {
    const client = makeMockClient(
      selfWithMount({
        Type: "volume",
        Name: "sk-data",
        Destination: DATA_DIR,
      }),
    );
    const source = await resolveSignalkDataSource(
      DATA_DIR,
      RUNTIME,
      () => {},
      client,
    );
    assert.equal(source, "sk-data");
  });

  it("throws when the volume covers a parent of the data dir", async () => {
    // The exposure the guard exists for: the container asked for scratch
    // space and would receive the whole SignalK config tree.
    const client = makeMockClient(
      selfWithMount({
        Type: "volume",
        Name: "sk-config",
        Destination: "/var/lib/signalk",
      }),
    );
    await assert.rejects(
      () => resolveSignalkDataSource(DATA_DIR, RUNTIME, () => {}, client),
      /signalkDataMount cannot be resolved safely/,
    );
  });

  it("names the field the caller passed", async () => {
    const client = makeMockClient(
      selfWithMount({
        Type: "volume",
        Name: "sk-config",
        Destination: "/var/lib",
      }),
    );
    await assert.rejects(
      () =>
        resolveSignalkDataSource(
          "/var/lib/signalk",
          RUNTIME,
          () => {},
          client,
          "signalkConfigRootMount",
        ),
      /signalkConfigRootMount cannot be resolved safely/,
    );
  });

  it("narrows a parent BIND to the exact host path, never throwing", async () => {
    // Binds can be subpath-mounted, so a parent bind is not an exposure and
    // must keep working — the guard is volume-only.
    const client = makeMockClient(
      selfWithMount({
        Type: "bind",
        Source: "/host/signalk",
        Destination: "/var/lib/signalk",
      }),
    );
    const source = await resolveSignalkDataSource(
      DATA_DIR,
      RUNTIME,
      () => {},
      client,
    );
    assert.equal(source, "/host/signalk/plugin-config-data/signalk-container");
  });
});
