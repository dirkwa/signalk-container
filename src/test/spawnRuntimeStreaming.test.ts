import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnRuntimeStreaming } from "../runtime";
import type { ContainerRuntimeInfo } from "../types";

/**
 * spawnRuntimeStreaming is generic — it shells out to whatever
 * binary you tell it to.  These tests drive it with `/bin/bash`
 * directly (via the `binary` option) so they don't need a real
 * container runtime.  Guarded against Windows where shell quoting
 * differs and `bash` isn't present, and against macOS where the
 * GitHub-hosted macos-15-arm64 runner sporadically receives a
 * shutdown signal mid-suite when many child processes spawn in
 * rapid succession.  Linux x64 + Linux arm64 + Windows already
 * exercise the real fork/exec path; macOS coverage of pure
 * `child_process.spawn` adds nothing this primitive needs.
 */
const runtimeStub: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "test",
  isPodmanDockerShim: false,
};

const skipOnUnstable =
  process.platform === "win32" || process.platform === "darwin";

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

describe("spawnRuntimeStreaming", { skip: skipOnUnstable }, () => {
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

  it("routes stderr to onError without splitting (default)", async () => {
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

  it("merges stderr into onLine when mergeStderr is set", async () => {
    // Regression for the bug where Rust/Go apps that log to stderr
    // (mayara is the canonical example) appeared silent in the SSE
    // modal while spamming SK's server log as `tail error: ...`.
    const errors: string[] = [];
    const lines: string[] = [];
    let exitCode: number | null | undefined;
    spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "printf 'one\\n'; printf 'two\\n' 1>&2; printf 'three\\n'"],
      (line) => lines.push(line),
      {
        binary: "/bin/bash",
        mergeStderr: true,
        onError: (msg) => errors.push(msg),
        onExit: (code) => {
          exitCode = code;
        },
      },
    );
    await waitFor(() => exitCode !== undefined, "child should exit");
    // Both stdout and stderr lines reach onLine; onError is never
    // invoked for the stderr content.  Order between the two
    // streams is best-effort (OS scheduling) — assert as a set.
    assert.deepEqual(lines.slice().sort(), ["one", "three", "two"]);
    assert.deepEqual(errors, []);
  });

  it("does not splice partial stdout and stderr chunks together (mergeStderr)", async () => {
    // Regression for the splitter-race bug: with a SINGLE shared
    // line splitter, stdout emitting "a" (no newline) followed by
    // stderr emitting "X\n" before stdout's own newline would
    // produce a spliced "aX" line and an orphan "b\n" line.  With
    // per-stream splitters each stream's partial chunks stay in
    // its own buffer until that stream supplies the newline.
    //
    // The script prints stdout "a" without newline, sleeps so the
    // OS scheduler hands control to the stderr write, then writes
    // "X\n" on stderr, then sleeps again, then completes stdout
    // with "b\n".  Under the buggy single-splitter design this
    // reliably produced ["aX", "b"]; with two splitters it must
    // produce ["ab", "X"] (any order).
    const lines: string[] = [];
    let exitCode: number | null | undefined;
    spawnRuntimeStreaming(
      runtimeStub,
      [
        "-c",
        "printf 'a'; sleep 0.05; printf 'X\\n' 1>&2; sleep 0.05; printf 'b\\n'",
      ],
      (line) => lines.push(line),
      {
        binary: "/bin/bash",
        mergeStderr: true,
        onExit: (code) => {
          exitCode = code;
        },
      },
    );
    await waitFor(() => exitCode !== undefined, "child should exit");
    // Order between the two streams is best-effort; the assertion
    // is that NO line contains the spliced byte from the OTHER
    // stream's buffer.
    assert.deepEqual(lines.slice().sort(), ["X", "ab"]);
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
