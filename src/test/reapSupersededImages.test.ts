import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reapSupersededImages } from "../containers.js";
import type { ContainerRuntimeInfo, ManagedImageRef } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const REPO = "ghcr.io/dirkwa/signalk-backup-server";

function imageInfo(
  id: string,
  tag: string,
  extra: Partial<{ Created: number; Size: number; Containers: number }> = {},
) {
  return {
    Id: id,
    RepoTags: [`${REPO}:${tag}`],
    Created: extra.Created ?? 0,
    Size: extra.Size ?? 1024,
    Containers: extra.Containers ?? 0,
  };
}

const managed = (runningImageId: string | null): ManagedImageRef[] => [
  { image: REPO, runningImageId },
];

function notFound(msg: string): Error {
  const err = new Error(msg) as Error & { statusCode?: number };
  err.statusCode = 404;
  return err;
}

describe("reapSupersededImages", () => {
  it("removes exactly the superseded ids and reports the reclaim", async () => {
    const calls = new Map<string, unknown[]>();
    const result = await reapSupersededImages(
      podman,
      managed("id-0.6.7"),
      1,
      makeMockClient({
        calls,
        listImages: [
          imageInfo("id-0.6.5", "0.6.5", { Size: 2048 }),
          imageInfo("id-0.6.6", "0.6.6"),
          imageInfo("id-0.6.7", "0.6.7"),
        ],
      }),
    );

    // running 0.6.7 kept, keep 1 -> 0.6.6 kept, only 0.6.5 reaped.
    const removed = (calls.get("image.remove") ?? []).map(
      (c) => (c as { name: string }).name,
    );
    assert.deepEqual(removed, ["id-0.6.5"]);
    assert.equal(result.imagesRemoved, 1);
    assert.equal(result.spaceReclaimed, "2k");
  });

  it("returns a zero result and removes nothing when listImages fails", async () => {
    const calls = new Map<string, unknown[]>();
    const result = await reapSupersededImages(
      podman,
      managed("x"),
      1,
      makeMockClient({ calls, listImages: new Error("socket down") }),
    );

    assert.equal(result.imagesRemoved, 0);
    assert.equal(result.spaceReclaimed, "0b");
    assert.equal(calls.get("image.remove"), undefined);
  });

  it("counts a not-found removal as already-gone and continues", async () => {
    const calls = new Map<string, unknown[]>();
    const result = await reapSupersededImages(
      podman,
      managed("id-0.6.7"),
      0,
      makeMockClient({
        calls,
        listImages: [
          imageInfo("id-0.6.5", "0.6.5"),
          imageInfo("id-0.6.6", "0.6.6"),
          imageInfo("id-0.6.7", "0.6.7"),
        ],
        imageRemove: {
          "id-0.6.5": notFound("no such image id-0.6.5"),
        },
      }),
    );

    const removed = (calls.get("image.remove") ?? []).map(
      (c) => (c as { name: string }).name,
    );
    assert.deepEqual(removed.sort(), ["id-0.6.5", "id-0.6.6"]);
    assert.equal(result.imagesRemoved, 2);
  });

  it("skips an image that fails with a non-not-found error, reaping the rest", async () => {
    const calls = new Map<string, unknown[]>();
    const inUse = new Error("image is in use by a container") as Error & {
      statusCode?: number;
    };
    inUse.statusCode = 409;

    const result = await reapSupersededImages(
      podman,
      managed("id-0.6.7"),
      0,
      makeMockClient({
        calls,
        listImages: [
          imageInfo("id-0.6.5", "0.6.5"),
          imageInfo("id-0.6.6", "0.6.6"),
          imageInfo("id-0.6.7", "0.6.7"),
        ],
        imageRemove: {
          "id-0.6.5": inUse,
        },
      }),
    );

    // Both were attempted; only 0.6.6 succeeded.
    const removed = (calls.get("image.remove") ?? []).map(
      (c) => (c as { name: string }).name,
    );
    assert.deepEqual(removed.sort(), ["id-0.6.5", "id-0.6.6"]);
    assert.equal(result.imagesRemoved, 1);
  });

  it("matches a bare Docker Hub repo against its docker.io-qualified local tags on podman", async () => {
    const calls = new Map<string, unknown[]>();
    const hubRepo = "myuser/myimage";
    const result = await reapSupersededImages(
      podman,
      // Manifest stored the bare name; podman lists it as docker.io/...
      [{ image: hubRepo, runningImageId: "id-2.0.0" }],
      0,
      makeMockClient({
        calls,
        listImages: [
          {
            Id: "id-1.0.0",
            RepoTags: [`docker.io/${hubRepo}:1.0.0`],
            Created: 1,
            Size: 1024,
            Containers: 0,
          },
          {
            Id: "id-2.0.0",
            RepoTags: [`docker.io/${hubRepo}:2.0.0`],
            Created: 2,
            Size: 1024,
            Containers: 0,
          },
        ],
      }),
    );

    const removed = (calls.get("image.remove") ?? []).map(
      (c) => (c as { name: string }).name,
    );
    assert.deepEqual(removed, ["id-1.0.0"]);
    assert.equal(result.imagesRemoved, 1);
  });

  it("matches a bare official image against its docker.io/library/ tag on podman", async () => {
    const calls = new Map<string, unknown[]>();
    const result = await reapSupersededImages(
      podman,
      // manifest stored bare `alpine`; podman lists docker.io/library/alpine
      [{ image: "alpine", runningImageId: "id-3.19" }],
      0,
      makeMockClient({
        calls,
        listImages: [
          {
            Id: "id-3.18",
            RepoTags: ["docker.io/library/alpine:3.18"],
            Created: 1,
            Size: 1024,
            Containers: 0,
          },
          {
            Id: "id-3.19",
            RepoTags: ["docker.io/library/alpine:3.19"],
            Created: 2,
            Size: 1024,
            Containers: 0,
          },
        ],
      }),
    );

    const removed = (calls.get("image.remove") ?? []).map(
      (c) => (c as { name: string }).name,
    );
    assert.deepEqual(removed, ["id-3.18"]);
    assert.equal(result.imagesRemoved, 1);
  });

  it("removes nothing when keep retains every version", async () => {
    const calls = new Map<string, unknown[]>();
    const result = await reapSupersededImages(
      podman,
      managed("id-0.6.7"),
      5,
      makeMockClient({
        calls,
        listImages: [
          imageInfo("id-0.6.5", "0.6.5"),
          imageInfo("id-0.6.6", "0.6.6"),
          imageInfo("id-0.6.7", "0.6.7"),
        ],
      }),
    );

    assert.equal(calls.get("image.remove"), undefined);
    assert.equal(result.imagesRemoved, 0);
  });
});
