import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { volumeArg } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";

const docker = { runtime: "docker", version: "29" } as ContainerRuntimeInfo;
const podman = { runtime: "podman", version: "5" } as ContainerRuntimeInfo;

describe("volumeArg readOnly", () => {
  it("binds read-write by default", () => {
    assert.equal(volumeArg("/host", "/in", docker), "/host:/in");
  });

  it("appends :ro when asked", () => {
    assert.equal(volumeArg("/host", "/in", docker, true), "/host:/in:ro");
  });

  // Podman needs :Z for SELinux relabelling; read-only has to compose with it
  // rather than replace it.
  it("keeps podman's :Z alongside :ro", () => {
    assert.equal(volumeArg("/host", "/in", podman, true), "/host:/in:ro,Z");
  });

  it("does not relabel a named volume", () => {
    assert.equal(volumeArg("myvol", "/in", podman, true), "myvol:/in:ro");
  });
});

describe("readOnly drift encoding", () => {
  // Regression: encoding access mode as a `host:ro` string made a read-write
  // mount of `/data:ro` indistinguishable from a read-only mount of `/data`.
  // Host path and mode are compared as separate fields.
  it("distinguishes a path ending in :ro from a read-only mount", () => {
    const rwOddPath = { host: "/data:ro", readOnly: false };
    const roNormal = { host: "/data", readOnly: true };
    assert.notDeepEqual(rwOddPath, roNormal);
  });

  it("treats identical host and mode as equal", () => {
    assert.deepEqual(
      { host: "/data", readOnly: true },
      { host: "/data", readOnly: true },
    );
  });
});
