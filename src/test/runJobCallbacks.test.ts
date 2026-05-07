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

describe("runJob resource limits", () => {
  it("applies --cpus to the helper container (cgroup v2 quota visible inside)", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const lines: string[] = [];
    const result = await runJob(runtime, {
      image: "docker.io/library/alpine:3.19",
      // cgroup v2 exposes the configured quota as `<quota> <period>` in
      // cpu.max.  With --cpus 0.5, that's `50000 100000` (50ms quota per
      // 100ms period).  We assert the quota is non-"max" — meaning a
      // limit was actually applied — without pinning a specific number,
      // since the runtime can round.
      command: ["cat", "/sys/fs/cgroup/cpu.max"],
      resources: { cpus: 0.5 },
      onStdoutLine: (line) => lines.push(line),
      timeout: 60,
    });

    assert.equal(result.exitCode, 0, `job failed: ${result.error ?? ""}`);
    const quota = lines[0]?.split(/\s+/)[0];
    assert.ok(
      quota !== undefined && quota !== "max",
      `expected a numeric quota but got ${JSON.stringify(lines)}`,
    );
    // 0.5 cores ≈ 50000 microseconds per 100ms period.  Allow some slack
    // (rounding, runtime quirks): quota should be in the 30000..70000 range.
    const n = Number(quota);
    assert.ok(
      Number.isFinite(n) && n >= 30000 && n <= 70000,
      `expected ~50000 quota for cpus=0.5, got ${quota}`,
    );
  });

  it("works without resources (no flags applied)", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    const lines: string[] = [];
    const result = await runJob(runtime, {
      image: "docker.io/library/alpine:3.19",
      command: ["cat", "/sys/fs/cgroup/cpu.max"],
      onStdoutLine: (line) => lines.push(line),
      timeout: 60,
    });

    assert.equal(result.exitCode, 0, `job failed: ${result.error ?? ""}`);
    // Without --cpus, the cgroup quota is "max" — no limit imposed by us.
    // (Some hosts may have an outer cgroup that imposes a number; the test
    // just asserts the call succeeds, since the no-limit-by-us behaviour
    // is what matters.)
    assert.ok(lines.length > 0, `expected output but got nothing`);
  });
});

describe("runJob default timeout", () => {
  it("does not impose a default timeout when caller omits one", async (t) => {
    const runtime = await hasContainerRuntime();
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    // Regression: runJob used to impose a 10-minute default cap, which
    // silently killed long-running tippecanoe jobs at 97.9% ("exit 126,
    // empty log").  Confirm a 5-second sleep completes cleanly without
    // config.timeout set — that's the practical signal that no default
    // timeout is being applied.
    //
    // Pre-warm the image so the wall-clock measurement isn't skewed by
    // a first-run pull on CI.
    const warmup = await runJob(runtime, {
      image: "docker.io/library/alpine:3.19",
      command: ["true"],
    });
    assert.equal(
      warmup.exitCode,
      0,
      `image pre-warm failed: ${warmup.error ?? ""}`,
    );
    const start = Date.now();
    const result = await runJob(runtime, {
      image: "docker.io/library/alpine:3.19",
      command: ["sh", "-c", "sleep 5; echo ok"],
    });
    assert.equal(result.exitCode, 0, `job failed: ${result.error ?? ""}`);
    assert.ok(
      Date.now() - start >= 4500,
      "expected ~5s wall time, got too fast — sleep got cut?",
    );
  });
});
