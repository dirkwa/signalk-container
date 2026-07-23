import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qualifyImage } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

const HEX64 = "a".repeat(64);

describe("qualifyImage", () => {
  it("docker passes everything through unchanged", () => {
    assert.equal(qualifyImage("alpine:3.19", docker), "alpine:3.19");
    assert.equal(
      qualifyImage(`alpine@sha256:${HEX64}`, docker),
      `alpine@sha256:${HEX64}`,
    );
    assert.equal(qualifyImage(`sha256:${HEX64}`, docker), `sha256:${HEX64}`);
  });

  it("podman prefixes docker.io/ for short repo names", () => {
    assert.equal(
      qualifyImage("questdb/questdb:9.0.0", podman),
      "docker.io/questdb/questdb:9.0.0",
    );
  });

  it("podman canonicalizes single-name repos into library/", () => {
    // Podman reports `alpine` as `docker.io/library/alpine` in
    // `Config.Image`; emitting anything else here would look like
    // image drift on every ensureRunning call.
    assert.equal(qualifyImage("alpine", podman), "docker.io/library/alpine");
    assert.equal(
      qualifyImage("alpine:latest", podman),
      "docker.io/library/alpine:latest",
    );
  });

  it("podman does not mistake a dotted tag for a registry host", () => {
    // The dot in `3.19` sits in the tag, not a registry component; the
    // ref must still be qualified (and library-namespaced).
    assert.equal(
      qualifyImage("alpine:3.19", podman),
      "docker.io/library/alpine:3.19",
    );
  });

  it("podman leaves fully-qualified refs alone", () => {
    assert.equal(
      qualifyImage("ghcr.io/foo/bar:latest", podman),
      "ghcr.io/foo/bar:latest",
    );
    assert.equal(
      qualifyImage("localhost:5000/foo:tag", podman),
      "localhost:5000/foo:tag",
    );
    assert.equal(qualifyImage("localhost/foo", podman), "localhost/foo");
  });

  it("podman handles digest refs on unqualified short names (the @sha256 colon is not a port)", () => {
    assert.equal(
      qualifyImage(`alpine@sha256:${HEX64}`, podman),
      `docker.io/library/alpine@sha256:${HEX64}`,
    );
    assert.equal(
      qualifyImage(`questdb/questdb@sha256:${HEX64}`, podman),
      `docker.io/questdb/questdb@sha256:${HEX64}`,
    );
  });

  it("podman does NOT prefix bare image ids (sha256:<hex> or <hex>)", () => {
    // Content-addressed; never needs a registry.
    assert.equal(qualifyImage(`sha256:${HEX64}`, podman), `sha256:${HEX64}`);
    assert.equal(qualifyImage(HEX64, podman), HEX64);
  });
});
