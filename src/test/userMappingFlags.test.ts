import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userMappingFlags } from "../jobs.js";
import {
  isDisableUserns,
  setDisableUserns,
  supportsKeepIdSize,
} from "../runtime.js";
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
    assert.deepEqual(userMappingFlags(dockerRuntime, undefined, linuxIds), {
      User: "1000:1000",
    });
  });

  it("emits --userns=keep-id with in-image UID 0 on rootless Podman by default", () => {
    // Default in-image UID is 0 (matches osgeo/gdal and legacy
    // tippecanoe image, both root-by-default).  --userns=keep-id maps
    // that 0 back to the host caller's UID via the user-namespace.
    assert.deepEqual(
      userMappingFlags(podmanRootlessRuntime, undefined, linuxIds),
      { HostConfig: { UsernsMode: "keep-id:uid=0,gid=0" } },
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
      { HostConfig: { UsernsMode: "keep-id:uid=1001,gid=1001" } },
    );
  });

  it("emits --user form for rootful Podman (keep-id would error there)", () => {
    // Rootful Podman erroring on --userns=keep-id is the whole reason
    // this branch exists.  Verify the rootful case picks --user — and,
    // since the caller declared an in-image UID, the override targets
    // that UID rather than the host caller's.  No namespace remap is
    // available on this branch, so this is a direct process-UID set.
    assert.deepEqual(
      userMappingFlags(
        podmanRootfulRuntime,
        { inImageUid: 1001, inImageGid: 1001 },
        linuxIds,
      ),
      { User: "1001:1001" },
    );
  });

  it("emits --user with the declared in-image UID on Docker for non-root images", () => {
    // Docker has no user-namespace remap available via `--user`, so
    // when the caller declares an in-image UID we honour it as a
    // direct process-UID override. Host fixture is uid 2000 to prove
    // we're using the declared 1000, not the host caller's UID.
    const otherHost = (): { uid: number; gid: number } => ({
      uid: 2000,
      gid: 2000,
    });
    assert.deepEqual(
      userMappingFlags(
        dockerRuntime,
        { inImageUid: 1000, inImageGid: 1000 },
        otherHost,
      ),
      { User: "1000:1000" },
    );
  });

  it("emits --user with the declared in-image UID on rootful Podman for non-root images", () => {
    // Same shape as the Docker case — different runtime, same branch
    // in userMappingFlags.
    const otherHost = (): { uid: number; gid: number } => ({
      uid: 2000,
      gid: 2000,
    });
    assert.deepEqual(
      userMappingFlags(
        podmanRootfulRuntime,
        { inImageUid: 1000, inImageGid: 1000 },
        otherHost,
      ),
      { User: "1000:1000" },
    );
  });

  it("treats Podman with isRootless=null as not rootless (conservative default)", () => {
    // Older Podman versions whose `info` output we couldn't parse
    // get isRootless=null.  Treat as rootful so we don't emit the
    // keep-id flag and trip the "only supported in rootless mode"
    // hard error.
    assert.deepEqual(
      userMappingFlags(podmanUnknownRuntime, undefined, linuxIds),
      { User: "1000:1000" },
    );
  });

  it("emits no flags when host UID resolver returns null (Windows)", () => {
    // process.getuid is undefined on Windows.  Docker Desktop handles
    // UID translation internally; we don't try to compete.
    assert.deepEqual(userMappingFlags(dockerRuntime, undefined, noIds), {});
    assert.deepEqual(
      userMappingFlags(podmanRootlessRuntime, undefined, noIds),
      {},
    );
  });

  it("emits no flags when caller passes user: false (opt out)", () => {
    // Debug / test-only path — disables UID alignment entirely.  The
    // in-container process runs as whatever the image's USER says,
    // and bind-mount writes land owned by whatever that maps to.
    assert.deepEqual(userMappingFlags(dockerRuntime, false, linuxIds), {});
    assert.deepEqual(
      userMappingFlags(podmanRootlessRuntime, false, linuxIds),
      {},
    );
  });

  it("uses inImageUid alone when inImageGid is omitted (defaults to 0)", () => {
    // The caller can declare just the UID and let GID default.  Less
    // common but should work — `keep-id:uid=N` (no gid=) on rootless
    // Podman; GID defaults to 0.
    assert.deepEqual(
      userMappingFlags(podmanRootlessRuntime, { inImageUid: 1001 }, linuxIds),
      { HostConfig: { UsernsMode: "keep-id:uid=1001,gid=0" } },
    );
  });

  it("respects the host UID resolver — different UIDs produce different flags", () => {
    const root = () => ({ uid: 0, gid: 0 });
    assert.deepEqual(userMappingFlags(dockerRuntime, undefined, root), {
      User: "0:0",
    });
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

  describe("disableUserNamespaceRemap toggle", () => {
    // The toggle is a module-level switch driven by the plugin config
    // (`disableUserNamespaceRemap`). Tests below set it on entry and
    // restore the historical default on exit so unrelated suites that
    // also exercise `userMappingFlags` stay deterministic.

    it("suppresses --userns=keep-id on rootless podman", () => {
      // Reproduces the ZFS workaround path. With the toggle active,
      // rootless podman emits no userns flag — the container runs in
      // the default rootless userns, in-image UID 0 → host caller's
      // UID via the implicit mapping.
      setDisableUserns(true);
      try {
        assert.deepEqual(
          userMappingFlags(podmanRootlessRuntime, undefined, linuxIds),
          {},
        );
      } finally {
        setDisableUserns(false);
      }
    });

    it("still suppresses the flag when the caller declared a non-root in-image UID", () => {
      // Non-root images (charts-toolbox at UID 1001) lose host-caller
      // ownership on bind mounts under this branch — but starting at
      // all beats clean ownership on a filesystem the kernel cannot
      // id-map.
      setDisableUserns(true);
      try {
        assert.deepEqual(
          userMappingFlags(
            podmanRootlessRuntime,
            { inImageUid: 1001, inImageGid: 1001 },
            linuxIds,
          ),
          {},
        );
      } finally {
        setDisableUserns(false);
      }
    });

    it("does not change the rootful-podman branch", () => {
      // Rootful podman already used `--user`, never `--userns=keep-id`.
      // The toggle is a no-op there.
      setDisableUserns(true);
      try {
        assert.deepEqual(
          userMappingFlags(podmanRootfulRuntime, undefined, linuxIds),
          { User: "1000:1000" },
        );
      } finally {
        setDisableUserns(false);
      }
    });

    it("does not change the docker branch", () => {
      // Docker is unaffected regardless of the toggle.
      setDisableUserns(true);
      try {
        assert.deepEqual(userMappingFlags(dockerRuntime, undefined, linuxIds), {
          User: "1000:1000",
        });
      } finally {
        setDisableUserns(false);
      }
    });

    it("still honours the per-call user: false opt-out", () => {
      setDisableUserns(true);
      try {
        assert.deepEqual(
          userMappingFlags(podmanRootlessRuntime, false, linuxIds),
          {},
        );
      } finally {
        setDisableUserns(false);
      }
    });

    it("restores keep-id when the toggle is flipped back off", () => {
      // start() → stop() → start() cycle must not strand a previous
      // run's toggle. Sanity-check the after-restore behaviour, with
      // a try/finally guard so a failed assertion leaves the toggle
      // in the historical default for downstream suites.
      setDisableUserns(true);
      try {
        setDisableUserns(false);
        assert.deepEqual(
          userMappingFlags(podmanRootlessRuntime, undefined, linuxIds),
          { HostConfig: { UsernsMode: "keep-id:uid=0,gid=0" } },
        );
      } finally {
        setDisableUserns(false);
      }
    });

    it("models a plugin start/stop/start lifecycle without state leak", () => {
      // The plugin wrapper does:
      //   start(config)  → setDisableUserns(config.disableUserNamespaceRemap === true)
      //   stop()         → setDisableUserns(false)
      // This test exercises the toggle directly the same way to lock
      // in the invariant: stop() always clears the previous run's
      // setting before a new start() reads from a fresh config.
      assert.equal(isDisableUserns(), false, "default state is false");

      setDisableUserns(true);
      try {
        assert.equal(isDisableUserns(), true);
        assert.deepEqual(
          userMappingFlags(podmanRootlessRuntime, undefined, linuxIds),
          {},
          "rootless podman emits no userns flag while toggle is on",
        );

        // stop() clears.
        setDisableUserns(false);
        assert.equal(isDisableUserns(), false);

        // Second start, this time with the flag off (the historical
        // default). Must NOT inherit the previous run's "true".
        assert.deepEqual(
          userMappingFlags(podmanRootlessRuntime, undefined, linuxIds),
          { HostConfig: { UsernsMode: "keep-id:uid=0,gid=0" } },
          "second start with default config restores keep-id",
        );
      } finally {
        setDisableUserns(false);
      }
    });
  });
});

