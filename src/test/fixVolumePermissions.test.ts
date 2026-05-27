import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { removeContainer } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

interface ExecCall {
  args: string[];
}

/**
 * Fake exec that drives `removeContainer` through the three commands it
 * issues: inspect (state), inspect (bind mounts via --format), exec/chmod,
 * stop, rm.
 */
function makeFakeExec(opts: { state?: string; mounts?: string }): {
  exec: (
    runtime: ContainerRuntimeInfo,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  calls: ExecCall[];
} {
  const state = opts.state ?? "running|true|12345";
  const mounts = opts.mounts ?? "/signalk-data /host-media";
  const calls: ExecCall[] = [];
  const exec = async (_runtime: ContainerRuntimeInfo, args: string[]) => {
    calls.push({ args: [...args] });
    const cmd = args[0];
    if (
      cmd === "inspect" &&
      args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
    ) {
      return { stdout: state, stderr: "", exitCode: 0 };
    }
    if (cmd === "inspect") {
      // The bind-mount inspect.
      return { stdout: mounts, stderr: "", exitCode: 0 };
    }
    if (cmd === "exec" || cmd === "stop" || cmd === "rm") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    throw new Error(`unexpected exec: ${args.join(" ")}`);
  };
  return { exec, calls };
}

describe("fixVolumePermissions", () => {
  it("uses `find -type d` so only directory modes are widened, not files", async () => {
    const { exec, calls } = makeFakeExec({});
    await removeContainer(podman, "backup-server", exec);

    const chmodCall = calls.find(
      (c) => c.args[0] === "exec" && c.args.includes("find"),
    );
    assert.ok(
      chmodCall,
      `expected an 'exec ... find' call; got: ${calls.map((c) => c.args.join(" ")).join(" | ")}`,
    );

    // The find invocation must restrict to directories. Without
    // `-type d`, file modes get widened blanket-style, which exposes
    // private keys, OAuth tokens, etc. in mounts that contain them.
    assert.ok(
      chmodCall.args.includes("-type") &&
        chmodCall.args[chmodCall.args.indexOf("-type") + 1] === "d",
      `expected -type d in find invocation; got: ${chmodCall.args.join(" ")}`,
    );

    // The chmod operand must be `o+rwx` (lowercase x — dirs only, no
    // X-promotion to files). Files keep their original mode.
    const chmodIdx = chmodCall.args.indexOf("chmod");
    assert.ok(chmodIdx > -1, "expected chmod after find -exec");
    assert.equal(
      chmodCall.args[chmodIdx + 1],
      "o+rwx",
      `expected chmod o+rwx (dirs); got: ${chmodCall.args[chmodIdx + 1]}`,
    );

    // Regression guard: must NEVER fall back to recursive `chmod -R o+rwX`.
    // That form widens file modes including SSL keys / credential files
    // that the container may have written into the bind mount.
    const recursiveChmod = calls.find(
      (c) =>
        c.args[0] === "exec" &&
        c.args.includes("chmod") &&
        c.args.includes("-R"),
    );
    assert.equal(
      recursiveChmod,
      undefined,
      `chmod -R o+rwX must not be used (widens file modes); got: ${recursiveChmod?.args.join(" ")}`,
    );
  });

  it("passes every bind-mount destination as a find argument", async () => {
    const { exec, calls } = makeFakeExec({
      mounts: "/signalk-data /host-media /host-mnt",
    });
    await removeContainer(podman, "backup-server", exec);

    const findCall = calls.find(
      (c) => c.args[0] === "exec" && c.args.includes("find"),
    );
    assert.ok(findCall, "expected find call");
    for (const mount of ["/signalk-data", "/host-media", "/host-mnt"]) {
      assert.ok(
        findCall.args.includes(mount),
        `expected mount ${mount} in find args; got: ${findCall.args.join(" ")}`,
      );
    }
  });

  it("skips the chmod entirely when the container has no bind mounts", async () => {
    const { exec, calls } = makeFakeExec({ mounts: "" });
    await removeContainer(podman, "backup-server", exec);

    const findCall = calls.find(
      (c) => c.args[0] === "exec" && c.args.includes("find"),
    );
    assert.equal(
      findCall,
      undefined,
      `no bind mounts ⇒ no chmod; got: ${findCall?.args.join(" ")}`,
    );
  });

  it("skips the chmod when the container is not running", async () => {
    const { exec, calls } = makeFakeExec({ state: "stopped|false|0" });
    await removeContainer(podman, "backup-server", exec);

    const findCall = calls.find(
      (c) => c.args[0] === "exec" && c.args.includes("find"),
    );
    assert.equal(
      findCall,
      undefined,
      `stopped container ⇒ no chmod; got: ${findCall?.args.join(" ")}`,
    );
  });
});
