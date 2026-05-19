import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

const SEP = "\x1f";

interface ExecCall {
  args: string[];
}

function makeRouterExec(
  respond: (
    args: string[],
    callIndex: number,
  ) => { stdout: string; stderr?: string; exitCode: number },
): {
  exec: (
    runtime: ContainerRuntimeInfo,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  let i = 0;
  const exec = async (
    _runtime: ContainerRuntimeInfo,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    calls.push({ args: [...args] });
    const r = respond(args, i++);
    return { stdout: r.stdout, stderr: r.stderr ?? "", exitCode: r.exitCode };
  };
  return { exec, calls };
}

function liveConfig(image: string): string {
  return [
    image,
    "null", // cmd
    "bridge", // networkMode
    "null", // binds
    "null", // env
    "null", // portBindings
    '["host.containers.internal:host-gateway"]', // extraHosts (docker default)
    "1000:1000", // user
  ].join(SEP);
}

// Recognizers for the four inspect shapes ensureRunning issues.
const isStateInspect = (args: string[]) =>
  args[0] === "inspect" &&
  args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}");
const isLiveConfigInspect = (args: string[]) =>
  args[0] === "inspect" && args.some((a) => a.includes("{{.Config.Image}}"));
const isImageIdInspect = (args: string[]) =>
  args[0] === "image" && args[1] === "inspect" && args.includes("{{.Id}}");
const isContainerImageInspect = (args: string[]) =>
  args[0] === "inspect" && args.includes("{{.Image}}");

const baseConfig: ContainerConfig = {
  image: "questdb/questdb",
  tag: "latest",
  autoUpdateOnFloatingTag: true,
};

