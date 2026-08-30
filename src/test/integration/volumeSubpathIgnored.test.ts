import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import { resolveClient } from "../../client.js";
import { detectRuntime } from "../../runtime.js";
import type { ContainerRuntimeInfo } from "../../types.js";

/**
 * Pins the premise behind `assertVolumeIsNotBroaderThanRequested`.
 *
 * Podman's CLI supports `--mount type=volume,...,subpath=`, and its release
 * notes say so. The Docker-compat `/containers/create` endpoint this plugin
 * posts to through dockerode accepts `VolumeOptions.Subpath`, returns 201,
 * and ignores it. Reading the changelog instead of measuring the endpoint is
 * how a false claim ("named volumes cannot be subpath-mounted") reached an
 * operator-facing error message.
 *
 * If a future runtime honours it here, this test fails — and the refusal can
 * be replaced with an actual narrowed mount. That is the outcome to want, so
 * the failure must be loud rather than a silently-skipped assertion.
 */

const IMAGE = "alpine";
const TAG = "3.19";
const VOLUME = "sk-subpath-probe-vol";
const SEED = "sk-subpath-probe-seed";
const PROBE = "sk-subpath-probe-read";
const FRAME_HEADER_BYTES = 8;
const FRAME_LENGTH_OFFSET = 4;

function demuxFrames(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i + FRAME_HEADER_BYTES <= buf.length) {
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

/** Run `ls /y` against the volume and return what the container saw. */
async function listMount(
  docker: Docker,
  name: string,
  volumeOptions?: { Subpath: string },
): Promise<string> {
  // dockerode's MountSettings type predates VolumeOptions.Subpath — the
  // field goes on the wire regardless, which is the whole point of the probe.
  const container = await docker.createContainer({
    Image: `${IMAGE}:${TAG}`,
    name,
    Cmd: ["ls", "/y"],
    HostConfig: {
      Mounts: [
        {
          Type: "volume",
          Source: VOLUME,
          Target: "/y",
          ...(volumeOptions ? { VolumeOptions: volumeOptions } : {}),
        },
      ],
    },
  } as unknown as Parameters<Docker["createContainer"]>[0]);
  try {
    await container.start();
    await container.wait();
    const logs = (await container.logs({
      stdout: true,
      stderr: false,
    })) as unknown as Buffer;
    return demuxFrames(logs).trim();
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

describe("compat API — volume subpath", () => {
  it("is accepted and ignored, so a volume always arrives whole", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    // ContainerClient is deliberately narrowed and exposes no volume API,
    // so this reaches for dockerode directly rather than widening it.
    const resolved = await resolveClient();
    if (!resolved) {
      t.skip("no container runtime available");
      return;
    }
    // resolveClient types its client as the narrowed ContainerClient, which
    // exposes no volume API; the instance behind it is a real Docker.
    const docker = resolved.client as unknown as Docker;
    await docker
      .getVolume(VOLUME)
      .remove({ force: true })
      .catch(() => {});
    await docker.createVolume({ Name: VOLUME });

    try {
      // Seed a volume with a file at its root and one in a subdirectory, so
      // "whole volume" and "subpath only" produce different listings.
      const seed = await docker.createContainer({
        Image: `${IMAGE}:${TAG}`,
        name: SEED,
        Cmd: ["sh", "-c", "mkdir -p /y/sub && touch /y/root-file /y/sub/inner"],
        HostConfig: {
          Mounts: [{ Type: "volume", Source: VOLUME, Target: "/y" }],
        },
      });
      await seed.start();
      await seed.wait();
      await seed.remove({ force: true }).catch(() => {});

      const withSubpath = await listMount(docker, PROBE, { Subpath: "sub" });

      // The subpath asked for `sub`, whose only entry is `inner`. Seeing the
      // volume root instead is the silent discard this guards.
      assert.ok(
        withSubpath.includes("root-file"),
        `compat API appears to HONOUR VolumeOptions.Subpath now (saw ${JSON.stringify(
          withSubpath,
        )}). If so, resolveSignalkDataSource can narrow a parent-backed volume ` +
          `instead of refusing it — revisit assertVolumeIsNotBroaderThanRequested.`,
      );
      assert.ok(
        !withSubpath.includes("inner") || withSubpath.includes("sub"),
        `unexpected listing ${JSON.stringify(withSubpath)}`,
      );
    } finally {
      await docker
        .getVolume(VOLUME)
        .remove({ force: true })
        .catch(() => {});
    }
  });
});
