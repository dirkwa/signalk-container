import type Docker from "dockerode";
import { Duplex } from "node:stream";
import { getClient, type ContainerClient } from "./client.js";
import {
  prepareSandboxJob,
  SandboxOutput,
  SANDBOX_LIMITS,
  type PreparedSandboxJob,
} from "./sandbox.js";
import { SANDBOX_PROBE } from "./sandbox-probe.js";
import { SandboxFrames } from "./sandbox-stream.js";
import type { SandboxJobRequest, SandboxJobResult } from "./types.js";

const SETUP_MS = 3000;
const CLEANUP_MS = 3000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 6;

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Sandbox operation interrupted"));
    if (signal.aborted) {
      work.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function removeSandbox(
  container: Docker.Container,
  signal: AbortSignal,
): Promise<void> {
  try {
    await bounded(
      container.remove({ force: true, v: true, ...{ abortSignal: signal } }),
      signal,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "statusCode" in error &&
      error.statusCode === 404
    )
      return;
    throw error;
  }
}

function inspectIsolation(
  info: Docker.ContainerInspectInfo,
  plan: PreparedSandboxJob,
): void {
  const host = info.HostConfig;
  const expected = plan.options.HostConfig!;
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const empty = (value: unknown) =>
    value == null ||
    (typeof value === "object" && Object.keys(value).length === 0);
  if (
    !info.State.Running ||
    info.Image !== plan.options.Image ||
    info.Config.User !== "65534:65534" ||
    info.Config.Tty ||
    info.Path !== "/usr/bin/timeout" ||
    !equal(info.Args, plan.options.Cmd) ||
    !equal(info.Config.Env, plan.options.Env) ||
    !(
      "NetworkDisabled" in info.Config && info.Config.NetworkDisabled === true
    ) ||
    host.Init !== false ||
    host.OomKillDisable === true ||
    host.UTSMode === "host" ||
    !("CgroupnsMode" in host && host.CgroupnsMode === "private") ||
    !equal(info.Config.Entrypoint, plan.options.Entrypoint) ||
    !equal(info.Config.Cmd, plan.options.Cmd) ||
    host.Privileged ||
    !host.ReadonlyRootfs ||
    host.NetworkMode !== "none" ||
    !["", "private"].includes(host.PidMode ?? "") ||
    host.IpcMode !== "private" ||
    !empty(host.Binds) ||
    !empty(host.Mounts) ||
    !empty(host.Devices) ||
    !empty(host.DeviceRequests) ||
    !empty(host.CapAdd) ||
    !equal(host.CapDrop, ["ALL"]) ||
    host.RestartPolicy?.Name !== "no" ||
    host.LogConfig?.Type !== "none" ||
    !equal(host.SecurityOpt, expected.SecurityOpt) ||
    !plan.options.HostConfig!.MaskedPaths!.every((path) =>
      host.MaskedPaths?.includes(path),
    ) ||
    (info.Mounts ?? []).some(
      (mount) => mount.Type !== "tmpfs" || mount.Destination !== "/tmp",
    )
  )
    throw new Error("Sandbox isolation unavailable");
}

/** Docker's attach endpoint hijacks without consuming an options JSON body. */
export function attachSandbox(
  client: ContainerClient,
  id: string,
  signal: AbortSignal,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    if (!client.modem.dial) {
      reject(new Error("Sandbox attach unavailable"));
      return;
    }
    client.modem.dial(
      {
        path: "/containers/" + encodeURIComponent(id) + "/attach?",
        method: "POST",
        hijack: true,
        isStream: true,
        options: { stream: true, stdin: true, stdout: true, stderr: true },
        file: Buffer.alloc(0),
        abortSignal: signal,
        statusCodes: {
          200: true,
          404: "Container unavailable",
          500: "Attach failed",
        },
      },
      (error, value) => {
        if (error) reject(new Error("Sandbox attach failed"));
        else if (value instanceof Duplex) resolve(value);
        else reject(new Error("Unsupported sandbox transport"));
      },
    );
  });
}

/** One active sandbox per manager; no queue retains submitted code. */
export class SandboxExecutor {
  private active?: AbortController;
  private attempts: number[] = [];
  private cleanupPending?: Docker.Container;
  constructor(private readonly suppliedClient?: ContainerClient) {}

  cancel(): void {
    this.active?.abort();
  }

