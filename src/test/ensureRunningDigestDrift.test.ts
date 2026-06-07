import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

type Json = Record<string, unknown>;

/**
 * The inspect JSON for the running `sk-questdb` container. It carries the
 * three slices the digest-drift path reads through `inspect`:
 *  - `State` for `getContainerState` (running),
 *  - `Config`/`HostConfig` for `getLiveContainerConfig` (drift baseline),
 *  - top-level `Image` for `getImageDigest`'s container fallback.
 *
 * `Config.Image` is `questdb/questdb:latest`, `Config.User` is `1000:1000`,
 * and `HostConfig.ExtraHosts` carries docker's `host.containers.internal`
 * default so the config-drift diff stays clean — the only drift the tests
 * exercise is the floating-tag digest probe.
 */
function runningInspect(image: string, containerImageId: string): Json {
  return {
    State: { Status: "running", Running: true, Pid: 12345 },
    Config: {
      Image: image,
      Cmd: null,
      Env: null,
      Labels: {},
      User: "1000:1000",
    },
    HostConfig: {
      NetworkMode: "bridge",
      Binds: null,
      PortBindings: null,
      ExtraHosts: ["host.containers.internal:host-gateway"],
      RestartPolicy: { Name: "" },
    },
    NetworkSettings: { Ports: {}, Networks: { bridge: {} } },
    Mounts: [],
    Image: containerImageId,
    Name: "/sk-questdb",
  };
}

const baseConfig: ContainerConfig = {
  image: "questdb/questdb",
  tag: "latest",
  autoUpdateOnFloatingTag: true,
};

describe("ensureRunning — autoUpdateOnFloatingTag", () => {
  it("does NOT probe when flag is off (default behavior preserved)", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: runningInspect(
            "questdb/questdb:latest",
            "sha256:" + "a".repeat(64),
          ),
        },
      },
      calls,
    });
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      { image: "questdb/questdb", tag: "latest" },
      () => {},
      undefined,
      client,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    assert.equal(pulled, 0, "pull should not be called when flag is off");
    // No recreate fired (no digest probe could run).
    assert.equal(calls.get("remove"), undefined, "no recreate when flag off");
  });

  it("does NOT probe when tag is semver, even with flag on", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: runningInspect(
            "questdb/questdb:9.0.0",
            "sha256:" + "a".repeat(64),
          ),
        },
      },
      calls,
    });
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      {
        image: "questdb/questdb",
        tag: "9.0.0",
        autoUpdateOnFloatingTag: true,
      },
      () => {},
      undefined,
      client,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    assert.equal(pulled, 0, "semver tag should bypass digest probe");
    assert.equal(calls.get("remove"), undefined);
  });

  it("does NOT probe when digest is set (caller already pins to a digest)", async () => {
    // When digest is set, ContainerConfig already triggers config drift on
    // mismatch with the live image — there's no need for our extra probe.
    // We assert: our extra probe pull does not fire. The recreate that
    // follows comes from the existing config-drift path (live Image is the
    // `:latest` tag, requested is the digest ref — those differ).
    const sameDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const calls = new Map<string, unknown[]>();
    let removed = false;
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () => {
            if (removed) {
              const err = new Error("no such object") as Error & {
                statusCode?: number;
              };
              err.statusCode = 404;
              return Promise.reject(err);
            }
            return Promise.resolve(
              runningInspect(
                "questdb/questdb:latest",
                "sha256:" + "c".repeat(64),
              ),
            );
          },
          remove: () => {
            removed = true;
            return Promise.resolve();
          },
        },
      },
      calls,
    });
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, digest: sameDigest },
      () => {},
      undefined,
      client,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    // The missing-branch pull goes through the real pullImage (not _pull),
    // so our injected probe counter stays at 0.
    assert.equal(
      pulled,
      0,
      "our extra probe pull should not be called when digest is set",
    );
  });

  it("pulls but does NOT recreate when image-ids match", async () => {
    const sameId = "sha256:" + "a".repeat(64);
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        // Container's .Image returns the same image-id as the registry-fresh
        // image inspect below, so digest drift does not fire.
        "sk-questdb": {
          inspect: runningInspect("questdb/questdb:latest", sameId),
        },
      },
      images: {
        // getImageDigest on image:tag (registry side after pull).
        "questdb/questdb:latest": { Id: sameId },
      },
      calls,
    });
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      () => {},
      undefined,
      client,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    assert.equal(pulled, 1, "pull should happen once");
    assert.equal(
      calls.get("remove"),
      undefined,
      "no remove should fire when image-ids match",
    );
  });

  it("recreates when registry image-id differs from running container image-id", async () => {
    const remoteId = "sha256:" + "b".repeat(64);
    const liveId = "sha256:" + "c".repeat(64);
    const calls = new Map<string, unknown[]>();
    let removed = false;
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () => {
            // After recreate's removeContainer, the container is gone and
            // getContainerState must report "missing" so the recursive
            // ensureRunning takes the create path.
            if (removed) {
              const err = new Error("no such object") as Error & {
                statusCode?: number;
              };
              err.statusCode = 404;
              return Promise.reject(err);
            }
            // Container .Image = liveId; differs from the registry-fresh
            // remoteId below → digest drift.
            return Promise.resolve(
              runningInspect("questdb/questdb:latest", liveId),
            );
          },
          remove: () => {
            removed = true;
            return Promise.resolve();
          },
        },
      },
      images: {
        // image:tag inspect (registry-fresh after pull) yields remoteId.
        "questdb/questdb:latest": { Id: remoteId },
      },
      calls,
    });
    const debugLines: string[] = [];
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      (m) => debugLines.push(m),
      undefined,
      client,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    assert.ok(pulled >= 1, "pull should happen at least once");
    assert.ok(
      (calls.get("remove") ?? []).length >= 1,
      "remove should be called on digest drift",
    );
    assert.ok(
      (calls.get("createContainer") ?? []).length >= 1,
      "createContainer should be called on recreate",
    );
    assert.ok(
      debugLines.some((l) => l.includes("digest drift detected")),
      `expected 'digest drift detected' in debug, got: ${debugLines.join(" | ")}`,
    );
  });

  it("skips silently when pull fails as offline (boats at sea)", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: runningInspect(
            "questdb/questdb:latest",
            "sha256:" + "c".repeat(64),
          ),
        },
      },
      calls,
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      (m) => debugLines.push(m),
      undefined,
      client,
      undefined,
      false,
      async () => {
        // Simulate getaddrinfo / ENOTFOUND
        const err = new Error("getaddrinfo ENOTFOUND ghcr.io") as Error & {
          code?: string;
        };
        err.code = "ENOTFOUND";
        throw err;
      },
    );
    // No remove/create — container left alone.
    assert.equal(calls.get("remove"), undefined);
    assert.equal(calls.get("createContainer"), undefined);
    assert.ok(
      debugLines.some((l) => l.includes("skipped (offline)")),
      `expected offline-skip debug, got: ${debugLines.join(" | ")}`,
    );
  });
});
