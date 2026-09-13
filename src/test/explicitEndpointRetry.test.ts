import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndpointConfigError, resolveClient, resetClient } from "../client.js";

/**
 * An explicitly configured endpoint fails closed inside `pickSocket` — we
 * never fall through to a conventional socket, because silently managing a
 * different daemon than the operator selected is worse than failing.
 *
 * How that failure is *reported* decides whether detection can recover. A
 * socket that has not appeared yet is transient and must read as `null`, the
 * same as any other socket that did not answer, so the startup retry keeps
 * probing. A malformed endpoint is an operator mistake no retry can fix and
 * must keep throwing, or the plugin polls a typo forever.
 */
const ENV_VARS = ["DOCKER_HOST", "CONTAINER_HOST"] as const;
const SAVED = new Map<string, string | undefined>();

/**
 * Take both variables out of play before each case. A dev box commonly
 * exports `DOCKER_HOST`, and `socketCandidates` prefers it — setting only
 * `CONTAINER_HOST` would leave the real socket answering and the assertion
 * measuring nothing.
 */
function clearEndpointEnv(): void {
  for (const key of ENV_VARS) {
    if (!SAVED.has(key)) SAVED.set(key, process.env[key]);
    delete process.env[key];
  }
  resetClient();
}

describe("explicit endpoint — transient vs terminal", () => {
  afterEach(() => {
    for (const [key, value] of SAVED) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    SAVED.clear();
    resetClient();
  });

  it("reports an absent configured socket as no-runtime, not a throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skc-endpoint-"));
    try {
      // Nothing was ever created at this path: the daemon may simply not have
      // started yet, which is exactly the boot race detection now retries.
      clearEndpointEnv();
      process.env.CONTAINER_HOST = `unix://${join(dir, "absent.sock")}`;
      assert.equal(await resolveClient("auto"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still throws on an endpoint whose scheme we do not speak", async () => {
    clearEndpointEnv();
    process.env.DOCKER_HOST = "tcp://192.0.2.10:2375";
    await assert.rejects(
      () => resolveClient("auto"),
      (err: unknown) => {
        assert.ok(
          err instanceof EndpointConfigError,
          `expected EndpointConfigError, got ${String(err)}`,
        );
        return true;
      },
      "a scheme we cannot speak is an operator mistake, not a wait",
    );
  });

  it("still throws when the configured path is not a socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skc-endpoint-"));
    try {
      const plain = join(dir, "not-a-socket");
      writeFileSync(plain, "");
      clearEndpointEnv();
      process.env.CONTAINER_HOST = plain;
      await assert.rejects(
        () => resolveClient("auto"),
        (err: unknown) => err instanceof EndpointConfigError,
        "a path that exists and is not a socket cannot start answering later",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
