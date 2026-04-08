import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getContainerState } from "../containers";
import type { ContainerRuntimeInfo } from "../types";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

interface FakeResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

function fakeExec(result: FakeResult, capturedArgs?: { args: string[] }) {
  return async (_runtime: ContainerRuntimeInfo, args: string[]) => {
    if (capturedArgs) capturedArgs.args = args;
    return {
      stdout: result.stdout,
      stderr: result.stderr ?? "",
      exitCode: result.exitCode,
    };
  };
}

describe("getContainerState", () => {
  it("returns 'missing' when the runtime exits non-zero (no such container)", async () => {
    const exec = fakeExec({
      stdout: "",
      stderr: "no such object: sk-ghost",
      exitCode: 1,
    });
    const result = await getContainerState(dummyRuntime, "ghost", exec);
    assert.equal(result, "missing");
  });

  it("returns 'running' when Status=running, Running=true, Pid>0 (happy case)", async () => {
    const exec = fakeExec({ stdout: "running|true|12345", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "running");
  });

  it("returns 'stopped' when Status=exited, Running=false, Pid=0", async () => {
    const exec = fakeExec({ stdout: "exited|false|0", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "stopped");
  });

  it("returns 'running' when only Status says running (Running=false, Pid=0)", async () => {
    // Defensive: one data source is enough to trust "running".
    const exec = fakeExec({ stdout: "running|false|0", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "running");
  });

  it("returns 'running' when Status lies but Running=true (rootless podman transient state flap)", async () => {
    // This is the exact observed failure mode on Dirk's VM:
    // `podman inspect --format {{.State.Status}}` returns "stopped"
    // for an actually-running container, briefly and intermittently,
    // under concurrent inspect load. But Running=true and Pid>0 are
    // correct. Our OR logic catches it.
    const exec = fakeExec({
      stdout: "stopped|true|54321",
      exitCode: 0,
    });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "running");
  });

  it("returns 'running' when only Pid is positive (Running unavailable, Status wrong)", async () => {
    const exec = fakeExec({ stdout: "stopped|false|12345", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "running");
  });

  it("returns 'stopped' for a genuinely stopped container with 'stopped' status", async () => {
    // Covers the parser path where Status is literally "stopped" (vs
    // "exited" which is the more common podman state for a clean
    // stop). Both should map to our "stopped" state.
    const exec = fakeExec({ stdout: "stopped|false|0", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "stopped");
  });

  it("returns 'stopped' for 'created' state (container exists, never started)", async () => {
    const exec = fakeExec({ stdout: "created|false|0", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "stopped");
  });

  it("handles whitespace around the pipe-separated values", async () => {
    const exec = fakeExec({
      stdout: "  running  |  true  |  123  ",
      exitCode: 0,
    });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "running");
  });

  it("handles trailing newline in output (execRuntime trim should handle, but be defensive)", async () => {
    const exec = fakeExec({ stdout: "running|true|999\n", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "running");
  });

  it("passes the correct format string to exec", async () => {
    const captured = { args: [] as string[] };
    const exec = fakeExec({ stdout: "running|true|1", exitCode: 0 }, captured);
    await getContainerState(dummyRuntime, "mayara-server", exec);
    assert.deepEqual(captured.args, [
      "inspect",
      "--format",
      "{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}",
      "sk-mayara-server",
    ]);
  });

  it("prefixes the container name with sk- automatically", async () => {
    const captured = { args: [] as string[] };
    const exec = fakeExec({ stdout: "running|true|1", exitCode: 0 }, captured);
    await getContainerState(dummyRuntime, "foo", exec);
    assert.equal(captured.args.at(-1), "sk-foo");
  });

  it("does not double-prefix when the name already starts with sk-", async () => {
    const captured = { args: [] as string[] };
    const exec = fakeExec({ stdout: "running|true|1", exitCode: 0 }, captured);
    await getContainerState(dummyRuntime, "sk-foo", exec);
    assert.equal(captured.args.at(-1), "sk-foo");
  });

  it("returns 'stopped' for malformed output (all fields empty)", async () => {
    // If the output is malformed, we don't want to report "running"
    // (false positive is worse than false negative for this code path
    // — but note the tradeoff: ensureRunning's "already running" fast
    // path would then do a redundant start attempt, which is safe).
    const exec = fakeExec({ stdout: "||", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "stopped");
  });

  it("returns 'stopped' for non-numeric Pid", async () => {
    // Pid field has garbage; Status=exited, Running=false. Should be stopped.
    const exec = fakeExec({ stdout: "exited|false|notanumber", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "stopped");
  });

  it("negative Pid is treated as not-running", async () => {
    // Paranoid: some runtimes might use -1 to mean "no process".
    const exec = fakeExec({ stdout: "exited|false|-1", exitCode: 0 });
    const result = await getContainerState(dummyRuntime, "x", exec);
    assert.equal(result, "stopped");
  });
});
