import { ChildProcess, execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { ContainerRuntimeInfo, RuntimeName, RuntimePreference } from "./types";

/**
 * Detect if the Signal K server is itself running inside a container.
 * Indicators:
 * - /.dockerenv file (Docker)
 * - /run/.containerenv file (Podman)
 * - container env var (some setups)
 */
export function isContainerized(): boolean {
  return (
    existsSync("/.dockerenv") ||
    existsSync("/run/.containerenv") ||
    process.env.container !== undefined
  );
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("LISTEN_")) {
      delete env[key];
    }
  }
  return env;
}

function exec(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: env ?? cleanEnv(), timeout: 10000 },
      (error, stdout, stderr) => {
        resolve({
          stdout: (stdout ?? "").toString().trim(),
          stderr: (stderr ?? "").toString().trim(),
          exitCode: error
            ? typeof (error as any).code === "number"
              ? (error as any).code
              : 1
            : 0,
        });
      },
    );
  });
}

async function tryRuntime(
  name: RuntimeName,
  env: NodeJS.ProcessEnv,
): Promise<ContainerRuntimeInfo | null> {
  const result = await exec(name, ["--version"], env);
  if (result.exitCode !== 0) return null;

  const version =
    result.stdout.replace(/^.*version\s*/i, "").split(/[\s,]/)[0] || "unknown";
  let isPodmanDockerShim = false;

  if (name === "docker") {
    isPodmanDockerShim = result.stdout.toLowerCase().includes("podman");
  }

  const realRuntime: RuntimeName = isPodmanDockerShim ? "podman" : name;
  const cgroupControllers = await probeCgroupControllers(realRuntime, env);
  const isRootless = await probeRootless(realRuntime, env);

  return {
    runtime: realRuntime,
    version,
    isPodmanDockerShim,
    cgroupControllers,
    isRootless,
  };
}

/**
 * Detect rootless mode.  Matters for Podman because `--userns=keep-id`
 * (used by `jobs.ts` to align bind-mount file ownership) is rootless-
 * only — emitting it under rootful Podman errors out at container
 * create time.  Docker is left as `false` regardless: rootless Docker
 * accepts the same `--user` flag form as rootful, so the distinction
 * doesn't change our flag-emission logic.
 */
async function probeRootless(
  runtime: RuntimeName,
  env: NodeJS.ProcessEnv,
): Promise<boolean | null> {
  if (runtime !== "podman") {
    return false;
  }
  const result = await exec(
    "podman",
    ["info", "--format", "{{.Host.Security.Rootless}}"],
    env,
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const trimmed = result.stdout.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return null;
}

/**
 * Query the runtime for which cgroup v2 controllers are actually
 * available to it. This matters for rootless podman, which on many
 * systems has cgroup delegation only for `cpu memory pids` and is
 * missing `cpuset` (the systemd default delegate-controllers list
 * does not include cpuset).
 *
 * Returns an array of controller names for podman, or `null` for
 * docker (which doesn't expose this via `info --format` and where
 * full controller availability is the typical case).
 */
async function probeCgroupControllers(
  runtime: RuntimeName,
  env: NodeJS.ProcessEnv,
): Promise<string[] | null> {
  if (runtime !== "podman") {
    // Docker doesn't expose CgroupControllers via `info --format`.
    // Assume all controllers are available — docker typically runs
    // as root with full systemd delegation, so this is correct in
    // the common case. Users hitting cgroup limitations on docker
    // can still see the original runtime error and adjust.
    return null;
  }

  const result = await exec(
    "podman",
    ["info", "--format", "{{json .Host.CgroupControllers}}"],
    env,
  );
  if (result.exitCode !== 0) {
    // Older podman versions, or podman info hung — fall back to
    // "not probed" rather than misleadingly empty.
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed;
    }
  } catch {
    // Malformed JSON — treat as not probed.
  }
  return null;
}

