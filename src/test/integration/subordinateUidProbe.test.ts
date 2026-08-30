import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectRuntime,
  supportsKeepIdSize,
  userMappingFlags,
} from "../../runtime.js";
import { getClient } from "../../client.js";
import type { ContainerRuntimeInfo } from "../../types.js";

/**
 * `detectRuntime` has no injectable client seam — it resolves its own
 * socket — so the subuid probe's wiring can only be checked against a real
 * daemon. The helper's own parsing is unit-tested in
 * `libpodSubordinateUidCount.test.ts`; what this covers is that
 * `detectRuntime` actually runs it, and only where it makes sense.
 */

const IMAGE = "alpine";
const TAG = "3.19";
const CONTAINER_NAME = "subuid-probe-test";

/** Docker log-frame header: 1 stream byte, 3 reserved, then a big-endian length. */
const FRAME_HEADER_BYTES = 8;
const FRAME_LENGTH_OFFSET = 4;

/** Strip the per-frame stream headers docker/podman prefix log output with. */
function demuxFrames(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i + FRAME_HEADER_BYTES <= buf.length) {
    // Length is per frame, so read it at the frame's own offset — reading
    // from the head of the buffer truncates every frame after the first
    // whenever their lengths differ.
    const len = buf.readUInt32BE(i + FRAME_LENGTH_OFFSET);
    const start = i + FRAME_HEADER_BYTES;
    out += buf.subarray(start, start + len).toString("utf8");
    i = start + len;
  }
  return out;
}

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

describe("detectRuntime — subordinate uid probe", () => {
  it("reports a usable width on rootless podman, null elsewhere", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const width = runtime.subordinateUidCount;

    // Rootless podman older than 5.4 runs containers fine but cannot take
    // `keep-id:size=`, so the probe is deliberately skipped there too.
    if (
      runtime.runtime === "podman" &&
      runtime.isRootless === true &&
      supportsKeepIdSize(runtime.version)
    ) {
      // A rootless account without a subordinate range cannot run
      // containers at all, so a reachable rootless daemon must report one.
      assert.equal(
        typeof width,
        "number",
        `rootless podman should report a width, got ${width}`,
      );
      assert.ok(
        Number.isSafeInteger(width) && (width as number) > 0,
        `width must be a positive safe integer, got ${width}`,
      );
    } else {
      // Docker and rootful podman do not use keep-id, so the probe is
      // skipped rather than run and discarded.
      assert.equal(
        width ?? null,
        null,
        `${runtime.runtime} ${runtime.version} (rootless=${runtime.isRootless}) should not probe`,
      );
    }
  });

  it("produces a mapping the daemon accepts and applies", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    if (
      runtime.runtime !== "podman" ||
      runtime.isRootless !== true ||
      runtime.subordinateUidCount == null
    ) {
      t.skip("keep-id sizing only applies to rootless podman 5.4+");
      return;
    }

    // Arithmetic that merely looks plausible still fails at create time, so
    // run the flag the plugin would actually emit and read the map back
    // from inside the container.
    const flags = userMappingFlags(runtime, { inImageUid: 0, inImageGid: 0 });
    const usernsMode = flags.HostConfig?.UsernsMode;
    assert.ok(
      usernsMode?.includes(`size=${runtime.subordinateUidCount}`),
      `expected a size-bounded keep-id, got ${usernsMode}`,
    );

    const container = await getClient().createContainer({
      Image: `${IMAGE}:${TAG}`,
      name: CONTAINER_NAME,
      Cmd: ["cat", "/proc/self/uid_map"],
      HostConfig: { UsernsMode: usernsMode, AutoRemove: false },
    });
    try {
      await container.start();
      await container.wait();
      const logs = (await container.logs({
        stdout: true,
        stderr: false,
      })) as unknown as Buffer;
      // Log frames carry an 8-byte multiplex header each; strip them rather
      // than parse around them, or the first field of every line is
      // corrupted.
      const uidMap = demuxFrames(logs);

      // The bound has to reach the kernel, not just the command line: the
      // subordinate entry must be the width asked for, never 0 — a
      // zero-length entry is what the kernel refuses outright.
      const subordinate = uidMap
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length === 3 && p[0] !== "0");
      assert.ok(
        subordinate.length > 0,
        `no subordinate entry in uid_map: ${JSON.stringify(uidMap)}`,
      );
      for (const [, , length] of subordinate) {
        assert.ok(
          Number(length) > 0,
          `zero-length mapping entry, the failure this guards: ${uidMap}`,
        );
      }
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  });
});
