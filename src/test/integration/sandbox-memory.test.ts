import { it } from "node:test";
import type { Duplex } from "node:stream";
import assert from "node:assert/strict";
import { getClient } from "../../client.js";
import { detectRuntime } from "../../runtime.js";
import { prepareSandboxJob, SandboxOutput } from "../../sandbox.js";
import { SandboxExecutor, attachSandbox } from "../../sandbox-executor.js";
import { SandboxFrames } from "../../sandbox-stream.js";
import { sandboxMemoryProbe } from "../helpers/sandbox-memory-probe.js";

const image = process.env.SANDBOX_NATIVE_TEST_IMAGE;
const runtime =
  image && process.platform !== "win32" ? await detectRuntime("auto") : null;
const skip =
  !image || !runtime
    ? "Set SANDBOX_NATIVE_TEST_IMAGE to a local trusted digest containing Node, Python 3 and GNU timeout 9.1"
    : false;

function request(code: string) {
  return {
    ownerPluginId: "sandbox-memory-integration",
    image: image!,
    runnerPath: "/usr/local/bin/node",
    stdin: Buffer.from(code),
  };
}

it(
  "native attack fixture can trace and change its child's memory under the runtime default profile",
  { skip },
  async () => {
    const client = getClient();
    const signal = AbortSignal.timeout(8000);
    const plan = await prepareSandboxJob(request(""), client, signal);
    // Positive control only: preserve all other isolation settings and use the
    // runtime default seccomp profile. The trusted fixture targets its own child,
    // never PID 1. This path is deliberately outside the production executor.
    plan.options.HostConfig!.SecurityOpt = ["no-new-privileges"];
    plan.options.Cmd = [
      "--signal=KILL",
      "5s",
      "/usr/bin/python3",
      "-c",
      sandboxMemoryProbe(false),
    ];
    const container = await client.createContainer({
      ...plan.options,
      ...{ abortSignal: signal },
    });
    const output = new SandboxOutput(8192);
    const frames = new SandboxFrames(output);
    let stream: Duplex | undefined;
    const abort = () =>
      stream?.destroy(new Error("Native fixture deadline exceeded"));
    try {
      stream = await attachSandbox(client, container.id, signal);
      signal.addEventListener("abort", abort, { once: true });
      const drained = new Promise<void>((resolve, reject) => {
        stream!.on("data", (chunk: Buffer) => {
          try {
            if (!frames.append(chunk))
              reject(new Error("Fixture output exceeded"));
          } catch (error) {
            reject(error);
          }
        });
        stream!.once("end", () => {
          try {
            frames.finish();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        stream!.once("error", reject);
        stream!.once("close", () =>
          reject(new Error("Native fixture stream closed")),
        );
      });
      void drained.catch(() => {});
      await container.start({ abortSignal: signal });
      stream.end();
      const final = await container.wait({ abortSignal: signal });
      await drained;
      assert.equal(final.StatusCode, 0, output.snapshot().toString());
      const report = JSON.parse(output.snapshot().toString());
      assert.equal(report["child.ptrace_attach"].result, 0);
      assert.equal(report["child.ptrace_seize"].result, 0);
      assert.ok(report["child.process_vm_readv"].result > 0);
      assert.ok(report["child.process_vm_writev"].result > 0);
      assert.equal(report.childMemory, "changed-marker");
    } finally {
      signal.removeEventListener("abort", abort);
      stream?.destroy();
      output.clear();
      await container.remove({
        force: true,
        v: true,
        ...{ abortSignal: AbortSignal.timeout(3000) },
      });
    }
  },
);

it(
  "custom seccomp denies real tracing and cross-process memory syscalls against PID 1 and a child",
  { skip },
  async () => {
    const code =
      'const cp = require("node:child_process");' +
      'const r = cp.spawnSync("/usr/bin/python3", ["-c", ' +
      JSON.stringify(sandboxMemoryProbe(true)) +
      '], {encoding:"utf8",timeout:5000,maxBuffer:8192});' +
      'process.stdout.write(r.stdout || "");process.stderr.write(r.stderr || "");' +
      "if(r.error)throw r.error;process.exit(r.status ?? 1);";
    const result = await new SandboxExecutor().run(request(code));
    assert.equal(
      result.status,
      "completed",
      Buffer.from(result.output).toString(),
    );
    assert.equal(result.cleanup, "removed");
    const report = JSON.parse(Buffer.from(result.output).toString());
    for (const target of ["supervisor", "child"]) {
      for (const syscall of [
        "ptrace_attach",
        "ptrace_seize",
        "process_vm_readv",
        "process_vm_writev",
      ]) {
        assert.deepEqual(report[target + "." + syscall], {
          result: -1,
          errno: 1,
        });
      }
    }
    assert.equal(report.childMemory, "private-marker");
  },
);
