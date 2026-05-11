import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

const SEP = "\x1f";

interface ExecCall {
  args: string[];
}

/**
 * Reusable router for the various inspect/start/stop/rm/run shapes
 * `ensureRunning` issues. Pass a state machine via `respond(args, callIndex)`
 * to drive it through the scenario.
 */
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

function buildLiveConfigStdout(parts: {
  image: string;
  cmd?: string;
  networkMode?: string;
  binds?: string;
  env?: string;
  portBindings?: string;
}): string {
  return [
    parts.image,
    parts.cmd ?? "null",
    parts.networkMode ?? "bridge",
    parts.binds ?? "null",
    parts.env ?? "null",
    parts.portBindings ?? "null",
  ].join(SEP);
}

const requested: ContainerConfig = {
  image: "questdb/questdb",
  tag: "9.0.0",
  env: { FOO: "2" },
};

describe("ensureRunning — config drift triggers automatic recreate", () => {
  it("calls remove + recreate when env drifts on a running container", async () => {
    const drifted = buildLiveConfigStdout({
      image: "questdb/questdb:9.0.0",
      env: '["FOO=1"]',
    });
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      // 1. getContainerState (inspect)
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        // First inspect: container is running. After remove, getContainerState
        // sees no container (but we issue 'rm -f' before ever reaching this
        // again; treat missing → exit 1).
        const removeCallSeen = calls.some((c) => c.args[0] === "rm");
        if (removeCallSeen) {
          return { stdout: "", stderr: "no such object", exitCode: 1 };
        }
        return { stdout: "running|true|12345", exitCode: 0 };
      }
      // 2. getLiveContainerConfig (inspect with our format)
      if (
        cmd === "inspect" &&
        args.some((a) => a.includes("{{.Config.Image}}"))
      ) {
        return { stdout: drifted, exitCode: 0 };
      }
      // 3. fixVolumePermissions inside removeContainer (inspect for binds)
      if (cmd === "inspect") {
        return { stdout: "", exitCode: 0 };
      }
      // 4. removeContainer: stop, then rm -f
      if (cmd === "stop") return { stdout: "", exitCode: 0 };
      if (cmd === "rm") return { stdout: "ok", exitCode: 0 };
      // 5. Recursive ensureRunning lands in case "missing":
      //    imageExists -> image inspect (true: don't pull)
      if (cmd === "image" && args[1] === "inspect") {
        return { stdout: "ok", exitCode: 0 };
      }
      // 6. run -d ... -> create
      if (cmd === "run") return { stdout: "id", exitCode: 0 };
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
    // Assert: stop + rm -f happened, then run -d.
    const cmds = calls.map((c) => c.args[0]);
    assert.ok(cmds.includes("stop"), "stop should be called");
    assert.ok(cmds.includes("rm"), "rm should be called");
    assert.ok(cmds.includes("run"), "run should be called");
    // Drift line in debug.
    assert.ok(
      debugLines.some((l) => l.includes("config drift detected")),
      `expected 'config drift detected' in debug, got: ${debugLines.join(" | ")}`,
    );
  });

  it("does NOT recreate when no drift (early-return path preserved)", async () => {
    const matching = buildLiveConfigStdout({
      image: "questdb/questdb:9.0.0",
      env: '["FOO=2"]',
    });
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "running|true|12345", exitCode: 0 };
      }
      if (
        cmd === "inspect" &&
        args.some((a) => a.includes("{{.Config.Image}}"))
      ) {
        return { stdout: matching, exitCode: 0 };
      }
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
    assert.ok(!cmds.includes("stop"));
    assert.ok(!cmds.includes("rm"));
    assert.ok(!cmds.includes("run"));
    assert.ok(
      debugLines.some((l) => l.includes("already running")),
      `expected 'already running' in debug, got: ${debugLines.join(" | ")}`,
    );
  });

  it("treats inspect failure during diff as 'cannot diff, skip' (no recreate)", async () => {
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "running|true|12345", exitCode: 0 };
      }
      if (
        cmd === "inspect" &&
        args.some((a) => a.includes("{{.Config.Image}}"))
      ) {
        // inspect fails — getLiveContainerConfig returns null
        return { stdout: "", stderr: "boom", exitCode: 1 };
      }
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
    assert.ok(!cmds.includes("rm"));
    assert.ok(
      debugLines.some((l) => l.includes("could not inspect for drift")),
    );
  });

  it("_postRecreate guard prevents recursion if state stays 'running'", async () => {
    // Force getContainerState to ALWAYS return "running" even after remove.
    // Real-world this would be a race or a restart-policy auto-restart;
    // we want the guard to short-circuit, not infinite-loop.
    const drifted = buildLiveConfigStdout({
      image: "questdb/questdb:9.0.0",
      env: '["FOO=1"]',
    });
    let driftInspectCount = 0;
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "running|true|12345", exitCode: 0 };
      }
      if (
        cmd === "inspect" &&
        args.some((a) => a.includes("{{.Config.Image}}"))
      ) {
        driftInspectCount++;
        return { stdout: drifted, exitCode: 0 };
      }
      if (cmd === "inspect") return { stdout: "", exitCode: 0 };
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
    // The first call did the diff + remove. The recursive call sees state
    // "running" again, hits the _postRecreate guard, and returns silently
    // — it does NOT do a second drift inspect.
    assert.equal(driftInspectCount, 1, "drift inspect should run exactly once");
    assert.ok(
      debugLines.some((l) => l.includes("unexpectedly running after recreate")),
      `expected guard message in debug, got: ${debugLines.join(" | ")}`,
    );
    // No 'run' issued (the recursion guard returned before the missing-branch
    // create path could fire).
    const cmds = calls.map((c) => c.args[0]);
    assert.ok(!cmds.includes("run"));
  });
});
