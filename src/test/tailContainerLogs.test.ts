import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tailContainerLogs, getContainerLogs, MAX_TAIL } from "../containers";
import type { ContainerRuntimeInfo } from "../types";

const runtime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "test",
  isPodmanDockerShim: false,
};

interface SpawnCall {
  args: string[];
}

/**
 * Stub the underlying `spawnRuntimeStreaming` so we can assert
 * exactly which CLI args `tailContainerLogs` produces, without
 * spawning anything real.
 */
function makeStubSpawn() {
  const calls: SpawnCall[] = [];
  let stopCount = 0;
  const stub: typeof import("../runtime").spawnRuntimeStreaming = (
    _runtime,
    args,
  ) => {
    calls.push({ args: [...args] });
    return {
      stop: () => {
        stopCount++;
      },
      pid: 1234,
    };
  };
  return {
    spawn: stub,
    calls,
    stopCount: () => stopCount,
  };
}

describe("tailContainerLogs", () => {
  it("builds 'logs -f --tail 0 sk-foo' for default options", () => {
    const stub = makeStubSpawn();
    tailContainerLogs(runtime, "foo", () => {}, { spawn: stub.spawn });
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0].args, [
      "logs",
      "-f",
      "--tail",
      "0",
      "sk-foo",
    ]);
  });

  it("honours startTail when supplied", () => {
    const stub = makeStubSpawn();
    tailContainerLogs(runtime, "foo", () => {}, {
      spawn: stub.spawn,
      startTail: 100,
    });
    assert.deepEqual(stub.calls[0].args, [
      "logs",
      "-f",
      "--tail",
      "100",
      "sk-foo",
    ]);
  });

  it("does not double-prefix when name already starts with sk-", () => {
    const stub = makeStubSpawn();
    tailContainerLogs(runtime, "sk-bar", () => {}, { spawn: stub.spawn });
    assert.equal(stub.calls[0].args[stub.calls[0].args.length - 1], "sk-bar");
  });

  it("returned stop() forwards to the underlying handle", () => {
    const stub = makeStubSpawn();
    const handle = tailContainerLogs(runtime, "foo", () => {}, {
      spawn: stub.spawn,
    });
    handle.stop();
    handle.stop();
    assert.equal(stub.stopCount(), 2);
  });

  it("normalizes NaN/Infinity/negative startTail to 0", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -7]) {
      const stub = makeStubSpawn();
      tailContainerLogs(runtime, "foo", () => {}, {
        spawn: stub.spawn,
        startTail: bad,
      });
      assert.equal(
        stub.calls[0].args[3],
        "0",
        `startTail=${bad} should normalize to "0"`,
      );
    }
  });

  it("caps absurd startTail at MAX_TAIL", () => {
    const stub = makeStubSpawn();
    tailContainerLogs(runtime, "foo", () => {}, {
      spawn: stub.spawn,
      startTail: MAX_TAIL + 1,
    });
    assert.equal(stub.calls[0].args[3], String(MAX_TAIL));
  });
});

