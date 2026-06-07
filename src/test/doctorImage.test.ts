import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ContainerCreateOptions } from "dockerode";
import { imageRunsAsUser } from "../doctor.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient, streamFrom } from "./helpers/mockClient.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isRootless: false,
};

const podmanRootless: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
};

// Pin host UID/GID so the user-mapping flags the probe emits are
// deterministic across CI (often UID 0) and a dev machine (often
// 1000) — the *flags* are what we're asserting on, not the host's
// actual identity.
before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

/** Yield the event loop so the demux `data` events drain into the sink. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Build a mock client for a probe container that prints `output` on its
 * (followed) logs stream and exits with `statusCode`. The probe always
 * creates an unnamed throwaway container, so its lifecycle methods are
 * served via `defaultContainer`. Pass `calls` to record the
 * `createContainer` payload for arg-shape assertions.
 *
 * `wait()` defers a couple of ticks before resolving so the follow-logs
 * stream's demuxed `data` events land in the production code's `output`
 * buffer before it reads them — mirroring the real flow where the
 * container has emitted its output by the time it exits.
 */
function probeClient(
  output: string,
  statusCode: number,
  calls?: Map<string, unknown[]>,
) {
  return makeMockClient({
    defaultContainer: {
      logs: () => Promise.resolve(streamFrom(output)),
      wait: async () => {
        await flush();
        await flush();
        return { StatusCode: statusCode };
      },
    },
    calls,
  });
}

/** Read back the single recorded `createContainer` payload. */
function createdOpts(calls: Map<string, unknown[]>): ContainerCreateOptions {
  const created = calls.get("createContainer") ?? [];
  assert.equal(created.length, 1);
  return created[0] as ContainerCreateOptions;
}

describe("imageRunsAsUser", () => {
  it("returns ok=true when the probe exits 0 and prints 'ok'", async () => {
    const result = await imageRunsAsUser(
      docker,
      "questdb/questdb:9.0.0",
      undefined,
      probeClient("ok\n", 0),
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /ok/);
    assert.equal(result.error, undefined);
  });

  it("returns ok=false when the probe exits non-zero", async () => {
    const result = await imageRunsAsUser(
      docker,
      "broken/image:1.0",
      undefined,
      probeClient("touch: cannot create '/tmp/x': Permission denied\n", 1),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /exited with code 1/);
    assert.match(result.output, /Permission denied/);
  });

  it("returns ok=false when exit=0 but stdout does not contain 'ok' (touch silently failed via &&)", async () => {
    const result = await imageRunsAsUser(
      docker,
      "weird/image:1.0",
      undefined,
      probeClient("", 0),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /did not print 'ok'/);
  });

  it("returns ok=false (never throws) when the runtime layer throws", async () => {
    // createContainer rejecting stands in for "daemon unreachable / probe
    // couldn't even be created" — the old CLI-era "command not found".
    const failingClient = makeMockClient({});
    (
      failingClient as unknown as { createContainer: () => Promise<never> }
    ).createContainer = () =>
      Promise.reject(new Error("connect ECONNREFUSED /var/run/docker.sock"));
    const result = await imageRunsAsUser(
      docker,
      "any/image",
      undefined,
      failingClient,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /ECONNREFUSED/);
  });

  it("creates the probe with User=host:host under docker by default", async () => {
    const calls = new Map<string, unknown[]>();
    await imageRunsAsUser(
      docker,
      "questdb/questdb:9.0.0",
      undefined,
      probeClient("ok\n", 0, calls),
    );
    const opts = createdOpts(calls);
    // Docker default: --user equivalent is the create payload's top-level
    // `User`, set to the host caller's uid:gid.
    assert.equal(opts.User, "1000:1000");
    assert.equal(opts.HostConfig?.UsernsMode, undefined);
  });

  it("creates the probe with UsernsMode=keep-id (no User) under rootless podman", async () => {
    const calls = new Map<string, unknown[]>();
    await imageRunsAsUser(
      podmanRootless,
      "questdb/questdb:9.0.0",
      undefined,
      probeClient("ok\n", 0, calls),
    );
    const opts = createdOpts(calls);
    // Rootless podman emits keep-id via HostConfig.UsernsMode, never User.
    assert.match(opts.HostConfig?.UsernsMode ?? "", /^keep-id:uid=0,gid=0$/);
    assert.equal(opts.User, undefined);
  });

  it("creates the probe with no user mapping when user is false (opt out)", async () => {
    const calls = new Map<string, unknown[]>();
    await imageRunsAsUser(
      docker,
      "questdb/questdb:9.0.0",
      false,
      probeClient("ok\n", 0, calls),
    );
    const opts = createdOpts(calls);
    assert.equal(opts.User, undefined);
    assert.equal(opts.HostConfig?.UsernsMode, undefined);
  });

  it("runs the probe as `sh -c 'touch /tmp/x && echo ok'`", async () => {
    const calls = new Map<string, unknown[]>();
    await imageRunsAsUser(
      docker,
      "questdb/questdb:9.0.0",
      undefined,
      probeClient("ok\n", 0, calls),
    );
    const opts = createdOpts(calls);
    // Headline: the throwaway probe runs the touch-and-echo shell. The
    // `--rm` of the CLI era is now an explicit force-remove in production,
    // so there is no AutoRemove flag to assert on here.
    assert.deepEqual(opts.Cmd, ["sh", "-c", "touch /tmp/x && echo ok"]);
    assert.equal(opts.Image, "questdb/questdb:9.0.0");
  });

  it("qualifies the image for podman (docker.io/ prefix when bare)", async () => {
    const calls = new Map<string, unknown[]>();
    await imageRunsAsUser(
      podmanRootless,
      "questdb/questdb:9.0.0",
      undefined,
      probeClient("ok\n", 0, calls),
    );
    const opts = createdOpts(calls);
    assert.equal(
      opts.Image,
      "docker.io/questdb/questdb:9.0.0",
      `expected qualifyImage to prefix docker.io/, got: ${opts.Image}`,
    );
  });
});
