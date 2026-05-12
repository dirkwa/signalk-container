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

describe("spawnRuntimeStreaming", { skip: skipOnWindows }, () => {
  it("emits each line via onLine in order", async () => {
    const lines: string[] = [];
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "printf 'a\\nb\\nc\\n'"],
      (line) => lines.push(line),
      { binary: "/bin/bash" },
    );
    // Wait for the child to exit naturally (no -f flag, so it
    // will).  Drain microtasks via a short setImmediate loop.
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (lines.length >= 3) resolve();
        else setTimeout(tick, 20);
      };
      tick();
    });
    handle.stop();
    assert.deepEqual(lines, ["a", "b", "c"]);
  });

  it("returns a pid for a successfully-spawned child", () => {
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "sleep 60"],
      () => {},
      { binary: "/bin/bash" },
    );
    assert.equal(typeof handle.pid, "number");
    assert.ok(handle.pid! > 0);
    handle.stop();
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
    // Wait up to 3s for the exit event (SIGTERM with 2s grace,
    // then SIGKILL — should be well under 3s).
    await new Promise<void>((resolve) => {
      const tick = (n: number) => {
        if (exitCode !== undefined) resolve();
        else if (n >= 30) resolve();
        else setTimeout(() => tick(n + 1), 100);
      };
      tick(0);
    });
    assert.notEqual(exitCode, undefined, "child should have exited");
  });

  it("stop() is idempotent", () => {
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "sleep 60"],
      () => {},
      { binary: "/bin/bash" },
    );
    handle.stop();
    // Second call must not throw.
    handle.stop();
    handle.stop();
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
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(lines, ["one"]);
    // Stderr arrives as one chunk (trimmed); we deliberately don't
    // line-split it.
    assert.equal(errors.length, 1);
    assert.equal(errors[0], "two");
  });

  it("buffers partial lines across data events via makeLineSplitter", async () => {
    // `printf 'a'` followed by `printf 'bc\\n'` from the same bash
    // process emits two writes, the first without a newline.  The
    // splitter must hold "a" until "bc\n" arrives and then emit
    // "abc".
    const lines: string[] = [];
    spawnRuntimeStreaming(
      runtimeStub,
      [
        "-c",
        // The exact two-write pattern is shell-dependent; this is a
        // best-effort approach using a short sleep to encourage the
        // pipe to flush between writes.  If it doesn't trigger the
        // partial-line path on every system, the test still passes
        // (one combined "abc" emission).
        "printf 'a'; sleep 0.05; printf 'bc\\n'",
      ],
      (line) => lines.push(line),
      { binary: "/bin/bash" },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    await new Promise((resolve) => setTimeout(resolve, 200));
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exitCode, 7);
  });

  it("synchronous spawn failure (bad binary) routes via onError, returns no-op stop", () => {
    let err: string | undefined;
    const handle = spawnRuntimeStreaming(runtimeStub, [], () => {}, {
      binary: "/this/path/definitely/does/not/exist",
      onError: (msg) => {
        err = msg;
      },
    });
    // node's spawn dispatches ENOENT via the 'error' event (not
    // a sync throw on most modern node builds), so onError fires
    // asynchronously.  Either way the stop-handle must be safe.
    handle.stop();
    handle.stop();
    // Give the error event a tick.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.ok(err !== undefined, "spawn failure must surface via onError");
        resolve();
      }, 100);
    });
  });

  it("stop() after natural exit is harmless", async () => {
    const handle = spawnRuntimeStreaming(
      runtimeStub,
      ["-c", "exit 0"],
      () => {},
      { binary: "/bin/bash" },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    handle.stop(); // should not throw
  });
});
