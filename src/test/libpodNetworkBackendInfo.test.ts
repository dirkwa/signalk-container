import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { libpodNetworkBackendInfo, type ContainerClient } from "../client.js";
import { makeMockClient } from "./helpers/mockClient.js";

/**
 * Wrap a mock client with a modem whose `dial` answers the libpod info
 * request with `payload` (or an error). The real docker-modem parses the
 * response body to an object before invoking the callback, so the fake
 * hands over the parsed shape directly.
 */
function clientWithDial(
  payload: unknown,
  err: Error | null = null,
): ContainerClient {
  const base = makeMockClient();
  return {
    ...base,
    modem: {
      ...base.modem,
      dial: (
        _options: {
          path: string;
          method: string;
          statusCodes: Record<number, boolean | string>;
        },
        callback: (err: Error | null, data: unknown) => void,
      ) => callback(err, payload),
    },
  } as ContainerClient;
}

describe("libpodNetworkBackendInfo", () => {
  it("extracts host.networkBackendInfo from the libpod payload", async () => {
    const info = await libpodNetworkBackendInfo(
      clientWithDial({
        host: {
          networkBackendInfo: {
            backend: "netavark",
            dns: { path: "/usr/lib/podman/aardvark-dns" },
          },
        },
      }),
    );
    assert.deepEqual(info, {
      backend: "netavark",
      dns: { path: "/usr/lib/podman/aardvark-dns" },
    });
  });

  it("returns null when the payload lacks networkBackendInfo", async () => {
    assert.equal(
      await libpodNetworkBackendInfo(clientWithDial({ host: {} })),
      null,
    );
  });

  it("returns null on a dial error (Docker answers 404 here)", async () => {
    assert.equal(
      await libpodNetworkBackendInfo(
        clientWithDial(null, new Error("HTTP code 404")),
      ),
      null,
    );
  });

  it("returns null when the modem has no dial (test mocks)", async () => {
    assert.equal(await libpodNetworkBackendInfo(makeMockClient()), null);
  });

  it("returns null on a success callback with a null payload", async () => {
    assert.equal(await libpodNetworkBackendInfo(clientWithDial(null)), null);
  });

  it("returns null on a success callback with a non-object payload", async () => {
    assert.equal(
      await libpodNetworkBackendInfo(clientWithDial("garbage")),
      null,
    );
  });

  it("returns null when dial throws synchronously", async () => {
    const base = makeMockClient();
    const client = {
      ...base,
      modem: {
        ...base.modem,
        dial: () => {
          throw new Error("modem exploded");
        },
      },
    } as ContainerClient;
    assert.equal(await libpodNetworkBackendInfo(client), null);
  });
});
