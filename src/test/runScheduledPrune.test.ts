import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScheduledPrune, type PruneRunLogger } from "../containers.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo, ManagedImageRef } from "../types.js";

const runtime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.0.0",
  isPodmanDockerShim: false,
};

function makeLog(): {
  log: PruneRunLogger;
  debugs: string[];
  errors: string[];
} {
  const debugs: string[] = [];
  const errors: string[] = [];
  return {
    log: {
      debug: (msg) => debugs.push(msg),
      error: (msg, err) =>
        errors.push(`${msg} ${err instanceof Error ? err.message : err}`),
    },
    debugs,
    errors,
  };
}

const noManaged = async (): Promise<ManagedImageRef[]> => [];

describe("runScheduledPrune", () => {
  it("runs reap then prune and resolves when both succeed", async () => {
    const client = makeMockClient({
      listImages: [],
      pruneImages: { ImagesDeleted: [], SpaceReclaimed: 1024 },
    });
    const { log, debugs, errors } = makeLog();

    await runScheduledPrune(runtime, noManaged, 1, log, client);

    assert.ok(debugs.some((m) => m.startsWith("Reaped ")));
    assert.ok(debugs.some((m) => m.startsWith("Pruned ")));
    assert.equal(errors.length, 0);
  });

  it("still prunes when collecting managed refs fails, then rethrows that failure", async () => {
    const client = makeMockClient({
      listImages: [],
      pruneImages: { ImagesDeleted: [], SpaceReclaimed: 0 },
    });
    const { log, debugs, errors } = makeLog();
    const boom = new Error("manifest unreadable");

    await assert.rejects(
      runScheduledPrune(runtime, () => Promise.reject(boom), 1, log, client),
      boom,
    );

    assert.ok(
      debugs.some((m) => m.startsWith("Pruned ")),
      "prune must run despite the reap-phase failure",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Managed-image reaping failed/);
  });

  it("reaps, logs, and rethrows when the prune fails", async () => {
    const client = makeMockClient({
      listImages: [],
      pruneImages: new Error("daemon down"),
    });
    const { log, debugs, errors } = makeLog();

    await assert.rejects(
      runScheduledPrune(runtime, noManaged, 1, log, client),
      /Prune failed/,
    );

    assert.ok(
      debugs.some((m) => m.startsWith("Reaped ")),
      "reap phase must have completed",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Auto-prune failed/);
  });

  it("rethrows the first (reap-phase) error when both phases fail", async () => {
    const client = makeMockClient({
      listImages: [],
      pruneImages: new Error("daemon down"),
    });
    const { log, errors } = makeLog();
    const boom = new Error("manifest unreadable");

    await assert.rejects(
      runScheduledPrune(runtime, () => Promise.reject(boom), 1, log, client),
      boom,
    );

    assert.equal(errors.length, 2);
    assert.match(errors[0], /Managed-image reaping failed/);
    assert.match(errors[1], /Auto-prune failed/);
  });
});