  async run(
    request: SandboxJobRequest,
    signal?: AbortSignal,
  ): Promise<SandboxJobResult> {
    const result: SandboxJobResult = {
      id: null,
      status: "isolation-unavailable",
      exitCode: null,
      oomKilled: null,
      output: new Uint8Array(),
      cleanup: "not-created",
    };
    if (this.active) return { ...result, status: "busy" };
    const now = performance.now();
    this.attempts = this.attempts.filter((time) => now - time < RATE_WINDOW_MS);
    if (this.attempts.length >= RATE_LIMIT)
      return { ...result, status: "rate-limited" };
    if (signal?.aborted) return { ...result, status: "cancelled" };
    this.attempts.push(now);
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const setup = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(SETUP_MS),
    ]);
    const lifetime = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(SETUP_MS + SANDBOX_LIMITS.executionMs),
    ]);
    const output = new SandboxOutput();
    let container: Docker.Container | undefined;
    let stream: Duplex | undefined;
    let plan: PreparedSandboxJob | undefined;
    let released = false;
    let outputFailure: "output-limit" | "runtime-error" | undefined;
    try {
      const client = this.suppliedClient ?? getClient();
      if (this.cleanupPending) {
        result.cleanup = "pending";
        await removeSandbox(this.cleanupPending, setup);
        this.cleanupPending = undefined;
        result.cleanup = "not-created";
      }
      plan = await bounded(prepareSandboxJob(request, client, setup), setup);
      result.id = plan.id;
      // The API field is newer than dockerode's types.
      plan.options.HostConfig = {
        ...plan.options.HostConfig,
        ...{ CgroupnsMode: "private" },
      };
      const creating = client.createContainer({
        ...plan.options,
        ...{ abortSignal: setup },
      });
      // A late create must never start, and must not leave an unowned orphan.
      void creating.then(
        (late) => {
          if (setup.aborted)
            void late
              .remove({
                force: true,
                v: true,
                ...{ abortSignal: AbortSignal.timeout(CLEANUP_MS) },
              })
              .catch(() => {});
        },
        () => {},
      );
      result.cleanup = "pending";
      container = await bounded(creating, setup);
      const attaching = attachSandbox(client, container.id, lifetime);
      void attaching.then(
        (late) => {
          if (setup.aborted && late instanceof Duplex) late.destroy();
        },
        () => {},
      );
      const attached = await bounded(attaching, setup);
      if (!(attached instanceof Duplex))
        throw new Error("Unsupported sandbox transport");
      stream = attached;
      const frames = new SandboxFrames(output);
      const drained = new Promise<void>((resolve) => {
        stream!.on("data", (chunk: Buffer) => {
          try {
            if (!frames.append(chunk)) {
              outputFailure = "output-limit";
              controller.abort();
            }
          } catch {
            outputFailure = "runtime-error";
            controller.abort();
          }
        });
        stream!.once("end", () => {
          try {
            frames.finish();
          } catch {
            outputFailure = "runtime-error";
            controller.abort();
          }
          resolve();
        });
        stream!.once("error", () => {
          if (!lifetime.aborted) {
            outputFailure ??= "runtime-error";
            controller.abort();
          }
          resolve();
        });
        stream!.once("close", () => {
          if (!stream!.readableEnded && !lifetime.aborted) {
            outputFailure ??= "runtime-error";
            controller.abort();
          }
          resolve();
        });
      });
      await bounded(container.start({ ...{ abortSignal: setup } }), setup);
      inspectIsolation(
        await bounded(container.inspect({ ...{ abortSignal: setup } }), setup),
        plan,
      );
      await this.probe(container, setup);
      if (setup.aborted) throw new Error("Sandbox preflight interrupted");
      released = true;
      result.status = "runtime-error";
      // stdin is not a command-line argument, file, label or log entry.
      // Do not mutate the Buffer until the socket has finished writing it.
      const input = plan.stdin;
      stream.end(input, () => input.fill(0));
      try {
        await bounded(
          container.wait({ ...{ abortSignal: lifetime } }),
          lifetime,
        );
        await bounded(drained, lifetime);
        const final = await bounded(
          container.inspect({ ...{ abortSignal: lifetime } }),
          lifetime,
        );
        result.exitCode = final.State.ExitCode;
        result.oomKilled = final.State.OOMKilled;
        result.status = final.State.ExitCode === 0 ? "completed" : "failed";
        // GNU timeout --signal=KILL kills its process group and PID 1.
        // Exit 137 alone can also be OOM/self-kill; never label it a proven timeout.
        if (outputFailure) result.status = outputFailure;
      } catch {
        result.status =
          outputFailure ??
          (controller.signal.aborted ? "cancelled" : "deadline-exceeded");
      }
    } catch {
      result.status =
        outputFailure ??
        (controller.signal.aborted
          ? "cancelled"
          : released
            ? "runtime-error"
            : "isolation-unavailable");
    } finally {
      stream?.destroy();
      plan?.stdin.fill(0);
      result.output = output.snapshot();
      output.clear();
      if (container) {
        try {
          const cleanupSignal = AbortSignal.timeout(CLEANUP_MS);
          await removeSandbox(container, cleanupSignal);
          result.cleanup = "removed";
        } catch {
          result.cleanup = "pending";
          this.cleanupPending = container;
        }
      }
      signal?.removeEventListener("abort", abort);
      this.active = undefined;
    }
    return result;
  }

  private async probe(
    container: Docker.Container,
    signal: AbortSignal,
  ): Promise<void> {
    const exec = await bounded(
      container.exec({
        Cmd: [
          "/usr/local/bin/node",
          "--input-type=commonjs",
          "-e",
          SANDBOX_PROBE,
        ],
        User: "65534:65534",
        AttachStdout: true,
        AttachStderr: true,
        ...{ abortSignal: signal },
      }),
      signal,
    );
    const starting = exec.start({
      hijack: true,
      stdin: false,
      ...{ abortSignal: signal },
    });
    void starting.then(
      (late) => {
        if (signal.aborted) late.destroy();
      },
      () => {},
    );
    const stream = await bounded(starting, signal);
    const output = new SandboxOutput(4096);
    const frames = new SandboxFrames(output);
    try {
      await bounded(
        new Promise<void>((resolve, reject) => {
          stream.on("data", (chunk: Buffer) => {
            try {
              if (!frames.append(chunk))
                reject(new Error("Probe output exceeded"));
            } catch {
              reject(new Error("Invalid probe stream"));
            }
          });
          stream.once("end", () => {
            try {
              frames.finish();
              resolve();
            } catch {
              reject(new Error("Truncated probe"));
            }
          });
          stream.once("error", reject);
          stream.once("close", () => reject(new Error("Probe stream closed")));
        }),
        signal,
      );
      if (output.snapshot().toString() !== "sandbox-isolation-v1\n")
        throw new Error("Sandbox isolation unavailable");
    } finally {
      stream.destroy();
      output.clear();
    }
  }
}
