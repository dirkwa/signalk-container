import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRepoDigest } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const DIGEST = "sha256:" + "a".repeat(64);

describe("getRepoDigest", () => {
  it("returns the digest portion of a single RepoDigest entry", async () => {
    const result = await getRepoDigest(
      podman,
      "questdb/questdb:9.0.0",
      makeMockClient({
        images: {
          "docker.io/questdb/questdb:9.0.0": {
            RepoDigests: [`questdb/questdb@${DIGEST}`],
          },
        },
      }),
    );
    assert.equal(result, DIGEST);
  });

  it("returns null when the image has no RepoDigests", async () => {
    const result = await getRepoDigest(
      podman,
      "local-build:dev",
      makeMockClient({
        images: {
          "docker.io/local-build:dev": { RepoDigests: [] },
        },
      }),
    );
    assert.equal(result, null);
  });

  it("returns null when the image is missing", async () => {
    const result = await getRepoDigest(
      podman,
      "missing:tag",
      makeMockClient({ images: {} }),
    );
    assert.equal(result, null);
  });

  it("returns null when the RepoDigest has no @ separator", async () => {
    const result = await getRepoDigest(
      podman,
      "weird:tag",
      makeMockClient({
        images: {
          "docker.io/weird:tag": { RepoDigests: ["no-at-sign-here"] },
        },
      }),
    );
    assert.equal(result, null);
  });

  it("returns null when the digest format is invalid", async () => {
    const result = await getRepoDigest(
      podman,
      "weird:tag",
      makeMockClient({
        images: {
          "docker.io/weird:tag": { RepoDigests: ["repo@sha256:notenoughhex"] },
        },
      }),
    );
    assert.equal(result, null);
  });
});
