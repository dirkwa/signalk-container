import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { getImageHealthcheck, ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";
import type Docker from "dockerode";
import { makeMockClient } from "./helpers/mockClient.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

// Deterministic user-mapping flags regardless of who runs the suite.
before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

// The nanosecond-integer shape dockerode returns under `Config.Healthcheck`
// on both podman and docker (verified live).
const IMAGE_HEALTHCHECK = {
  Test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:6502/signalk"],
  Interval: 30_000_000_000,
  Timeout: 5_000_000_000,
  StartPeriod: 15_000_000_000,
  Retries: 3,
};

describe("getImageHealthcheck", () => {
  it("parses the image's healthcheck from inspect JSON", async () => {
    const client = makeMockClient({
      images: {
        // podman qualifies a registry-bearing ref unchanged.
        "ghcr.io/x/y:tag": { Config: { Healthcheck: IMAGE_HEALTHCHECK } },
      },
    });
    const hc = await getImageHealthcheck(podman, "ghcr.io/x/y:tag", client);
    assert.deepEqual(hc, {
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:6502/signalk"],
      intervalNs: 30_000_000_000,
      timeoutNs: 5_000_000_000,
      startPeriodNs: 15_000_000_000,
      retries: 3,
    });
  });

  it("returns null when the image declares no healthcheck", async () => {
    const client = makeMockClient({
      // podman prefixes a bare name with docker.io/.
      images: { "docker.io/img": { Config: {} } },
    });
    assert.equal(await getImageHealthcheck(podman, "img", client), null);
  });

  it("returns null for HEALTHCHECK NONE", async () => {
    const client = makeMockClient({
      images: {
        "docker.io/img": { Config: { Healthcheck: { Test: ["NONE"] } } },
      },
    });
    assert.equal(await getImageHealthcheck(podman, "img", client), null);
  });

  it("returns null when inspect fails", async () => {
    // Image absent from the spec → inspect throws 404 → mapped to null.
    const client = makeMockClient({ images: {} });
    assert.equal(await getImageHealthcheck(podman, "img", client), null);
  });
});

describe("ensureRunning — image healthcheck re-emitted in the create payload", () => {
  // Drive the missing-state create path and capture the `createContainer`
  // payload. The container is missing (not listed → inspect 404), the image
  // is present with the given healthcheck, and the create call is recorded.
  function captureCreate(
    config: ContainerConfig,
    imageHealthcheck:
      | Docker.ContainerInspectInfo["Config"]["Healthcheck"]
      | undefined,
  ): {
    createPayload: () => Docker.ContainerCreateOptions | undefined;
    run: () => Promise<void>;
  } {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      images: {
        "ghcr.io/x/y:tag": {
          Config: imageHealthcheck ? { Healthcheck: imageHealthcheck } : {},
        },
      },
      calls,
    });
    return {
      createPayload: () =>
        calls.get("createContainer")?.[0] as
          | Docker.ContainerCreateOptions
          | undefined,
      run: () =>
        ensureRunning(docker, "demo", config, () => {}, undefined, client),
    };
  }

  it("re-emits the image healthcheck timing fields in the create payload", async () => {
    const cap = captureCreate(
      { image: "ghcr.io/x/y", tag: "tag" },
      IMAGE_HEALTHCHECK,
    );
    await cap.run();
    const opts = cap.createPayload();
    assert.ok(opts, "createContainer was invoked");
    const hc = opts!.Healthcheck;
    assert.ok(hc, "Healthcheck present in create payload");
    assert.deepEqual(hc!.Test, [
      "CMD-SHELL",
      "wget -q -O /dev/null http://127.0.0.1:6502/signalk",
    ]);
    assert.equal(hc!.Interval, 30_000_000_000);
    assert.equal(hc!.Timeout, 5_000_000_000);
    assert.equal(hc!.StartPeriod, 15_000_000_000);
    assert.equal(hc!.Retries, 3);
  });

  it("sets no Healthcheck when the image has no healthcheck", async () => {
    const cap = captureCreate({ image: "ghcr.io/x/y", tag: "tag" }, undefined);
    await cap.run();
    const opts = cap.createPayload();
    assert.ok(opts, "createContainer was invoked");
    assert.equal(opts!.Healthcheck, undefined, "no Healthcheck emitted");
  });
});

