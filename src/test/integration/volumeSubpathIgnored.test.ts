import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Docker from "dockerode";
import { resolveClient } from "../../client.js";
import { pullImage } from "../../containers.js";
import { detectRuntime, honoursVolumeSubpath } from "../../runtime.js";
import type { ContainerRuntimeInfo } from "../../types.js";

/**
 * Pins the premise behind `assertVolumeIsNotBroaderThanRequested`.
 *
 * Podman's CLI supports `--mount type=volume,...,subpath=`, and its release
 * notes say so. The Docker-compat `/containers/create` endpoint this plugin
 * posts to through dockerode accepts `VolumeOptions.Subpath`, returns 201,
 * and ignores it. A runtime's changelog describes its CLI, not this
 * endpoint, so the capability has to be measured rather than read.
 *
 * **Podman only.** Docker Engine honours the field on its own API (measured
 * on 29.7.2 / API 1.55), so asserting a discard there would fail on a correct
 * daemon.
 *
 * Podman's own answer is version-dependent — ignored on 5.4.2, honoured on
 * 6.1.0 — so this asserts whichever behaviour the running version is expected
 * to show rather than skipping. Either way the plugin sends no subpath, so
 * `assertVolumeIsNotBroaderThanRequested` stays correct; what a change here
 * would mean is that narrowing has become *possible*, and the refusal could
 * become a real narrowed mount on new enough podman.
 */

const IMAGE = "alpine";
const TAG = "3.19";
const VOLUME = "sk-subpath-probe-vol";
const SEED = "sk-subpath-probe-seed";
const PROBE = "sk-subpath-probe-read";
const FRAME_HEADER_BYTES = 8;
const FRAME_LENGTH_OFFSET = 4;

type CreateOptions = Parameters<Docker["createContainer"]>[0];
type MountSettings = NonNullable<
  NonNullable<CreateOptions["HostConfig"]>["Mounts"]
>[number];
type VolumeOptions = NonNullable<MountSettings["VolumeOptions"]>;

/**
 * dockerode types `Subpath` as optional but its siblings as required, so the
 * probe supplies their neutral values rather than casting past the type and
 * losing every other check on the payload.
 */
function volumeOptionsWithSubpath(subpath: string): VolumeOptions {
  return {
    NoCopy: false,
    Labels: {},
    DriverConfig: { Name: "", Options: {} },
    Subpath: subpath,
  };
}

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
  subpath?: string,
): Promise<string> {
  const mount: MountSettings = {
    Type: "volume",
    Source: VOLUME,
    Target: "/y",
    ...(subpath ? { VolumeOptions: volumeOptionsWithSubpath(subpath) } : {}),
  };
  const container = await docker.createContainer({
    Image: `${IMAGE}:${TAG}`,
    name,
    Cmd: ["ls", "/y"],
    HostConfig: { Mounts: [mount] },
  });
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
  it("is applied only on versions known to support it", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    if (runtime.runtime !== "podman") {
      t.skip(`Docker honours VolumeOptions.Subpath; canary is podman-only`);
      return;
    }

    const resolved = await resolveClient();
    if (!resolved) {
      t.skip("no container runtime available");
      return;
    }
    // `ContainerClient` is deliberately narrowed to the 12 methods the plugin
    // uses and declares no volume API. Rather than widen that contract or
    // cast past it for a test, build a dockerode client on the socket the
    // plugin already resolved.
    const docker = new Docker({ socketPath: resolved.socketPath });

    // Raw dockerode does not pull; a daemon without the image would 404 at
    // create and read as a failed canary rather than a missing image.
    await pullImage(runtime, `${IMAGE}:${TAG}`);
    await docker
      .getVolume(VOLUME)
      .remove({ force: true })
      .catch(() => {});
    await docker.createVolume({ Name: VOLUME });

    // Declared outside the try: a seed that fails to start still holds the
    // volume, so leaving it behind breaks the NEXT run on its fixed name.
    let seed: Awaited<ReturnType<Docker["createContainer"]>> | null = null;
    try {
      // Seed a volume with a file at its root and one in a subdirectory, so
      // "whole volume" and "subpath only" produce different listings.
      seed = await docker.createContainer({
        Image: `${IMAGE}:${TAG}`,
        name: SEED,
        Cmd: ["sh", "-c", "mkdir -p /y/sub && touch /y/root-file /y/sub/inner"],
        HostConfig: {
          Mounts: [{ Type: "volume", Source: VOLUME, Target: "/y" }],
        },
      });
      await seed.start();
      await seed.wait();

      const withSubpath = await listMount(docker, PROBE, "sub");

      // The subpath asks for `sub`, whose only entry is `inner`; the volume
      // root holds `root-file` and `sub`. The listing says which happened.
      if (honoursVolumeSubpath(runtime.version)) {
        assert.ok(
          withSubpath.includes("inner") && !withSubpath.includes("root-file"),
          `podman ${runtime.version} was expected to apply the subpath but ` +
            `returned the volume root (${JSON.stringify(withSubpath)}). If ` +
            `the endpoint has regressed, VOLUME_SUBPATH_MIN is wrong.`,
        );
      } else {
        assert.ok(
          withSubpath.includes("root-file"),
          `podman ${runtime.version} applied a compat-API volume subpath ` +
            `(saw ${JSON.stringify(withSubpath)}), which it was not expected ` +
            `to. Lower VOLUME_SUBPATH_MIN — and note that narrowing a ` +
            `parent-backed volume is now possible here, so ` +
            `assertVolumeIsNotBroaderThanRequested could become a real mount.`,
        );
      }
    } finally {
      // Container before volume: the volume cannot be removed while a
      // container still references it.
      await seed?.remove({ force: true }).catch(() => {});
      await docker
        .getVolume(VOLUME)
        .remove({ force: true })
        .catch(() => {});
    }
  });
});
