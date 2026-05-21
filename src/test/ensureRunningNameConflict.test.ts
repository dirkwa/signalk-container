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

const requested: ContainerConfig = {
  image: "questdb/questdb",
  tag: "9.0.0",
  env: { FOO: "2" },
};

describe("ensureRunning — stale-container name conflict on create", () => {
  it("removes the stale container and retries when create hits a name conflict", async () => {
    // Scenario: a container with this name exists but `inspect` fails (a
    // corrupt storage layer after an unclean shutdown), so getContainerState
    // reports "missing". The create then collides with the still-registered
    // name; ensureRunning must remove the stale container and retry once.
    let runCount = 0;
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      // getContainerState — in ensureRunning itself and inside
      // removeContainer's fixVolumePermissions: inspect fails → "missing".
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "", stderr: "no such object", exitCode: 1 };
      }
      // imageExists → image inspect: image present, skip pull.
      if (cmd === "image" && args[1] === "inspect") {
        return { stdout: "ok", exitCode: 0 };
      }
      // First create fails on the name conflict; second create succeeds.
      if (cmd === "run") {
        runCount++;
        if (runCount === 1) {
          return {
            stdout: "",
            stderr:
              'the container name "sk-questdb" is already in use by abc123',
            exitCode: 125,
          };
        }
        return { stdout: "id", exitCode: 0 };
      }
      // removeContainer: stop (result ignored), then rm -f.
      if (cmd === "stop") return { stdout: "", exitCode: 0 };
      if (cmd === "rm") return { stdout: "ok", exitCode: 0 };
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    });
    const debugLines: string[] = [];
    await ensureRunning(
      docker,
      "questdb",
      requested,
      (m) => debugLines.push(m),
      undefined,
      exec,
    );
    const cmds = calls.map((c) => c.args[0]);
    assert.equal(runCount, 2, "create should be attempted exactly twice");
    assert.ok(cmds.includes("rm"), "stale container should be removed");
    assert.ok(
      debugLines.some((l) => l.includes("name conflict")),
      `expected name-conflict message, got: ${debugLines.join(" | ")}`,
    );
  });

  it("does not retry create when the failure is unrelated to a name conflict", async () => {
    let runCount = 0;
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "", stderr: "no such object", exitCode: 1 };
      }
      if (cmd === "image" && args[1] === "inspect") {
        return { stdout: "ok", exitCode: 0 };
      }
      if (cmd === "run") {
        runCount++;
        return { stdout: "", stderr: "no space left on device", exitCode: 125 };
      }
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    });
    await assert.rejects(
      ensureRunning(docker, "questdb", requested, () => {}, undefined, exec),
      /Failed to create .*no space left on device/,
    );
    assert.equal(runCount, 1, "create should be attempted exactly once");
    assert.ok(
      !calls.map((c) => c.args[0]).includes("rm"),
      "no removal should be attempted for an unrelated failure",
    );
  });
});