export async function detectRuntime(
  preference: RuntimePreference,
): Promise<ContainerRuntimeInfo | null> {
  const env = cleanEnv();

  if (preference !== "auto") {
    return tryRuntime(preference, env);
  }

  const podman = await tryRuntime("podman", env);
  if (podman) return podman;

  const docker = await tryRuntime("docker", env);
  if (docker) return docker;

  return null;
}

export function runtimeCmd(info: ContainerRuntimeInfo): string {
  return info.isPodmanDockerShim ? "docker" : info.runtime;
}

export async function execRuntime(
  info: ContainerRuntimeInfo,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return exec(runtimeCmd(info), args, cleanEnv());
}

/**
 * Buffered line splitter for stdout/stderr chunks.  Returns a function
 * that takes raw chunk strings and emits complete lines, holding partial
 * data across calls so a line split across two `data` events is not
 * truncated.  Treats `\r\n`, bare `\n`, and bare `\r` as line terminators
 * — tools like tippecanoe repaint a progress line in place using bare
 * `\r`, and a naive `split("\n")` would silently swallow every update
 * after the first.  Empty lines are dropped.  Call the returned `flush`
 * helper after the stream ends to emit any trailing partial data.
 */
export function makeLineSplitter(emit: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.length > 0) emit(part);
      }
    },
    flush() {
      if (buffer.length > 0) {
        emit(buffer);
        buffer = "";
      }
    },
  };
}

