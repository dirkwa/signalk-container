import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";
import {
  makeMockClient,
  httpError,
  storageCorrupt500 as corrupt500,
  HTTP_NOT_FOUND,
  HTTP_INTERNAL_SERVER_ERROR,
} from "./helpers/mockClient.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

const requested: ContainerConfig = {
  image: "questdb/questdb",
  tag: "9.0.0",
  env: { FOO: "2" },
};

describe("ensureRunning — corrupt container storage (issue #219)", () => {
  it("removes the corrupt container and recreates it", async () => {
    // Scenario: power loss zero-truncated the container layer's overlay
    // metadata. Every inspect 500s, but force-remove works. ensureRunning
    // must remove the container and fall through to the normal create.
    const calls = new Map<string, unknown[]>();
    let removed = false;
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () =>
            Promise.reject(
              removed
                ? httpError("no such container", HTTP_NOT_FOUND)
                : corrupt500(),
            ),
          remove: () => {
            removed = true;
            return Promise.resolve();
          },
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
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
    assert.equal(
      (calls.get("remove") ?? []).length,
      1,
      "the corrupt container should be removed exactly once",
    );
    assert.equal(
      (calls.get("createContainer") ?? []).length,
      1,
      "a fresh container should be created",
    );
    assert.ok(
      (calls.get("start") ?? []).length > 0,
      "the recreated container should be started",
    );
    assert.ok(
      debugLines.some((l) => l.includes("corrupt storage")),
      `expected corrupt-storage message, got: ${debugLines.join(" | ")}`,
    );
  });

  it("surfaces an actionable message when removal fails (podman repair hint)", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () => Promise.reject(corrupt500()),
          remove: () => Promise.reject(new Error("cannot remove")),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    await assert.rejects(
      ensureRunning(podman, "questdb", requested, () => {}, undefined, client),
      (err: Error) => {
        assert.match(err.message, /corrupt storage/);
        assert.match(err.message, /podman rm -f sk-questdb/);
        assert.match(err.message, /podman system check --repair --force/);
        return true;
      },
    );
    assert.equal(
      (calls.get("createContainer") ?? []).length,
      0,
      "no create should be attempted when removal failed",
    );
  });

  it("gives up after one removal when the state read still fails (bounded recovery)", async () => {
    // Removal succeeds but the follow-up state read still 500s (e.g. the
    // store itself is damaged beyond this container). Exactly one removal,
    // no create, actionable error.
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () => Promise.reject(corrupt500()),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    await assert.rejects(
      ensureRunning(docker, "questdb", requested, () => {}, undefined, client),
      /corrupt storage and automatic recovery failed/,
    );
    assert.equal(
      (calls.get("remove") ?? []).length,
      1,
      "removal should be attempted exactly once",
    );
    assert.equal(
      (calls.get("createContainer") ?? []).length,
      0,
      "no create should be attempted while inspect still fails",
    );
  });

  it("does not recover on the post-recreate re-entry (recursion guard)", async () => {
    // If corruption resurfaces during the recursive re-entry after a
    // drift recreate, the error must propagate raw — a second recovery
    // attempt here could loop remove/recreate forever.
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () => Promise.reject(corrupt500()),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    await assert.rejects(
      ensureRunning(
        docker,
        "questdb",
        requested,
        () => {},
        undefined,
        client,
        undefined,
        true,
      ),
      /storage is corrupt/i,
    );
    assert.equal(
      (calls.get("remove") ?? []).length,
      0,
      "the guarded re-entry must not remove again",
    );
  });

  it("does not remove the container for a non-corruption 500", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: () =>
            Promise.reject(
              httpError(
                "(HTTP code 500) server error - something else ",
                HTTP_INTERNAL_SERVER_ERROR,
              ),
            ),
        },
      },
      images: { "questdb/questdb:9.0.0": { Id: "sha256:abc" } },
      calls,
    });
    await assert.rejects(
      ensureRunning(docker, "questdb", requested, () => {}, undefined, client),
      /Unexpected error/,
    );
    assert.equal(
      (calls.get("remove") ?? []).length,
      0,
      "an unclassified error must not trigger a destructive removal",
    );
  });
});
