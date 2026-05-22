import { ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  ContainerRuntimeInfo,
  RuntimeName,
  RuntimePreference,
} from "./types.js";

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

/**
 * Build the environment passed to every podman/docker invocation.
 * Strips systemd-activation leftovers (`LISTEN_*`) and backfills
 * `XDG_RUNTIME_DIR` so rootless Podman can locate its socket and
 * storage under system-scoped service units.
 *
 * Exported for unit tests; production callers should not need to
 * touch it directly.
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("LISTEN_")) {
      delete env[key];
    }
  }
  // Rootless Podman reads its socket and storage paths via
  // `XDG_RUNTIME_DIR` (e.g. `/run/user/<uid>/podman/podman.sock`,
  // `/run/user/<uid>/containers/...`). When Signal K runs as a
  // system-scoped systemd unit (the usual `User=signalk` setup),
  // the variable is NOT inherited from the user's session — only
  // `loginctl enable-linger` style user-scope units get it. Without
  // it, `podman info` falls back to ambiguous defaults: the rootless
  // probe returns null, socket inference produces no path, and the
  // ZFS storage probe never runs. Backfill from the process UID
  // when it's missing.
  if (
    env.XDG_RUNTIME_DIR === undefined &&
    typeof process.getuid === "function"
  ) {
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }
  return env;
}

/**
 * Result shape for `execFile`-style runtime probes. Exposed for the
 * injectable `ExecFn` used by `detectRuntime` tests.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Injectable command-runner shape. The default implementation in this
 * module wraps `child_process.execFile`; tests pass a stub returning
 * canned `ExecResult`s so detection logic can be exercised without a
 * real podman/docker installation.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => Promise<ExecResult>;

const defaultExec: ExecFn = (cmd, args, env) => {
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
            ? typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : 1
            : 0,
        });
      },
    );
  });
};

/**
 * Socket paths probed when falling back to podman-remote mode. The
 * canonical mount point for both Docker-style and Podman setups is
 * `/var/run/docker.sock`; `/run/docker.sock` covers distros where
 * `/var/run` isn't symlinked to `/run`.
 */
const REMOTE_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock"];

/**
 * Pick a socket to use for podman-remote fallback. `CONTAINER_HOST`
 * (podman's canonical remote-mode env var) wins when set; otherwise
 * we look for a bind-mounted Docker-style socket. Returns the
 * `unix://` URL form podman expects via `--url`.
 */
function findRemoteSocket(): string | null {
  if (process.env.CONTAINER_HOST) return process.env.CONTAINER_HOST;
  for (const path of REMOTE_SOCKET_PATHS) {
    if (existsSync(path)) return `unix://${path}`;
  }
  return null;
}

async function tryRuntime(
  name: RuntimeName,
  env: NodeJS.ProcessEnv,
  exec: ExecFn = defaultExec,
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

  // For podman, validate the binary can actually operate. Inside a
  // container, the in-image podman often fails its first real call
  // with `exec: "newuidmap": executable file not found in $PATH`
  // because the image lacks the `uidmap` package and rootless
  // user-namespace mapping can't proceed. If a host podman socket is
  // bind-mounted in we transparently switch to `--remote --url
  // <socket>` so commands route to the host daemon — the actual
  // runtime stays podman, the in-container binary just acts as a
  // client.
  let remoteSocketUrl: string | undefined;
  if (realRuntime === "podman") {
    const directInfo = await exec(name, ["info"], env);
    if (directInfo.exitCode !== 0) {
      const socket = isContainerized() ? findRemoteSocket() : null;
      if (socket === null) return null;
      const remoteInfo = await exec(
        name,
        ["--remote", "--url", socket, "info"],
        env,
      );
      if (remoteInfo.exitCode !== 0) return null;
      remoteSocketUrl = socket;
    }
  }

  const prefixArgs = remoteArgs(remoteSocketUrl);
  const cgroupControllers = await probeCgroupControllers(
    realRuntime,
    env,
    prefixArgs,
    exec,
  );
  const isRootless = await probeRootless(realRuntime, env, prefixArgs, exec);
  const hostUser = probeHostUser();

  return {
    runtime: realRuntime,
    version,
    isPodmanDockerShim,
    cgroupControllers,
    isRootless,
    hostUser,
    remoteSocketUrl,
  };
}