describe("getContainerLogs", () => {
  it("calls 'logs --tail N sk-foo' and returns split lines", async () => {
    const calls: string[][] = [];
    const exec = async (
      _r: ContainerRuntimeInfo,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      calls.push([...args]);
      return { stdout: "alpha\nbeta\ngamma", stderr: "", exitCode: 0 };
    };
    const lines = await getContainerLogs(runtime, "foo", { tail: 3 }, exec);
    assert.deepEqual(calls[0], ["logs", "--tail", "3", "sk-foo"]);
    assert.deepEqual(lines, ["alpha", "beta", "gamma"]);
  });

  it("defaults tail to 200 when not supplied", async () => {
    const calls: string[][] = [];
    const exec = async (
      _r: ContainerRuntimeInfo,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      calls.push([...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await getContainerLogs(runtime, "foo", undefined, exec);
    assert.equal(calls[0][2], "200");
  });

  it("caps tail at MAX_TAIL", async () => {
    const calls: string[][] = [];
    const exec = async (
      _r: ContainerRuntimeInfo,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      calls.push([...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await getContainerLogs(runtime, "foo", { tail: MAX_TAIL + 1000 }, exec);
    assert.equal(calls[0][2], String(MAX_TAIL));
  });

  it("floors tail to 0 when negative", async () => {
    const calls: string[][] = [];
    const exec = async (
      _r: ContainerRuntimeInfo,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      calls.push([...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await getContainerLogs(runtime, "foo", { tail: -50 }, exec);
    assert.equal(calls[0][2], "0");
  });

  it("includes --since when supplied", async () => {
    const calls: string[][] = [];
    const exec = async (
      _r: ContainerRuntimeInfo,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      calls.push([...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await getContainerLogs(runtime, "foo", { since: 1700000000 }, exec);
    assert.ok(calls[0].includes("--since"));
    assert.equal(calls[0][calls[0].indexOf("--since") + 1], "1700000000");
  });

  it("omits --since when negative, NaN or Infinity", async () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const calls: string[][] = [];
      const exec = async (
        _r: ContainerRuntimeInfo,
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        calls.push([...args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await getContainerLogs(runtime, "foo", { since: bad }, exec);
      assert.ok(
        !calls[0].includes("--since"),
        `since=${bad} should not become --since`,
      );
    }
  });

  it("falls back to default 200 when tail is NaN or Infinity", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const calls: string[][] = [];
      const exec = async (
        _r: ContainerRuntimeInfo,
        args: string[],
      ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
        calls.push([...args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await getContainerLogs(runtime, "foo", { tail: bad }, exec);
      assert.equal(calls[0][2], "200", `tail=${bad} should fall back to "200"`);
    }
  });

  it("merges stdout and stderr into the line array", async () => {
    const exec = async (): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }> => ({
      stdout: "out1\nout2",
      stderr: "err1",
      exitCode: 0,
    });
    const lines = await getContainerLogs(runtime, "foo", undefined, exec);
    assert.deepEqual(lines, ["out1", "out2", "err1"]);
  });

  it("throws when exec returns non-zero", async () => {
    const exec = async (): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }> => ({
      stdout: "",
      stderr: "No such container",
      exitCode: 125,
    });
    await assert.rejects(
      () => getContainerLogs(runtime, "ghost", undefined, exec),
      /No such container/,
    );
  });

  it("strips trailing empty line caused by trailing newline", async () => {
    // Real `podman logs` output typically has a trailing newline,
    // which our split would otherwise turn into an empty array
    // entry.  Verify we drop it.
    const exec = async (): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }> => ({
      stdout: "a\nb\n",
      stderr: "",
      exitCode: 0,
    });
    const lines = await getContainerLogs(runtime, "foo", undefined, exec);
    assert.deepEqual(lines, ["a", "b"]);
  });

  it("does not synthesize a phantom blank line between stdout and stderr", async () => {
    // stdout already ends with `\n` and stderr is non-empty.  A
    // naive `[stdout, stderr].join("\n")` would produce
    // "out1\nout2\n\nerr1", splitting to ["out1","out2","","err1"]
    // — a blank line nobody actually emitted.
    const exec = async (): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }> => ({
      stdout: "out1\nout2\n",
      stderr: "err1",
      exitCode: 0,
    });
    const lines = await getContainerLogs(runtime, "foo", undefined, exec);
    assert.deepEqual(lines, ["out1", "out2", "err1"]);
  });

  it("does not emit a phantom leading empty line when one side is empty", async () => {
    // A naive `${stdout}\n${stderr}` concat injects "\n" + "err"
    // when stdout=="", producing ["", "err"].  Verify the filter
    // suppresses that.  Symmetrical for stderr=="".
    for (const fixture of [
      { stdout: "", stderr: "err1\nerr2" },
      { stdout: "out1\nout2", stderr: "" },
    ]) {
      const exec = async (): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }> => ({ ...fixture, exitCode: 0 });
      const lines = await getContainerLogs(runtime, "foo", undefined, exec);
      assert.ok(
        !lines.some((l) => l === ""),
        `no empty lines expected, got ${JSON.stringify(lines)}`,
      );
    }
  });
});
