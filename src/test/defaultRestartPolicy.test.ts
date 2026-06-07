import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

// signalk-container forwards `ContainerConfig.restart` to the runtime as
// `HostConfig.RestartPolicy.Name` in the createContainer payload. Until
// 1.11.0 the field was optional with no default, so a consumer plugin
// that forgot to set it would create a container with no restart policy —
// a host reboot would leave the container `exited` and nothing brought it
// back until signalk-server was restarted and the plugin's start() ran
// ensureRunning() again.
//
// The default is now `unless-stopped` so containers come back on host
// reboot without the consumer plugin having to opt in. `"no"` still
// suppresses the policy entirely for genuinely one-shot containers.

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
  RestartPolicy?: { Name?: string };
  PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
}

// ensureRunning on a missing container pulls (image already present here),
// then builds + submits a createContainer payload. The container is
// "missing" because it is not listed in `containers`, so its inspect
// throws a 404 → the missing branch. The image is present so the pull
// path is skipped. The createContainer payload is captured in `calls`.
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

describe("ensureRunning — default restart policy", () => {
  it("sets RestartPolicy unless-stopped when consumer omits restart", async () => {
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
    assert.equal(
      opts.HostConfig?.RestartPolicy?.Name,
      "unless-stopped",
      "default should still set a restart policy",
    );
  });

  it("honours an explicit restart: always", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, restart: "always" },
      () => {},
      undefined,
      client,
    );
    const opts = createOptsFrom(calls);
    assert.equal(opts.HostConfig?.RestartPolicy?.Name, "always");
  });

  it("honours explicit restart: 'no' by omitting the policy entirely", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, restart: "no" },
      () => {},
      undefined,
      client,
    );
    const opts = createOptsFrom(calls);
    assert.equal(
      opts.HostConfig?.RestartPolicy,
      undefined,
      "explicit 'no' should not set a RestartPolicy",
    );
  });
});

describe("ensureRunning — port binding keys", () => {
  it("defaults a bare container-port key to /tcp", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, ports: { "9000": "9000" } },
      () => {},
      undefined,
      client,
    );
    const opts = createOptsFrom(calls);
    assert.ok(opts.HostConfig?.PortBindings?.["9000/tcp"]);
    assert.equal(
      opts.HostConfig?.PortBindings?.["9000/tcp"]?.[0]?.HostPort,
      "9000",
    );
  });

  it("preserves a protocol-qualified key (no double /tcp on udp)", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, ports: { "53/udp": "53" } },
      () => {},
      undefined,
      client,
    );
    const opts = createOptsFrom(calls);
    const keys = Object.keys(opts.HostConfig?.PortBindings ?? {});
    assert.deepEqual(keys, ["53/udp"], "udp key must not become 53/udp/tcp");
  });
});