/**
 * Prefix args to prepend to every podman invocation when the runtime
 * is operating in remote-fallback mode. Empty for local invocations
 * and for docker (DOCKER_HOST env handles docker's equivalent path).
 */
function remoteArgs(remoteSocketUrl: string | undefined): string[] {
  return remoteSocketUrl ? ["--remote", "--url", remoteSocketUrl] : [];
}

/**
 * Resolve the effective host user (uid/gid) that managed containers
 * should run as.  Source of truth is the Signal K server's own
 * process — files created inside a container started with `--user
 * <uid>:<gid>` (or `--userns=keep-id` on rootless Podman) end up
 * owned by this same identity on the host, so a chmod sweep is no
 * longer necessary.
 *
 * Returns `null` on platforms where `process.getuid`/`process.getgid`
 * are undefined (Windows); the upcoming ownership translator must
 * suppress `--user` flags in that case.
 */
export function probeHostUser(): { uid: number; gid: number } | null {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return null;
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

/**
 * Host UID/GID resolver indirection so unit tests can stub it instead
 * of being at the mercy of whoever runs `npm test` (root in CI vs.
 * 1000 on a dev box). Windows has no UID concept and
 * `process.getuid` is undefined there — falls back to `null` and the
 * flag emitter then skips the mapping.
 */
let currentHostIds: () => { uid: number; gid: number } | null = probeHostUser;

/**
 * Test-only override for the host UID/GID resolver. Stubs let unit
 * tests assert flag emission against deterministic UIDs without
 * needing a particular runtime user.
 */
export function _setCurrentHostIdsForTesting(
  fn: (() => { uid: number; gid: number } | null) | null,
): void {
  currentHostIds = fn ?? probeHostUser;
}

/**
 * Module-level "skip user-namespace remapping" toggle. When `true`,
 * `userMappingFlags()` suppresses the rootless-Podman `--userns=keep-id`
 * flag and emits no flag at all on that branch (the in-image root then
 * maps to the host caller via the default rootless userns).
 *
 * Set from the plugin config (`disableUserNamespaceRemap`) for hosts
 * where the kernel cannot id-map the bind-mount backing filesystem and
 * `--userns=keep-id` aborts at container create time with
 * `crun: writing file /proc/<pid>/gid_map: Invalid argument`. ZFS is
 * the common case (`idmapped mounts` support is filesystem-specific
 * and kernel-version-dependent); some encrypted filesystems behave
 * the same way.
 */
let usernsRemapDisabled = false;

/**
 * Apply the plugin-config "disable user-namespace remap" toggle.
 * Called from `plugin.start()` whenever the config is (re)read.
 * Defaults to `false` so existing deployments keep the historical
 * keep-id behaviour verbatim.
 */
export function setDisableUserns(disabled: boolean): void {
  usernsRemapDisabled = disabled === true;
}

/**
 * Read the current "disable user-namespace remap" toggle. Exposed
 * for tests; consumer code should not need to call this directly.
 */
export function isDisableUserns(): boolean {
  return usernsRemapDisabled;
}

/**
 * Shape shared by `ContainerJobConfig.user` and `ContainerConfig.user`.
 * Inline-typed rather than imported to keep `runtime.ts` free of
 * `types.ts` imports (it's the lowest layer).
 */
type UserMappingIntent =
  | { inImageUid?: number; inImageGid?: number }
  | false
  | undefined;

/**
 * Build the UID-mapping flags to pass to the runtime for one
 * container. Used by both `runJob` (one-shot helpers) and
 * `buildRunArgs` (long-running managed containers) so the decision
 * matrix is identical across both code paths.
 *
 * The decision matrix:
 *
 *   - `user === false` → no flag. Caller opted out (debugging, or the
 *     container doesn't write to a host-owned bind mount).
 *   - host UID resolver returns null (Windows) → no flag. Docker
 *     Desktop / Windows handles UID translation internally.
 *   - rootless Podman with `disableUserNamespaceRemap` active → no
 *     flag. Used on hosts whose backing filesystem refuses kernel
 *     idmapped mounts (ZFS being the canonical case). Container runs
 *     in the default rootless userns; for root-by-default images
 *     (`inImageUid === 0`) bind-mount file ownership still lands on
 *     the host caller. Non-root in-image images give up host-caller
 *     ownership in exchange for being able to start at all.
 *   - rootless Podman → `--userns=keep-id:uid=<inImageUID>,gid=<inImageGID>`.
 *     Rewrites the in-image UID back to the host caller via the user-
 *     namespace mapping; rootful Podman would error on the same flag.
 *   - everything else (Docker, rootful Podman) →
 *     `--user <hostUID>:<hostGID>`. Sets the in-container process UID
 *     directly to the host caller's UID.
 *
 * `inImageUID/GID` defaults to 0 when the caller doesn't pass them —
 * matching the historical behaviour of helper images shipped before
 * this field existed (osgeo/gdal, the legacy tippecanoe image, …).
 * Images with a non-root `USER` directive (e.g. `charts-toolbox`'s
 * `USER toolbox` at UID 1001) need the caller to declare the right
 * value.
 */
export function userMappingFlags(
  runtime: ContainerRuntimeInfo,
  user: UserMappingIntent,
  resolveHost: () => { uid: number; gid: number } | null = currentHostIds,
): string[] {
  if (user === false) {
    return [];
  }
  const host = resolveHost();
  if (host === null) {
    return [];
  }
  const inImageUid = user?.inImageUid ?? 0;
  const inImageGid = user?.inImageGid ?? 0;
  // Reject negatives, NaN, and non-integers. The TS shape says
  // `number` but JS callers can still pass garbage — emitting
  // `--userns=keep-id:uid=NaN,gid=-1` would let podman/docker produce
  // an obscure runtime error far from the call site. Throw here so
  // the consumer plugin's promise rejects with a clear message before
  // the container even starts.
  assertNonNegativeInt("inImageUid", inImageUid);
  assertNonNegativeInt("inImageGid", inImageGid);

  if (runtime.runtime === "podman" && runtime.isRootless === true) {
    if (usernsRemapDisabled) {
      return [];
    }
    return ["--userns", `keep-id:uid=${inImageUid},gid=${inImageGid}`];
  }
  return ["--user", `${host.uid}:${host.gid}`];
}

function assertNonNegativeInt(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `user.${field} must be a non-negative integer, got ${String(value)}`,
    );
  }
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
  prefixArgs: string[] = [],
  exec: ExecFn = defaultExec,
): Promise<boolean | null> {
  if (runtime !== "podman") {
    return false;
  }
  const result = await exec(
    "podman",
    [...prefixArgs, "info", "--format", "{{.Host.Security.Rootless}}"],
    env,
  );
  if (result.exitCode !== 0) {
    return null;
  }
  // Some podman setups print a warning to stdout above the template
  // value (e.g. `WARN[0000] ...\ntrue`) when rootless state can't be
  // cached. Take the last non-empty line and require it to be exactly
  // `true` or `false`. Anything else (warning-only output, prose
  // ending in the word "true", JSON, older podman that doesn't expose
  // Host.Security.Rootless) falls through to `null`.
  const lastLine = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (lastLine === "true" || lastLine === "false") {
    return lastLine === "true";
  }
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
  prefixArgs: string[] = [],
  exec: ExecFn = defaultExec,
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
    [...prefixArgs, "info", "--format", "{{json .Host.CgroupControllers}}"],
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
  exec: ExecFn = defaultExec,
): Promise<ContainerRuntimeInfo | null> {
  const env = cleanEnv();

  if (preference !== "auto") {
    return tryRuntime(preference, env, exec);
  }

  const podman = await tryRuntime("podman", env, exec);
  if (podman) return podman;

  const docker = await tryRuntime("docker", env, exec);
  if (docker) return docker;

  return null;
}

