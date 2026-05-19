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

// Pin the host UID/GID resolver so user-mapping flags are deterministic
// regardless of who runs `npm test`. `buildLiveConfigStdout` defaults to
// `user: "1000:1000"` to match.
before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

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
  extraHosts?: string;
  user?: string;
}): string {
  return [
    parts.image,
    parts.cmd ?? "null",
    parts.networkMode ?? "bridge",
    parts.binds ?? "null",
    parts.env ?? "null",
    parts.portBindings ?? "null",
    parts.extraHosts ?? "null",
    // Matches the pinned host-id resolver above (1000:1000), so the
    // existing "no drift" fixtures stay no-drift without each call
    // having to set user explicitly.
    parts.user ?? "1000:1000",
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
      // Docker runtime always carries the auto-injected host-gateway entry;
      // include it in live so diffContainerConfig finds extraHosts symmetric.
      extraHosts: '["host.containers.internal:host-gateway"]',
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

describe("ensureRunning — stopped-state drift detection", () => {
  it("recreates a STOPPED container when its config has drifted (not just starts it)", async () => {
    // Without the stopped-state diff, the old container would be `start`ed
    // back up with stale env. This is the bug CodeRabbit caught on PR #30.
    const drifted = buildLiveConfigStdout({
      image: "questdb/questdb:9.0.0",
      env: '["FOO=1"]', // live still has the OLD value
    });
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        // Container is stopped on first probe. After remove, missing.
        const removeSeen = calls.some((c) => c.args[0] === "rm");
        if (removeSeen) {
          return { stdout: "", stderr: "no such object", exitCode: 1 };
        }
        return { stdout: "exited|false|0", exitCode: 0 };
      }
      if (
        cmd === "inspect" &&
        args.some((a) => a.includes("{{.Config.Image}}"))
      ) {
        return { stdout: drifted, exitCode: 0 };
      }
      if (cmd === "inspect") return { stdout: "", exitCode: 0 };
      if (cmd === "stop") return { stdout: "", exitCode: 0 };
      if (cmd === "rm") return { stdout: "ok", exitCode: 0 };
      if (cmd === "image" && args[1] === "inspect") {
        return { stdout: "ok", exitCode: 0 };
      }
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
    const cmds = calls.map((c) => c.args[0]);
    assert.ok(cmds.includes("rm"), "stopped+drifted should be removed");
    assert.ok(cmds.includes("run"), "stopped+drifted should be recreated");
    // The 'start' branch should NOT have been taken on the drifting path.
    // (It will appear once on the recursive missing-branch flow only if
    // the new container needs starting — but `run -d` already starts it.)
    assert.ok(
      !cmds.some(
        (c, i) =>
          c === "start" && i < calls.findIndex((x) => x.args[0] === "rm"),
      ),
      "should not 'start' the stale container before remove",
    );
    assert.ok(
      debugLines.some((l) => l.includes("config drift detected")),
      `expected drift message, got: ${debugLines.join(" | ")}`,
    );
  });

  it("starts a STOPPED container without recreating when no drift", async () => {
    const matching = buildLiveConfigStdout({
      image: "questdb/questdb:9.0.0",
      env: '["FOO=2"]', // matches requested
      // Docker runtime always carries the auto-injected host-gateway entry;
      // include it in live so diffContainerConfig finds extraHosts symmetric.
      extraHosts: '["host.containers.internal:host-gateway"]',
    });
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "exited|false|0", exitCode: 0 };
      }
      if (
        cmd === "inspect" &&
        args.some((a) => a.includes("{{.Config.Image}}"))
      ) {
        return { stdout: matching, exitCode: 0 };
      }
      if (cmd === "start") return { stdout: "", exitCode: 0 };
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
    assert.ok(cmds.includes("start"));
    assert.ok(!cmds.includes("rm"));
    assert.ok(!cmds.includes("run"));
    assert.ok(debugLines.some((l) => l.includes("Starting stopped container")));
  });

  it("starts a STOPPED container without diff when inspect fails (fail-safe)", async () => {
    const { exec, calls } = makeRouterExec((args) => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "exited|false|0", exitCode: 0 };
      }
      if (
        cmd === "inspect" &&
        args.some((a) => a.includes("{{.Config.Image}}"))
      ) {
        return { stdout: "", stderr: "boom", exitCode: 1 };
      }
      if (cmd === "start") return { stdout: "", exitCode: 0 };
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
    assert.ok(
      cmds.includes("start"),
      "should still start when diff inspect fails",
    );
    assert.ok(!cmds.includes("rm"));
    assert.ok(
      debugLines.some((l) => l.includes("could not inspect for drift")),
    );
  });
});

describe("ensureRunning — buildRunArgs ownership + UMASK", () => {
  // Capture the run-command args by routing exec at the missing-state path
  // (no inspect-drift logic involved): container is missing, so ensureRunning
  // falls straight through to pull (skipped by image inspect 'ok') + run -d.
  function captureRunArgsOnMissing(config: ContainerConfig): {
    runArgs: string[] | null;
    run: () => Promise<void>;
  } {
    let runArgs: string[] | null = null;
    const exec = async (
      _runtime: ContainerRuntimeInfo,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const cmd = args[0];
      // Missing container path: probe says "no such object", image
      // inspect says present, then `run -d`.
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "", stderr: "no such object", exitCode: 1 };
      }
      if (cmd === "image" && args[1] === "inspect") {
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
      if (cmd === "run") {
        runArgs = args;
        return { stdout: "id", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    };
    return {
      get runArgs() {
        return runArgs;
      },
      run: () =>
        ensureRunning(docker, "demo", config, () => {}, undefined, exec),
    };
  }

  it("emits --user host:host by default (in-image uid 0 maps to host 1000:1000)", async () => {
    const cap = captureRunArgsOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
    });
    await cap.run();
    assert.ok(cap.runArgs, "run command should have been issued");
    const userIdx = cap.runArgs.indexOf("--user");
    assert.ok(
      userIdx >= 0,
      `--user flag missing from: ${cap.runArgs.join(" ")}`,
    );
    assert.equal(cap.runArgs[userIdx + 1], "1000:1000");
  });

  it("omits --user when ContainerConfig.user is false (opt-out)", async () => {
    const cap = captureRunArgsOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
      user: false,
    });
    await cap.run();
    assert.ok(cap.runArgs);
    assert.ok(
      !cap.runArgs.includes("--user"),
      `--user should not appear: ${cap.runArgs.join(" ")}`,
    );
  });

  it("injects -e UMASK=022 by default", async () => {
    const cap = captureRunArgsOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
    });
    await cap.run();
    assert.ok(cap.runArgs);
    const idx = cap.runArgs.indexOf("UMASK=022");
    assert.ok(idx >= 0, `UMASK=022 missing from: ${cap.runArgs.join(" ")}`);
    assert.equal(cap.runArgs[idx - 1], "-e");
    // And only once — must not appear twice.
    const occurrences = cap.runArgs.filter((a) => a === "UMASK=022").length;
    assert.equal(occurrences, 1);
  });

  it("does not overwrite a caller-provided UMASK in config.env", async () => {
    const cap = captureRunArgsOnMissing({
      image: "questdb/questdb",
      tag: "9.0.0",
      env: { UMASK: "0027" },
    });
    await cap.run();
    assert.ok(cap.runArgs);
    // The default UMASK=022 must NOT have been pushed.
    assert.ok(!cap.runArgs.includes("UMASK=022"));
    // The caller's value is preserved verbatim.
    assert.ok(cap.runArgs.includes("UMASK=0027"));
  });
});
