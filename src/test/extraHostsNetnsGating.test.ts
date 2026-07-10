import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

// On Docker, buildCreateOptions injects host.containers.internal:host-gateway
// into ExtraHosts (Podman maps it natively). Docker rejects ExtraHosts
// combined with a `container:<id>` network mode ("conflicting options:
// custom host-to-IP mapping and the network mode"), so the injection must
// be skipped when the config shares another container's netns (#188).

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

interface HostConfigShape {
  ExtraHosts?: string[];
  NetworkMode?: string;
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

function createOptsFrom(calls: Map<string, unknown[]>): {
  HostConfig?: HostConfigShape;
} {
  const created = calls.get("createContainer");
  if (!created || created.length === 0) {
    throw new Error("no `createContainer` call captured");
  }
  return created[0] as { HostConfig?: HostConfigShape };
}

describe("ensureRunning — ExtraHosts vs container: netns (docker)", () => {
  it("injects host-gateway on the default network", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      () => {},
      undefined,
      client,
    );
    const opts = createOptsFrom(calls);
    assert.deepEqual(opts.HostConfig?.ExtraHosts, [
      "host.containers.internal:host-gateway",
    ]);
  });

  it("skips the injection under a container: network mode", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, networkMode: "container:abc123" },
      () => {},
      undefined,
      client,
    );
    const opts = createOptsFrom(calls);
    assert.equal(opts.HostConfig?.NetworkMode, "container:abc123");
    assert.equal(
      opts.HostConfig?.ExtraHosts,
      undefined,
      "ExtraHosts must be absent — Docker rejects it with container netns sharing",
    );
  });

  it("passes user extraHosts through under container: netns — only the injection is gated", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      {
        ...baseConfig,
        networkMode: "container:abc123",
        extraHosts: { "internal-service": "192.168.1.100" },
      },
      () => {},
      undefined,
      client,
    );
    const opts = createOptsFrom(calls);
    assert.deepEqual(
      opts.HostConfig?.ExtraHosts,
      ["internal-service:192.168.1.100"],
      "user-supplied entries pass through unchanged; only the injection is gated",
    );
  });
});
