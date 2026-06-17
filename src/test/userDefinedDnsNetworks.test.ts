import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userDefinedDnsNetworks } from "../containers.js";

describe("userDefinedDnsNetworks", () => {
  it("drops Docker's default bridge", () => {
    assert.deepEqual(userDefinedDnsNetworks(["bridge"]), []);
  });

  it("drops rootless Podman's default 'podman' network", () => {
    // Regression: 'podman' has DNS disabled but was previously kept, so the
    // resolver handed back a container-name address that could not resolve.
    assert.deepEqual(userDefinedDnsNetworks(["podman"]), []);
  });

  it("drops the host virtual mode", () => {
    assert.deepEqual(userDefinedDnsNetworks(["host"]), []);
  });

  it("drops the none virtual mode", () => {
    assert.deepEqual(userDefinedDnsNetworks(["none"]), []);
  });

  it("keeps a user-defined network", () => {
    assert.deepEqual(userDefinedDnsNetworks(["sk-network"]), ["sk-network"]);
  });

  it("keeps user-defined networks while dropping defaults", () => {
    assert.deepEqual(
      userDefinedDnsNetworks(["podman", "sk-network", "bridge", "my-net"]),
      ["sk-network", "my-net"],
    );
  });

  it("returns an empty array when only on default networks", () => {
    assert.deepEqual(userDefinedDnsNetworks(["bridge", "podman"]), []);
  });

  it("handles an empty input", () => {
    assert.deepEqual(userDefinedDnsNetworks([]), []);
  });
});