/** A full /etc/subuid allocation — the width `keep-id` assumes by default. */
const FULL_SUBUID_WIDTH = 65536;
/** Narrower than keep-id's default request; the case that triggers the clamp. */
const NARROW_SUBUID_WIDTH = 300;
/** Widths the kernel would refuse, so no `size=` should be emitted for them. */
const UNUSABLE_SUBUID_WIDTHS = [0, -1];
/** In-image uid/gid for an image that declares a non-root USER. */
const NON_ROOT_IN_IMAGE_ID = 1000;

describe("userMappingFlags — subordinate range bound", () => {
  // `keep-id:uid=N` asks podman for a 65536-wide subordinate block. An
  // account whose /etc/subuid allocation is narrower makes podman clamp the
  // mapping length, and at the limit clamp it to zero — which the kernel
  // rejects with `writing file /proc/<pid>/gid_map: Invalid argument`.
  it("bounds the request to the width podman reports", () => {
    assert.deepEqual(
      userMappingFlags(
        { ...podmanRootlessRuntime, subordinateUidCount: NARROW_SUBUID_WIDTH },
        undefined,
        linuxIds,
      ),
      {
        HostConfig: {
          UsernsMode: `keep-id:size=${NARROW_SUBUID_WIDTH},uid=0,gid=0`,
        },
      },
    );
  });

  it("omits the bound when the width is unknown", () => {
    // Docker, an older podman, or a failed probe. Asking without a size is
    // the long-standing behaviour and must stay the fallback.
    assert.deepEqual(
      userMappingFlags(
        { ...podmanRootlessRuntime, subordinateUidCount: null },
        undefined,
        linuxIds,
      ),
      { HostConfig: { UsernsMode: "keep-id:uid=0,gid=0" } },
    );
  });

  it("omits the bound for a nonsensical width", () => {
    // A zero or negative width is what the kernel refuses; asking without a
    // size at least lets podman decide rather than emitting `size=0`.
    for (const subordinateUidCount of UNUSABLE_SUBUID_WIDTHS) {
      assert.deepEqual(
        userMappingFlags(
          { ...podmanRootlessRuntime, subordinateUidCount },
          undefined,
          linuxIds,
        ),
        { HostConfig: { UsernsMode: "keep-id:uid=0,gid=0" } },
        `width ${subordinateUidCount} should not produce a size bound`,
      );
    }
  });

  it("keeps the in-image uid alongside the bound", () => {
    assert.deepEqual(
      userMappingFlags(
        { ...podmanRootlessRuntime, subordinateUidCount: FULL_SUBUID_WIDTH },
        { inImageUid: NON_ROOT_IN_IMAGE_ID, inImageGid: NON_ROOT_IN_IMAGE_ID },
        linuxIds,
      ),
      {
        HostConfig: {
          UsernsMode: `keep-id:size=${FULL_SUBUID_WIDTH},uid=${NON_ROOT_IN_IMAGE_ID},gid=${NON_ROOT_IN_IMAGE_ID}`,
        },
      },
    );
  });
});

describe("supportsKeepIdSize", () => {
  // `keep-id:size=` landed in Podman 5.4.0 (containers/podman#24387).
  // Emitting it on 5.3 breaks container creation on an install that works,
  // so the gate has to fail closed.
  it("accepts 5.4 and newer", () => {
    for (const v of ["5.4.0", "5.4.2", "5.5.0", "6.0.0", "5.4.2-dev"]) {
      assert.equal(supportsKeepIdSize(v), true, v);
    }
  });

  it("rejects anything older", () => {
    for (const v of ["5.3.0", "5.3.9", "4.9.4", "3.0.0"]) {
      assert.equal(supportsKeepIdSize(v), false, v);
    }
  });

  it("rejects an absent or unparseable version", () => {
    // Going without the bound is the long-standing behaviour; guessing
    // would risk breaking creation outright.
    for (const v of [null, "", "unknown", "v5.4.2"]) {
      assert.equal(supportsKeepIdSize(v), false, JSON.stringify(v));
    }
  });
});
