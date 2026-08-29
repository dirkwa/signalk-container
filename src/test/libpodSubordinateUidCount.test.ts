import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { libpodSubordinateUidCount } from "../client.js";
import type { ContainerClient } from "../client.js";

/**
 * The probe behind the `keep-id:size=` bound. It reads podman's own
 * `/libpod/info` rather than `/etc/subuid`, because that file is absent
 * inside a container while the socket answers either way.
 */

/** Identity entry: the caller's own uid, not part of the subordinate block. */
const IDENTITY_ENTRY = { container_id: 0, host_id: 1000, size: 1 };
const FULL_SUBUID_WIDTH = 65536;

/** A client whose `dial` answers with `payload`, or errors when it is null. */
function clientReturning(payload: unknown): ContainerClient {
  return {
    modem: {
      dial: (
        _opts: unknown,
        cb: (err: Error | null, data: unknown) => void,
      ) => {
        if (payload === null) cb(new Error("socket gone"), null);
        else cb(null, payload);
      },
    },
  } as unknown as ContainerClient;
}

function infoWith(uidmap: unknown): unknown {
  return { host: { idMappings: { uidmap } } };
}

describe("libpodSubordinateUidCount", () => {
  it("sums the subordinate entries, excluding the identity map", async () => {
    const client = clientReturning(
      infoWith([
        IDENTITY_ENTRY,
        { container_id: 1, host_id: 100000, size: FULL_SUBUID_WIDTH },
      ]),
    );
    assert.equal(await libpodSubordinateUidCount(client), FULL_SUBUID_WIDTH);
  });

  it("sums several subordinate blocks", async () => {
    const client = clientReturning(
      infoWith([
        IDENTITY_ENTRY,
        { container_id: 1, host_id: 100000, size: 200 },
        { container_id: 201, host_id: 200000, size: 100 },
      ]),
    );
    assert.equal(await libpodSubordinateUidCount(client), 300);
  });

  it("returns null when only the identity entry exists", async () => {
    // No subordinate range at all: there is no width to bound with, and
    // emitting `size=0` would produce the mapping the kernel refuses.
    const client = clientReturning(infoWith([IDENTITY_ENTRY]));
    assert.equal(await libpodSubordinateUidCount(client), null);
  });

  it("ignores fractional and negative sizes", async () => {
    // Podman parses `size` as a uint and rejects `size=1.5` outright; a
    // negative would shrink the total below what the account really has.
    const client = clientReturning(
      infoWith([
        IDENTITY_ENTRY,
        { container_id: 1, host_id: 100000, size: 1.5 },
        { container_id: 2, host_id: 200000, size: -5 },
        { container_id: 3, host_id: 300000, size: 200 },
      ]),
    );
    assert.equal(await libpodSubordinateUidCount(client), 200);
  });

  it("returns null on a malformed payload", async () => {
    for (const payload of [
      {},
      { host: {} },
      infoWith(null),
      infoWith("not-an-array"),
      "a string",
    ]) {
      assert.equal(
        await libpodSubordinateUidCount(clientReturning(payload)),
        null,
        `expected null for ${JSON.stringify(payload)}`,
      );
    }
  });

  it("returns null when the dial errors", async () => {
    assert.equal(await libpodSubordinateUidCount(clientReturning(null)), null);
  });

  it("returns null when the modem cannot dial", async () => {
    // Docker, and the test mocks that provide no `dial`.
    const client = { modem: {} } as unknown as ContainerClient;
    assert.equal(await libpodSubordinateUidCount(client), null);
  });
});