describe("ensureRunning — explicit healthcheck override", () => {
  // A "decoy" image healthcheck distinct from every override below. The
  // image is present (so imageExists succeeds) and carries this check; the
  // override path must NOT surface it in the create payload — production
  // short-circuits `getImageHealthcheck` entirely when `config.healthcheck`
  // is set. Asserting the payload reflects the override (not the decoy)
  // proves the image's healthcheck was not consulted.
  const DECOY_IMAGE_HEALTHCHECK = {
    Test: ["CMD-SHELL", "echo decoy"],
    Interval: 99_000_000_000,
    Retries: 9,
  };

  // Like captureCreate above. The image is listed (so imageExists succeeds)
  // and inspect returns the decoy healthcheck.
  function captureCreate(config: ContainerConfig): {
    createPayload: () => Docker.ContainerCreateOptions | undefined;
    run: () => Promise<void>;
  } {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      images: {
        "x/y:t": { Config: { Healthcheck: DECOY_IMAGE_HEALTHCHECK } },
        "questdb/questdb:latest": {
          Config: { Healthcheck: DECOY_IMAGE_HEALTHCHECK },
        },
      },
      calls,
    });
    return {
      createPayload: () =>
        calls.get("createContainer")?.[0] as
          | Docker.ContainerCreateOptions
          | undefined,
      run: () =>
        ensureRunning(docker, "demo", config, () => {}, undefined, client),
    };
  }

  it("emits a CMD override healthcheck and ignores the image healthcheck", async () => {
    const cap = captureCreate({
      image: "questdb/questdb",
      tag: "latest",
      healthcheck: {
        test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/"],
        interval: "30s",
        timeout: "5s",
        startPeriod: "15s",
        retries: 3,
      },
    });
    await cap.run();
    const opts = cap.createPayload();
    assert.ok(opts, "createContainer was invoked");
    const hc = opts!.Healthcheck;
    assert.ok(hc, "Healthcheck present in create payload");
    // Exec-form CMD keeps each argv element separate — Docker execs the binary
    // directly, so joining into one string would make it look for a binary
    // literally named "curl -f http://...". Only CMD-SHELL takes a joined string.
    assert.deepEqual(hc!.Test, ["CMD", "curl", "-f", "http://127.0.0.1:9000/"]);
    assert.equal(hc!.Interval, 30_000_000_000);
    assert.equal(hc!.Timeout, 5_000_000_000);
    assert.equal(hc!.StartPeriod, 15_000_000_000);
    assert.equal(hc!.Retries, 3);
    assert.notEqual(
      hc!.Retries,
      9,
      "override wins over the image's own healthcheck",
    );
  });

  it("wraps a CMD-SHELL override as a single shell string", async () => {
    const cap = captureCreate({
      image: "x/y",
      tag: "t",
      healthcheck: {
        test: ["CMD-SHELL", "curl -f http://localhost:9000/ || exit 1"],
      },
    });
    await cap.run();
    const opts = cap.createPayload();
    assert.ok(opts, "createContainer was invoked");
    assert.deepEqual(opts!.Healthcheck!.Test, [
      "CMD-SHELL",
      "curl -f http://localhost:9000/ || exit 1",
    ]);
  });

  it("emits Test ['NONE'] when the override is false", async () => {
    const cap = captureCreate({
      image: "x/y",
      tag: "t",
      healthcheck: false,
    });
    await cap.run();
    const opts = cap.createPayload();
    assert.ok(opts, "createContainer was invoked");
    assert.deepEqual(
      opts!.Healthcheck!.Test,
      ["NONE"],
      "false override disables the healthcheck",
    );
  });
});