describe("ensureRunning — autoUpdateOnFloatingTag", () => {
  it("does NOT probe when flag is off (default behavior preserved)", async () => {
    const { exec, calls } = makeRouterExec((args) => {
      if (isStateInspect(args))
        return { stdout: "running|true|12345", exitCode: 0 };
      if (isLiveConfigInspect(args))
        return { stdout: liveConfig("questdb/questdb:latest"), exitCode: 0 };
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    });
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      { image: "questdb/questdb", tag: "latest" },
      () => {},
      undefined,
      exec,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    assert.equal(pulled, 0, "pull should not be called when flag is off");
    // No image inspect either.
    assert.ok(
      !calls.some((c) => isImageIdInspect(c.args)),
      "no digest probe when flag off",
    );
  });

  it("does NOT probe when tag is semver, even with flag on", async () => {
    const { exec, calls } = makeRouterExec((args) => {
      if (isStateInspect(args))
        return { stdout: "running|true|12345", exitCode: 0 };
      if (isLiveConfigInspect(args))
        return { stdout: liveConfig("questdb/questdb:9.0.0"), exitCode: 0 };
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    });
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      {
        image: "questdb/questdb",
        tag: "9.0.0",
        autoUpdateOnFloatingTag: true,
      },
      () => {},
      undefined,
      exec,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    assert.equal(pulled, 0, "semver tag should bypass digest probe");
    assert.ok(!calls.some((c) => isImageIdInspect(c.args)));
  });

  it("does NOT probe when digest is set (caller already pins to a digest)", async () => {
    // When digest is set, ContainerConfig already triggers config drift on
    // mismatch with the live image — there's no need for our extra probe.
    // We assert: no digest probe (no `image inspect {{.Id}}`) fires.
    // The recreate that follows comes from the existing config-drift path.
    const sameDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const { exec, calls } = makeRouterExec((args) => {
      if (isStateInspect(args)) {
        const removed = calls.some((c) => c.args[0] === "rm");
        if (removed)
          return { stdout: "", stderr: "no such object", exitCode: 1 };
        return { stdout: "running|true|12345", exitCode: 0 };
      }
      if (isLiveConfigInspect(args))
        return { stdout: liveConfig("questdb/questdb:latest"), exitCode: 0 };
      if (args[0] === "inspect") return { stdout: "", exitCode: 0 };
      if (args[0] === "stop") return { stdout: "", exitCode: 0 };
      if (args[0] === "rm") return { stdout: "ok", exitCode: 0 };
      if (args[0] === "image" && args[1] === "inspect")
        return { stdout: "ok", exitCode: 0 };
      if (args[0] === "run") return { stdout: "id", exitCode: 0 };
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    });
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, digest: sameDigest },
      () => {},
      undefined,
      exec,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    // Pull from missing-branch is fine; the assertion is about the new probe.
    assert.equal(
      pulled,
      0,
      "our extra probe pull should not be called when digest is set",
    );
    // No {{.Id}} probe — that's the new helper's signature call.
    assert.ok(
      !calls.some((c) => isImageIdInspect(c.args)),
      "digest probe should not run when digest is set",
    );
  });

  it("pulls but does NOT recreate when image-ids match", async () => {
    const sameId = "sha256:" + "a".repeat(64);
    const { exec, calls } = makeRouterExec((args) => {
      if (isStateInspect(args))
        return { stdout: "running|true|12345", exitCode: 0 };
      if (isLiveConfigInspect(args))
        return { stdout: liveConfig("questdb/questdb:latest"), exitCode: 0 };
      // getImageDigest on image:tag (registry side after pull) — image-inspect
      // succeeds because the image is now in the local store.
      if (isImageIdInspect(args)) {
        const last = args[args.length - 1];
        if (last && last.includes("questdb")) {
          return { stdout: sameId, exitCode: 0 };
        }
        // image-inspect on the container name fails (no image with that name).
        return { stdout: "", exitCode: 1 };
      }
      // getImageDigest fallback: container's .Image returns the image-id.
      if (isContainerImageInspect(args)) return { stdout: sameId, exitCode: 0 };
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    });
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      () => {},
      undefined,
      exec,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    assert.equal(pulled, 1, "pull should happen once");
    assert.ok(
      !calls.some((c) => c.args[0] === "rm"),
      "no rm should fire when image-ids match",
    );
  });

  it("recreates when registry image-id differs from running container image-id", async () => {
    const remoteId = "sha256:" + "b".repeat(64);
    const liveId = "sha256:" + "c".repeat(64);
    let recreated = false;
    const { exec, calls } = makeRouterExec((args) => {
      if (isStateInspect(args)) {
        if (recreated) {
          return { stdout: "", stderr: "no such object", exitCode: 1 };
        }
        return { stdout: "running|true|12345", exitCode: 0 };
      }
      if (isLiveConfigInspect(args))
        return { stdout: liveConfig("questdb/questdb:latest"), exitCode: 0 };
      // image-inspect on image:tag (registry-fresh after pull) vs on
      // container name (which fails — no image by that name).
      if (isImageIdInspect(args)) {
        const last = args[args.length - 1];
        if (last && last.includes("questdb:latest")) {
          return { stdout: remoteId, exitCode: 0 };
        }
        // image-inspect on the container name → not an image → exit 1
        // so getImageDigest falls back to container .Image.
        if (last === "sk-questdb") {
          return { stdout: "", exitCode: 1 };
        }
        // Post-recreate: imageExists probe in the missing branch.
        return { stdout: "ok", exitCode: 0 };
      }
      if (isContainerImageInspect(args)) {
        return { stdout: liveId, exitCode: 0 };
      }
      // Post-recreate path: inspect for binds during fixVolumePermissions
      if (args[0] === "inspect") return { stdout: "", exitCode: 0 };
      if (args[0] === "stop") return { stdout: "", exitCode: 0 };
      if (args[0] === "rm") {
        recreated = true;
        return { stdout: "ok", exitCode: 0 };
      }
      // imageExists in the recursive missing path
      if (args[0] === "image" && args[1] === "inspect")
        return { stdout: "ok", exitCode: 0 };
      if (args[0] === "run") return { stdout: "id", exitCode: 0 };
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    });
    const debugLines: string[] = [];
    let pulled = 0;
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      (m) => debugLines.push(m),
      undefined,
      exec,
      undefined,
      false,
      async () => {
        pulled++;
      },
    );
    assert.ok(pulled >= 1, "pull should happen at least once");
    const cmds = calls.map((c) => c.args[0]);
    assert.ok(cmds.includes("rm"), "rm should be called on digest drift");
    assert.ok(cmds.includes("run"), "run should be called on recreate");
    assert.ok(
      debugLines.some((l) => l.includes("digest drift detected")),
      `expected 'digest drift detected' in debug, got: ${debugLines.join(" | ")}`,
    );
  });

  it("skips silently when pull fails as offline (boats at sea)", async () => {
    const { exec, calls } = makeRouterExec((args) => {
      if (isStateInspect(args))
        return { stdout: "running|true|12345", exitCode: 0 };
      if (isLiveConfigInspect(args))
        return { stdout: liveConfig("questdb/questdb:latest"), exitCode: 0 };
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      (m) => debugLines.push(m),
      undefined,
      exec,
      undefined,
      false,
      async () => {
        // Simulate getaddrinfo / ENOTFOUND
        const err = new Error("getaddrinfo ENOTFOUND ghcr.io") as Error & {
          code?: string;
        };
        err.code = "ENOTFOUND";
        throw err;
      },
    );
    // No rm/run — container left alone.
    assert.ok(!calls.some((c) => c.args[0] === "rm"));
    assert.ok(!calls.some((c) => c.args[0] === "run"));
    assert.ok(
      debugLines.some((l) => l.includes("skipped (offline)")),
      `expected offline-skip debug, got: ${debugLines.join(" | ")}`,
    );
  });
});
