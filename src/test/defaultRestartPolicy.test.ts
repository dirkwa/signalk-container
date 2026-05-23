import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

// signalk-container forwards `ContainerConfig.restart` to the runtime as
// `--restart=<value>`. Until 1.11.0 the field was optional with no
// default, so a consumer plugin that forgot to set it would create a
// container with no restart policy — a host reboot would leave the
// container `exited` and nothing brought it back until signalk-server
// was restarted and the plugin's start() ran ensureRunning() again.
//
// The default is now `unless-stopped` so containers come back on host
// reboot without the consumer plugin having to opt in. `"no"` still
// suppresses the flag entirely for genuinely one-shot containers.

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

function makeMissingThenRunningExec(): {
  exec: (
    runtime: ContainerRuntimeInfo,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  calls: ExecCall[];
} {
  // ensureRunning with state=missing pulls then runs. We need to:
  //   - Return "no such object" for the State inspect → drives the
  //     missing branch.
  //   - Succeed the pull (image inspect + pull).
  //   - Succeed the run and capture its argv.
  const calls: ExecCall[] = [];
  const exec = async (
    _runtime: ContainerRuntimeInfo,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    calls.push({ args: [...args] });
    // First state inspect: container missing.
    if (
      args[0] === "inspect" &&
      args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
    ) {
      return { stdout: "", stderr: "no such object", exitCode: 1 };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { stdout: "ok", stderr: "", exitCode: 0 };
    }
    if (args[0] === "pull") {
      return { stdout: "ok", stderr: "", exitCode: 0 };
    }
    if (args[0] === "run") {
      return { stdout: "id", stderr: "", exitCode: 0 };
    }
    throw new Error(`unexpected exec: ${args.join(" ")}`);
  };
  return { exec, calls };
}

function runArgsFrom(calls: ExecCall[]): string[] {
  const run = calls.find((c) => c.args[0] === "run");
  if (!run) throw new Error("no `run` call captured");
  return run.args;
}

const baseConfig: ContainerConfig = {
  image: "questdb/questdb",
  tag: "latest",
};

describe("ensureRunning — default restart policy", () => {
  it("adds --restart unless-stopped when consumer omits restart", async () => {
    const { exec, calls } = makeMissingThenRunningExec();
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      () => {},
      undefined,
      exec,
    );
    const args = runArgsFrom(calls);
    const idx = args.indexOf("--restart");
    assert.notEqual(idx, -1, "default should still pass --restart");
    assert.equal(args[idx + 1], "unless-stopped");
  });

  it("honours an explicit restart: always", async () => {
    const { exec, calls } = makeMissingThenRunningExec();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, restart: "always" },
      () => {},
      undefined,
      exec,
    );
    const args = runArgsFrom(calls);
    const idx = args.indexOf("--restart");
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], "always");
  });

  it("honours explicit restart: 'no' by omitting the flag entirely", async () => {
    const { exec, calls } = makeMissingThenRunningExec();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, restart: "no" },
      () => {},
      undefined,
      exec,
    );
    const args = runArgsFrom(calls);
    assert.equal(
      args.indexOf("--restart"),
      -1,
      "explicit 'no' should not emit --restart",
    );
  });
});
