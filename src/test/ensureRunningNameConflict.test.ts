import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";
import type { ContainerClient } from "../client.js";
import { makeMockClient } from "./helpers/mockClient.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

const requested: ContainerConfig = {
  image: "questdb/questdb",
  tag: "9.0.0",
  env: { FOO: "2" },
};

/**
 * Wrap a base mock client, overriding `createContainer` with a caller-supplied
 * implementation. `makeMockClient` always succeeds on create; the name-conflict
 * scenario needs the FIRST create to throw and the second to succeed, which a
 * closure-driven override expresses without forking the whole mock.
 */
function withCreateOverride(
  base: ContainerClient,
  createContainer: (opts: unknown) => Promise<unknown>,
): ContainerClient {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "createContainer") return createContainer;
      return Reflect.get(target, prop, receiver);
    },
  }) as ContainerClient;
}

/** A name-conflict error as the runtime surfaces it over the socket. */
function nameConflict(): Error {
  return new Error(
    'the container name "sk-questdb" is already in use by abc123',
  );
}

describe("ensureRunning — stale-container name conflict on create", () => {
  it("removes the stale container and retries when create hits a name conflict", async () => {
    // Scenario: a container with this name exists but `inspect` fails (a
    // corrupt storage layer after an unclean shutdown), so getContainerState
    // reports "missing". The create then collides with the still-registered
    // name; ensureRunning must remove the stale container and retry once.
    const calls = new Map<string, unknown[]>();
    let createCount = 0;
    // Container is "missing" (no inspect registered → 404 throughout, which
    // also drives removeContainer's fixVolumePermissions getContainerState to
    // "missing"). Image is present → no pull. First create throws the name
    // conflict, second succeeds.
    const base = makeMockClient({
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    const client = withCreateOverride(base, (opts) => {
      createCount++;
      const list = calls.get("createContainer") ?? [];
      list.push(opts);
      calls.set("createContainer", list);
      if (createCount === 1) return Promise.reject(nameConflict());
      // Hand back a real mock container so createAndStart's `.start()` works.
      return Promise.resolve(
        base.getContainer((opts as { name?: string }).name ?? "created"),
      );
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      client,
    );
    assert.equal(createCount, 2, "create should be attempted exactly twice");
    assert.ok(
      (calls.get("remove") ?? []).length > 0,
      "stale container should be removed",
    );
    assert.ok(
      debugLines.some((l) => l.includes("name conflict")),
      `expected name-conflict message, got: ${debugLines.join(" | ")}`,
    );
  });

  it("does not retry create when the failure is unrelated to a name conflict", async () => {
    const calls = new Map<string, unknown[]>();
    let createCount = 0;
    const base = makeMockClient({
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    const client = withCreateOverride(base, (opts) => {
      createCount++;
      const list = calls.get("createContainer") ?? [];
      list.push(opts);
      calls.set("createContainer", list);
      // A disk-full failure: categorized as "disk", never as a conflict, so
      // ensureRunning must not remove-and-retry.
      return Promise.reject(new Error("no space left on device"));
    });
    await assert.rejects(
      ensureRunning(docker, "questdb", requested, () => {}, undefined, client),
      // The thrown message now carries the categorized userMessage rather than
      // the raw runtime text ("no space left on device" → "Disk full.").
      /Failed to create .*Disk full/,
    );
    assert.equal(createCount, 1, "create should be attempted exactly once");
    assert.equal(
      (calls.get("remove") ?? []).length,
      0,
      "no removal should be attempted for an unrelated failure",
    );
  });
});