export function runtimeCmd(info: ContainerRuntimeInfo): string {
  return info.isPodmanDockerShim ? "docker" : info.runtime;
}

/**
 * Build the full argv for a runtime invocation. Prepends
 * `--remote --url <socket>` when `info.remoteSocketUrl` is set so
 * commands route to a host podman daemon instead of attempting local
 * execution; otherwise returns args unchanged.
 */
function runtimeArgv(info: ContainerRuntimeInfo, args: string[]): string[] {
  return info.remoteSocketUrl
    ? ["--remote", "--url", info.remoteSocketUrl, ...args]
    : args;
}

export async function execRuntime(
  info: ContainerRuntimeInfo,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return defaultExec(runtimeCmd(info), runtimeArgv(info, args), cleanEnv());
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
  const fullArgs = runtimeArgv(info, args);
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
    const proc = execFile(cmd, fullArgs, {
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
    /** Route stderr through the same line splitter as stdout so
     *  both streams reach `onLine`.  Needed for `podman logs -f`
     *  / `docker logs -f` where the runtime forwards the
     *  container's stdout and stderr on its own stdout and stderr
     *  fds respectively — without this, anything the container
     *  writes to stderr (which for many Rust/Go apps is *every*
     *  log line) never reaches the consumer.  Default false to
     *  preserve the original semantics where stderr was treated
     *  as runtime diagnostics. */
    mergeStderr?: boolean;
    /** Test injection: override the binary path.  Production uses
     *  `runtimeCmd(info)`. */
    binary?: string;
    /** Test injection: override the env (or test-only stdin). */
    env?: NodeJS.ProcessEnv;
  },
): StreamingProcessHandle {
  const cmd = options?.binary ?? runtimeCmd(info);
  const fullArgs = runtimeArgv(info, args);
  const env = options?.env ?? cleanEnv();
  const mergeStderr = options?.mergeStderr ?? false;

  let stopped = false;
  let proc: ChildProcess | null = null;
  try {
    proc = spawn(cmd, fullArgs, {
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

  // Each stream gets its own line splitter so partial chunks from
  // one stream can't be appended to a partial chunk from the other.
  // Without this, if stdout writes "abc" (no `\n` yet) and stderr
  // writes "XYZ\n" before stdout completes its line, a single
  // shared splitter would emit "abcXYZ" as one line — splicing
  // bytes from two unrelated streams.  Both splitters feed the
  // same `onLine` callback in merged-stderr mode, so cross-stream
  // ordering is best-effort (whichever stream completes a line
  // first emits first), but each stream's own ordering is
  // preserved and no characters bleed across.
  const stdoutSplitter = makeLineSplitter(onLine);
  const stderrSplitter = mergeStderr ? makeLineSplitter(onLine) : null;

  proc.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutSplitter.push(chunk.toString());
  });

  if (stderrSplitter) {
    // Container stderr lines join the line stream alongside stdout.
    // Runtime-level diagnostics (e.g. "Error: no such container")
    // arrive on the same channel; they're indistinguishable from
    // container output without per-line metadata, but in practice
    // they're rare and clearly recognizable.
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderrSplitter.push(chunk.toString());
    });
  } else {
    // Stderr is treated as out-of-band runtime diagnostics.  Usually
    // empty; when non-empty the line is almost always a single
    // short message ("Error: no such container") so don't bother
    // splitting — trim and route verbatim.
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString().trimEnd();
      if (text.length > 0) options?.onError?.(text);
    });
  }

  proc.on("error", (err) => {
    options?.onError?.(err.message);
  });

  proc.on("close", (code) => {
    stdoutSplitter.flush();
    stderrSplitter?.flush();
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
