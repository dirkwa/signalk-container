import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspectForHealthSchedule } from "../client.js";
import type { ContainerClient } from "../client.js";

/**
 * The scheduling probe runs detached, so this helper's contract is that it
 * never rejects: a throw would surface as an unhandled rejection with no
 * useful context. `safeInspect` only swallows 404s, so anything else — a
 * refused socket, a stopped daemon — has to be caught here.
 */
function clientWith(inspect: () => Promise<unknown>): ContainerClient {
  return {
    getContainer: () => ({ inspect }),
  } as unknown as ContainerClient;
}

describe("inspectForHealthSchedule", () => {
  it("returns the inspect payload on success", async () => {
    const payload = { Id: "abc", State: { Health: { Status: "starting" } } };
    const got = await inspectForHealthSchedule(
      clientWith(async () => payload),
      "sk-x",
    );
    assert.deepEqual(got, payload);
  });

  it("returns null when the container is gone (404)", async () => {
    const notFound = Object.assign(new Error("no such container"), {
      statusCode: 404,
    });
    const got = await inspectForHealthSchedule(
      clientWith(async () => {
        throw notFound;
      }),
      "sk-x",
    );
    assert.equal(got, null);
  });

  it("returns null on a non-404 failure rather than rejecting", async () => {
    // The case safeInspect does NOT swallow. Rejecting here would escape the
    // detached probe entirely.
    const got = await inspectForHealthSchedule(
      clientWith(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          statusCode: 500,
        });
      }),
      "sk-x",
    );
    assert.equal(got, null);
  });

  it("returns null when the client itself throws synchronously", async () => {
    const client = {
      getContainer: () => {
        throw new Error("client reset");
      },
    } as unknown as ContainerClient;
    assert.equal(await inspectForHealthSchedule(client, "sk-x"), null);
  });
});
