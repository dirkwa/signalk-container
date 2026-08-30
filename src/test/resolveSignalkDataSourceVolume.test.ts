import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveSignalkDataSource } from "../containers.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo } from "../types.js";

/**
 * End-to-end coverage of the resolver, as opposed to
 * `signalkDataMountVolumeScope.test.ts`, which exercises the guard helper in
 * isolation.
 *
 * The distinction matters: `resolveSignalkDataSource` returns at its first
 * line unless `isContainerized()` is true, so on a bare-metal test host the
 * volume branch — and therefore the guard — is never reached. Every
 * assertion here would pass against a build where the guard call had been
 * deleted from the resolver, unless the resolver itself is driven.
 *
 * `isContainerized()` reads `/.dockerenv`, `/run/.containerenv` and
 * `process.env.container`; only the last is settable from a test.
 */

const SELF = "signalk-server";
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
