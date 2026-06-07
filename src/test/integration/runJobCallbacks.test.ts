import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../../jobs.js";
import { detectRuntime } from "../../runtime.js";
import type { ContainerRuntimeInfo } from "../../types.js";

/**
 * Integration test for runJob's per-stream callbacks.  Skipped when no
 * container runtime socket is reachable (CI without podman/docker, etc.) —
 * the splitter unit tests in ../makeLineSplitter.test.ts cover the line-
 * buffering logic without needing a runtime.
 *
 * Also skipped on Windows: GitHub-hosted Windows runners ship Docker
 * Desktop in Windows-container mode, where the daemon answers but
 * `pull alpine:3.19` fails with "no matching manifest for windows/amd64"
 * — alpine has no Windows variant. These tests need a Linux container
 * daemon; no easy way to provide one on the Windows runner image.
 *
 * `detectRuntime()` resolves AND caches the dockerode client singleton, so
 * a non-null result also means `getClient()` works for the bare `runJob`
 * calls below — the same path production takes.
 */
async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
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
