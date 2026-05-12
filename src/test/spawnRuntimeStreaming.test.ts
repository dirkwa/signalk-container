import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnRuntimeStreaming } from "../runtime";
import type { ContainerRuntimeInfo } from "../types";

/**
 * spawnRuntimeStreaming is generic — it shells out to whatever
 * binary you tell it to.  These tests drive it with `/bin/bash`
 * directly (via the `binary` option) so they don't need a real
 * container runtime.  Guarded against Windows where shell quoting
 * differs and `bash` isn't present.
 */
const runtimeStub: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "test",
  isPodmanDockerShim: false,
};

const skipOnWindows = process.platform === "win32";

/**
 * Bounded poll for a condition.  Rejects with a clear error after
 * `timeoutMs`, so a flaky/missing signal fails the test fast
 * instead of hanging the suite indefinitely.
 */
function waitFor(
  cond: () => boolean,
  label: string,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitFor timed out (${timeoutMs}ms): ${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("spawnRuntimeStreaming", { skip: skipOnWindows }, () => {
  it("emits each line via onLine in order", async () => {
    const lines: string[] = [];
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "printf 'a\\nb\\nc\\n'"],
      (line) => lines.push(line),
      { binary: "/bin/bash" },
    );
    await waitFor(() => lines.length >= 3, "expected 3 lines");
    handle.stop();
    assert.deepEqual(lines, ["a", "b", "c"]);
  });

  it("returns a pid for a successfully-spawned child", async () => {
    let exitCode: number | null | undefined;
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "sleep 60"],
      () => {},
      {
        binary: "/bin/bash",
        onExit: (code) => {
          exitCode = code;
        },
      },
    );
    assert.equal(typeof handle.pid, "number");
    assert.ok(handle.pid! > 0);
    handle.stop();
    // Wait for the child to die before exiting the test — see
    // "stop() is idempotent" for the rationale.
    await waitFor(() => exitCode !== undefined, "child should exit");
  });

  it("stop() actually kills a long-running child", async () => {
    let exitCode: number | null | undefined;
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "sleep 60"],
      () => {},
      {
        binary: "/bin/bash",
        onExit: (code) => {
          exitCode = code;
        },
      },
    );
    handle.stop();
    // SIGTERM with 2s grace, then SIGKILL — should be well under 3s.
    await waitFor(() => exitCode !== undefined, "child should exit");
    assert.notEqual(exitCode, undefined);
  });

  it("stop() is idempotent", async () => {
    let exitCode: number | null | undefined;
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "sleep 60"],
      () => {},
      {
        binary: "/bin/bash",
        onExit: (code) => {
          exitCode = code;
        },
      },
    );
    handle.stop();
    handle.stop();
    handle.stop();
    // Wait for the child to actually exit before returning — leaving
    // a half-killed child plus its open stdio pipes registered with
    // the event loop has been observed to destabilise macOS runners.
    await waitFor(() => exitCode !== undefined, "child should exit");
  });

  it("routes stderr to onError without splitting", async () => {
    const errors: string[] = [];
    const lines: string[] = [];
    spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "printf 'one\\n'; printf 'two\\n' 1>&2; sleep 0.1"],
      (line) => lines.push(line),
      {
        binary: "/bin/bash",
        onError: (msg) => errors.push(msg),
      },
    );
    await waitFor(
      () => lines.length >= 1 && errors.length >= 1,
      "expected one stdout line and one stderr line",
    );
    assert.deepEqual(lines, ["one"]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0], "two");
  });

  it("buffers partial lines across data events via makeLineSplitter", async () => {
    const lines: string[] = [];
    let exitCode: number | null | undefined;
    spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "printf 'a'; sleep 0.05; printf 'bc\\n'"],
      (line) => lines.push(line),
      {
        binary: "/bin/bash",
        onExit: (code) => {
          exitCode = code;
        },
      },
    );
    // Wait for the child to exit so we know all output has been
    // flushed and the splitter has emitted whatever it can.
    await waitFor(() => exitCode !== undefined, "child should exit");
    assert.deepEqual(lines, ["abc"]);
  });

  it("onExit fires for natural process exit", async () => {
    let exitCode: number | null | undefined;
    spawnRuntimeStreaming(runtimeStub, ["-c", "exit 0"], () => {}, {
      binary: "/bin/bash",
      onExit: (code) => {
        exitCode = code;
      },
    });
    await waitFor(() => exitCode !== undefined, "child should exit");
    assert.equal(exitCode, 0);
  });

  it("onExit reports non-zero exit code", async () => {
    let exitCode: number | null | undefined;
    spawnRuntimeStreaming(runtimeStub, ["-c", "exit 7"], () => {}, {
      binary: "/bin/bash",
      onExit: (code) => {
        exitCode = code;
      },
    });
    await waitFor(() => exitCode !== undefined, "child should exit");
    assert.equal(exitCode, 7);
  });

  it("synchronous spawn failure (bad binary) routes via onError, returns no-op stop", async () => {
    let err: string | undefined;
    const handle = spawnRuntimeStreaming(runtimeStub, [], () => {}, {
      binary: "/this/path/definitely/does/not/exist",
      onError: (msg) => {
        err = msg;
      },
    });
    handle.stop();
    handle.stop();
    await waitFor(
      () => err !== undefined,
      "spawn failure must surface via onError",
    );
  });

  it("stop() after natural exit is harmless", async () => {
    let exitCode: number | null | undefined;
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "exit 0"],
      () => {},
      {
        binary: "/bin/bash",
        onExit: (code) => {
          exitCode = code;
        },
      },
    );
    await waitFor(() => exitCode !== undefined, "child should exit");
    handle.stop(); // should not throw
  });
});