export async function execRuntimeLong(
  info: ContainerRuntimeInfo,
  args: string[],
  onProgress?: (msg: string) => void,
  timeout?: number,
  onStdoutLine?: (line: string) => void,
  onStderrLine?: (line: string) => void,
): Promise<{ exitCode: number; log: string[] }> {
  const cmd = runtimeCmd(info);
  const env = cleanEnv();
  const log: string[] = [];
  const maxLogLines = 200;

  const safeCall = (cb: ((line: string) => void) | undefined, line: string) => {
    if (!cb) return;
    try {
      cb(line);
    } catch {
      /* plugin callback errors must not crash us */
    }
  };

  return new Promise((resolve, reject) => {
    // No default timeout: long-running container jobs (chart conversions,
    // big GDAL/tippecanoe runs) can legitimately take hours.  Imposing a
    // surprise 10-minute default cap turned ENC bundles approaching 100%
    // into "command exited 126 with empty log" failures.  Callers that
    // actually want a wall-clock ceiling pass `timeout` explicitly (image
    // pulls, lightweight probes); everyone else gets to run to completion.
    //
    // child_process treats timeout=0 as "no timeout", so we forward it
    // when the caller didn't supply one.
    const proc = execFile(cmd, args, {
      env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeout ?? 0,
    });

    const stdoutSplitter = makeLineSplitter((line) => {
      if (log.length >= maxLogLines) log.shift();
      log.push(line);
      safeCall(onProgress, line);
      safeCall(onStdoutLine, line);
    });

    const stderrSplitter = makeLineSplitter((line) => {
      if (log.length >= maxLogLines) log.shift();
      log.push(line);
      safeCall(onProgress, line);
      safeCall(onStderrLine, line);
    });

    proc.stdout?.on("data", (data: Buffer | string) => {
      stdoutSplitter.push(data.toString());
    });

    proc.stderr?.on("data", (data: Buffer | string) => {
      stderrSplitter.push(data.toString());
    });

    proc.on("close", (code) => {
      stdoutSplitter.flush();
      stderrSplitter.flush();
      resolve({ exitCode: code ?? 1, log });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Grace period between SIGTERM and SIGKILL when `stop()`-ing a
 * streaming child.  Long enough for `podman logs -f` to flush its
 * buffers (sub-second in practice) but short enough that a stuck
 * child doesn't hold up plugin shutdown.
 */
export const SIGTERM_GRACE_PERIOD_MS = 2000;

/**
 * Handle returned by `spawnRuntimeStreaming`.  The caller MUST call
 * `stop()` when done — the underlying process does not exit on its
 * own for `-f`/follow-style commands.
 */
export interface StreamingProcessHandle {
  /** Stop the child.  Sends SIGTERM, then SIGKILL after a grace
   *  period if the process is still alive.  Idempotent. */
  stop(): void;
  /** Child PID, or undefined if the process never started (e.g.
   *  synchronous spawn failure).  Exposed for debug logging only;
   *  do not signal it directly. */
  pid: number | undefined;
}

/**
 * Spawn a long-running runtime command (typically `podman logs -f`
 * or `docker logs -f`) and stream its stdout line-by-line into
 * `onLine`.  Stderr is funneled to `onError` so the caller can
 * surface runtime diagnostics (`podman logs died with exit 137`)
 * without interleaving them into the container's log stream.
 *
 * Unlike `execRuntimeLong`, this function returns synchronously
 * with a stop-handle — its primary use case is following streams
 * that never naturally exit.  The line splitter handles `\n`,
 * `\r\n`, and bare `\r`; partial lines across reads are buffered
 * via the existing `makeLineSplitter`.
 *
 * Optional `onExit` fires once when the underlying process exits
 * for any reason (natural EOF, `stop()` called, child crash).
 * Used by `LogStreamBroker` to detect that its tail died on its
 * own (e.g. the container was removed) and null out its cached
 * handle so the next subscribe respawns.
 *
 * `binary` and `env` are exposed for testability; production
 * callers go through `tailContainerLogs` which fills them in.
 */
export function spawnRuntimeStreaming(
  info: ContainerRuntimeInfo,
  args: string[],
  onLine: (line: string) => void,
  options?: {
    onError?: (msg: string) => void;
    onExit?: (code: number | null) => void;
    /** Test injection: override the binary path.  Production uses
     *  `runtimeCmd(info)`. */
    binary?: string;
    /** Test injection: override the env (or test-only stdin). */
    env?: NodeJS.ProcessEnv;
  },
): StreamingProcessHandle {
  const cmd = options?.binary ?? runtimeCmd(info);
  const env = options?.env ?? cleanEnv();

  let stopped = false;
  let proc: ChildProcess | null = null;
  try {
    proc = spawn(cmd, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // spawn() throws synchronously on ENOENT only in some node
    // builds; on others the error arrives via the 'error' event.
    // Surface either flavour to onError and return a handle whose
    // stop() is a no-op.
    options?.onError?.(err instanceof Error ? err.message : String(err));
    return { stop: () => {}, pid: undefined };
  }

  const splitter = makeLineSplitter(onLine);

  proc.stdout?.on("data", (chunk: Buffer | string) => {
    splitter.push(chunk.toString());
  });

  // Stderr from `logs -f` is usually empty.  When it isn't, the
  // line is almost always a single short diagnostic ("Error: no
  // such container") so don't bother splitting — trim and route
  // verbatim.
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString().trimEnd();
    if (text.length > 0) options?.onError?.(text);
  });

  proc.on("error", (err) => {
    options?.onError?.(err.message);
  });

  proc.on("close", (code) => {
    splitter.flush();
    options?.onExit?.(code);
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    // `proc.killed` reflects "have we delivered a signal yet", not
    // "is the child dead" — only `exitCode === null` tells us the
    // process is still alive and worth signalling.
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    // Grace period — give the child time to exit cleanly before
    // SIGKILL.  See SIGTERM_GRACE_PERIOD_MS.  `unref()` so the timer
    // doesn't hold the event loop open.
    //
    // Don't gate on `proc.killed` — Node flips that to true the
    // moment `proc.kill()` *delivers* a signal, not when the child
    // actually exits.  After the SIGTERM above, `proc.killed` is
    // already true, so the only reliable "child is still alive"
    // check is `proc.exitCode === null` (process hasn't exited).
    setTimeout(() => {
      if (proc && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }, SIGTERM_GRACE_PERIOD_MS).unref();
  };

  return { stop, pid: proc.pid };
}
