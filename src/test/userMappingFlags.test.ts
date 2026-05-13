import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userMappingFlags } from "../jobs.js";
import type { ContainerRuntimeInfo } from "../types.js";

const dockerRuntime: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isRootless: false,
};

const podmanRootlessRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
};

const podmanRootfulRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: false,
};

const podmanUnknownRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "3.0.0",
  isPodmanDockerShim: false,
  isRootless: null,
};

const linuxIds = (): { uid: number; gid: number } => ({ uid: 1000, gid: 1000 });
const noIds = () => null;

describe("userMappingFlags", () => {
  it("emits --user host:host on Docker by default (assumes in-image root)", () => {
    assert.deepEqual(userMappingFlags(dockerRuntime, undefined, linuxIds), [
      "--user",
      "1000:1000",
    ]);
  });

  it("emits --userns=keep-id with in-image UID 0 on rootless Podman by default", () => {
    // Default in-image UID is 0 (matches osgeo/gdal and legacy
    // tippecanoe image, both root-by-default).  --userns=keep-id maps
    // that 0 back to the host caller's UID via the user-namespace.
    assert.deepEqual(
      userMappingFlags(podmanRootlessRuntime, undefined, linuxIds),
      ["--userns", "keep-id:uid=0,gid=0"],
    );
  });

  it("emits --userns=keep-id with the caller-declared in-image UID for non-root images", () => {
    // The new charts-toolbox image runs as USER toolbox (UID 1001) —
    // the caller declares that and the flag maps 1001 → host UID.
    assert.deepEqual(
      userMappingFlags(
        podmanRootlessRuntime,
        { inImageUid: 1001, inImageGid: 1001 },
        linuxIds,
      ),
      ["--userns", "keep-id:uid=1001,gid=1001"],
    );
  });

  it("emits --user form for rootful Podman (keep-id would error there)", () => {
    // Rootful Podman erroring on --userns=keep-id is the whole reason
    // this branch exists.  Verify the rootful case picks --user
    // regardless of whether the caller declared an in-image UID.
    assert.deepEqual(
      userMappingFlags(
        podmanRootfulRuntime,
        { inImageUid: 1001, inImageGid: 1001 },
        linuxIds,
      ),
      ["--user", "1000:1000"],
    );
  });

  it("treats Podman with isRootless=null as not rootless (conservative default)", () => {
    // Older Podman versions whose `info` output we couldn't parse
    // get isRootless=null.  Treat as rootful so we don't emit the
    // keep-id flag and trip the "only supported in rootless mode"
    // hard error.
    assert.deepEqual(
      userMappingFlags(podmanUnknownRuntime, undefined, linuxIds),
      ["--user", "1000:1000"],
    );
  });

  it("emits no flags when host UID resolver returns null (Windows)", () => {
    // process.getuid is undefined on Windows.  Docker Desktop handles
    // UID translation internally; we don't try to compete.
    assert.deepEqual(userMappingFlags(dockerRuntime, undefined, noIds), []);
    assert.deepEqual(
      userMappingFlags(podmanRootlessRuntime, undefined, noIds),
      [],
    );
  });

  it("emits no flags when caller passes user: false (opt out)", () => {
    // Debug / test-only path — disables UID alignment entirely.  The
    // in-container process runs as whatever the image's USER says,
    // and bind-mount writes land owned by whatever that maps to.
    assert.deepEqual(userMappingFlags(dockerRuntime, false, linuxIds), []);
    assert.deepEqual(
      userMappingFlags(podmanRootlessRuntime, false, linuxIds),
      [],
    );
  });

  it("uses inImageUid alone when inImageGid is omitted (defaults to 0)", () => {
    // The caller can declare just the UID and let GID default.  Less
    // common but should work — `keep-id:uid=N` (no gid=) on rootless
    // Podman; GID defaults to 0.
    assert.deepEqual(
      userMappingFlags(podmanRootlessRuntime, { inImageUid: 1001 }, linuxIds),
      ["--userns", "keep-id:uid=1001,gid=0"],
    );
  });

  it("respects the host UID resolver — different UIDs produce different flags", () => {
    const root = () => ({ uid: 0, gid: 0 });
    assert.deepEqual(userMappingFlags(dockerRuntime, undefined, root), [
      "--user",
      "0:0",
    ]);
  });

  describe("input validation", () => {
    // The TS shape says `number` but a plain-JS caller (or a future
    // refactor that lets a string slip through) can still pass
    // garbage.  Emitting `--userns=keep-id:uid=NaN,gid=-1` would let
    // the runtime fail far from the call site with an obscure
    // message; we throw at flag-build time with a clear pointer to
    // the offending field.
    it("throws on a negative inImageUid", () => {
      assert.throws(
        () =>
          userMappingFlags(podmanRootlessRuntime, { inImageUid: -1 }, linuxIds),
        /inImageUid must be a non-negative integer, got -1/,
      );
    });

    it("throws on a negative inImageGid", () => {
      assert.throws(
        () =>
          userMappingFlags(
            podmanRootlessRuntime,
            { inImageUid: 1001, inImageGid: -42 },
            linuxIds,
          ),
        /inImageGid must be a non-negative integer, got -42/,
      );
    });

    it("throws on a non-integer inImageUid", () => {
      assert.throws(
        () =>
          userMappingFlags(
            podmanRootlessRuntime,
            { inImageUid: 1.5 },
            linuxIds,
          ),
        /inImageUid must be a non-negative integer, got 1.5/,
      );
    });

    it("throws on NaN", () => {
      assert.throws(
        () =>
          userMappingFlags(dockerRuntime, { inImageUid: Number.NaN }, linuxIds),
        /inImageUid must be a non-negative integer, got NaN/,
      );
    });

    it("throws on Infinity", () => {
      assert.throws(
        () =>
          userMappingFlags(
            dockerRuntime,
            { inImageUid: Number.POSITIVE_INFINITY },
            linuxIds,
          ),
        /inImageUid must be a non-negative integer, got Infinity/,
      );
    });
  });
});
