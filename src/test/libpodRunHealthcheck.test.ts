import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { libpodRunHealthcheck } from "../client.js";
import type { ContainerClient } from "../client.js";

/**
 * Runs a container's own HEALTHCHECK over podman's native endpoint, for hosts
 * where nothing else will. Every failure resolves `null` rather than
 * rejecting: the caller is a detached timer, so a throw here would surface as
 * an unhandled rejection with no useful context.
 */
function clientWith(
  dial?: (opts: unknown, cb: (e: unknown, d: unknown) => void) => void,
): ContainerClient {
  return { modem: { dial } } as unknown as ContainerClient;
}

describe("libpodRunHealthcheck", () => {
  it("returns the status the daemon reports", async () => {
    const client = clientWith((_o, cb) => cb(null, { Status: "healthy" }));
    assert.equal(await libpodRunHealthcheck(client, "sk-x"), "healthy");
  });

  it("passes through a non-healthy verdict unchanged", async () => {
    for (const Status of ["unhealthy", "starting"]) {
      const client = clientWith((_o, cb) => cb(null, { Status }));
      assert.equal(await libpodRunHealthcheck(client, "sk-x"), Status);
    }
  });

  it("targets the container's libpod healthcheck endpoint", async () => {
    let seen = "";
    const client = clientWith((o, cb) => {
      seen = (o as { path: string }).path;
      cb(null, { Status: "healthy" });
    });
    await libpodRunHealthcheck(client, "sk-my-container");
    assert.match(seen, /\/libpod\/containers\/sk-my-container\/healthcheck$/);
  });

  it("escapes a name that would otherwise break the path", async () => {
    let seen = "";
    const client = clientWith((o, cb) => {
      seen = (o as { path: string }).path;
      cb(null, { Status: "healthy" });
    });
    await libpodRunHealthcheck(client, "weird/name");
    assert.ok(!seen.includes("weird/name"), `unescaped: ${seen}`);
    assert.ok(seen.includes("weird%2Fname"), `expected escaping: ${seen}`);
  });

  it("returns null when the modem cannot dial", async () => {
    // Test mocks and non-podman clients have no dial; that is not an error.
    assert.equal(
      await libpodRunHealthcheck(clientWith(undefined), "sk-x"),
      null,
    );
  });

  it("returns null when the dial reports an error", async () => {
    // Docker 404s here — it has no libpod endpoint and needs no help.
    const client = clientWith((_o, cb) => cb(new Error("404"), null));
    assert.equal(await libpodRunHealthcheck(client, "sk-x"), null);
  });

  it("returns null when dial throws synchronously", async () => {
    const client = clientWith(() => {
      throw new Error("socket gone");
    });
    assert.equal(await libpodRunHealthcheck(client, "sk-x"), null);
  });

  it("returns null on a payload it cannot read", async () => {
    for (const payload of [null, undefined, "text", 42, {}, { Status: 7 }]) {
      const client = clientWith((_o, cb) => cb(null, payload));
      assert.equal(
        await libpodRunHealthcheck(client, "sk-x"),
        null,
        `for ${JSON.stringify(payload)}`,
      );
    }
  });
});
