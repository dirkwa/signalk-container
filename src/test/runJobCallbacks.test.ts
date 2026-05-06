import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "child_process";
import { promisify } from "util";
import { makeLineSplitter } from "../runtime";
import { runJob } from "../jobs";
import type { ContainerRuntimeInfo } from "../types";

const execFileP = promisify(execFile);

describe("makeLineSplitter", () => {
  it("emits one line per LF", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("a\nb\nc\n");
    s.flush();
    assert.deepEqual(lines, ["a", "b", "c"]);
  });

  it("treats CRLF, LF and bare CR as line terminators", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    // tippecanoe-style: same line repainted with bare \r, then a real \n
    s.push("progress 10%\rprogress 20%\rprogress 30%\nfinal\n");
    s.flush();
    assert.deepEqual(lines, [
      "progress 10%",
      "progress 20%",
      "progress 30%",
      "final",
    ]);
  });

  it("buffers partial lines across pushes", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("hel");
    s.push("lo\nwor");
    s.push("ld");
    assert.deepEqual(lines, ["hello"]);
    s.flush();
    assert.deepEqual(lines, ["hello", "world"]);
  });

  it("drops empty lines", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("\n\na\n\nb\n");
    s.flush();
    assert.deepEqual(lines, ["a", "b"]);
  });
});

/**
 * Integration test for runJob's per-stream callbacks.  Skipped when no
 * container runtime is available (CI without podman/docker, etc.) — the
 * splitter unit tests above cover the line-buffering logic without
 * needing a runtime.
 */
async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  for (const rt of ["podman", "docker"] as const) {
    try {
      await execFileP(rt, ["--version"], { timeout: 5000 });
      return {
        runtime: rt,
        version: "test",
        isPodmanDockerShim: false,
      };
    } catch {
      // try next
    }
  }
  return null;
}

describe("runJob per-stream callbacks", () => {
  it("routes stdout and stderr to separate callbacks while still firing onProgress", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const progressLines: string[] = [];

    const result = await runJob(runtime, {
      image: "docker.io/library/alpine:3.19",
      command: ["sh", "-c", "echo to-stdout; echo to-stderr 1>&2"],
      onStdoutLine: (line) => stdoutLines.push(line),
      onStderrLine: (line) => stderrLines.push(line),
      onProgress: (line) => progressLines.push(line),
      timeout: 60,
    });

    assert.equal(result.exitCode, 0, `job failed: ${result.error ?? ""}`);
    assert.ok(
      stdoutLines.includes("to-stdout"),
      `stdout missing: ${JSON.stringify(stdoutLines)}`,
    );
    assert.ok(
      stderrLines.includes("to-stderr"),
      `stderr missing: ${JSON.stringify(stderrLines)}`,
    );
    assert.ok(progressLines.includes("to-stdout"));
    assert.ok(progressLines.includes("to-stderr"));
    assert.ok(!stdoutLines.includes("to-stderr"));
    assert.ok(!stderrLines.includes("to-stdout"));
  });
});
