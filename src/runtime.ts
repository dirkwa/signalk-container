import { execFile } from "child_process";
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

  return {
    runtime: realRuntime,
    version,
    isPodmanDockerShim,
    cgroupControllers,
  };
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
