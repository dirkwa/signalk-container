/**
 * dockerode client: socket selection, the shared singleton, and the `safe()`
 * error-normalizing wrapper. Every runtime call in the plugin goes through the
 * `ContainerClient` returned by `getClient()`.
 *
 * Why a unix socket and not the podman/docker CLI: the plugin runs inside the
 * Signal K server container, where the host runtime socket is bind-mounted
 * (`/var/run/docker.sock` in the universal-installer topology). Talking the
 * Docker API directly over that socket removes the need for any runtime CLI
 * binary in the Signal K base image, and removes the whole class of
 * podman-docker-shim flag-validation workarounds the CLI path needed — the API
 * accepts podman-specific create fields (e.g. `HostConfig.UsernsMode:
 * "keep-id"`) with no client-side validation.
 *
 * Adapted from signalk-updater-server/src/podman/client.ts (the proven dockerode
 * wrapper shared across the engine containers).
 */
import Docker from "dockerode";
import { stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { categorizeError, type CategorizedError } from "./errors.js";

/**
 * The dockerode surface the plugin actually uses. Production passes the real
 * `Docker` instance; tests pass a hand-rolled mock implementing only the
 * methods in play. This is the injection seam that replaced the CLI-era
 * `ExecFn` stub: instead of feeding canned `{stdout, exitCode}` strings, tests
 * stub typed dockerode methods and assert object-field access.
 */
export interface ContainerClient {
  getContainer(id: string): Docker.Container;
  getImage(name: string): Docker.Image;
  getNetwork(id: string): Docker.Network;
  createContainer(
    opts: Docker.ContainerCreateOptions,
  ): Promise<Docker.Container>;
  createNetwork(opts: Docker.NetworkCreateOptions): Promise<Docker.Network>;
  listContainers(
    opts?: Docker.ContainerListOptions,
  ): Promise<Docker.ContainerInfo[]>;
  pull(repoTag: string, opts?: object): Promise<NodeJS.ReadableStream>;
  pruneImages(opts?: object): Promise<Docker.PruneImagesInfo>;
  version(): Promise<Docker.DockerVersion>;
  info(): Promise<unknown>;
  /** docker-modem; typed `any` upstream. Used for followProgress + demuxStream. */
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (error: Error | null, result: unknown[]) => void,
      onProgress?: (obj: unknown) => void,
    ): void;
    demuxStream(
      stream: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
    ): void;
  };
}

/** Runtime the caller prefers when more than one socket is reachable. */
export type SocketPreference = "auto" | "podman" | "docker";

/**
 * Socket candidates, in priority order. The first that answers `version()`
 * wins. `DOCKER_HOST`/`CONTAINER_HOST` (the docker/podman remote-mode env vars)
 * take precedence so an explicitly configured endpoint is always honoured.
 *
 * `preference` biases the conventional-path order so a host with BOTH a
 * podman and a docker socket reachable still honours `PluginConfig.runtime`:
 * "podman" tries the podman sockets first, "docker" tries the docker sockets
 * first, "auto" keeps the historical podman-first order.
 * `/var/run/docker.sock` is the universal-installer bind-mount target.
 */
function socketCandidates(preference: SocketPreference = "auto"): string[] {
  const candidates: string[] = [];
  for (const envVar of [process.env.DOCKER_HOST, process.env.CONTAINER_HOST]) {
    if (envVar) {
      const path = envVar.startsWith("unix://")
        ? envVar.slice("unix://".length)
        : envVar;
      candidates.push(path);
    }
  }
  const uid = process.getuid?.() ?? 1000;
  const podmanPaths = [
    `/run/user/${uid}/podman/podman.sock`,
    "/run/podman/podman.sock",
  ];
  const dockerPaths = ["/var/run/docker.sock", "/run/docker.sock"];
  if (preference === "docker") {
    candidates.push(...dockerPaths, ...podmanPaths);
  } else {
    candidates.push(...podmanPaths, ...dockerPaths);
  }
  return candidates;
}

/**
 * Find the first socket path that exists AND answers `version()`. Existence
 * alone isn't enough — a stale socket file or one our uid can't read must be
 * skipped so detection falls through to the next candidate.
 */
async function pickSocket(preference: SocketPreference = "auto"): Promise<{
  socketPath: string;
  client: Docker;
} | null> {
  for (const socketPath of socketCandidates(preference)) {
    try {
      const s = await stat(socketPath);
      if (!s.isSocket()) continue;
    } catch {
      continue;
    }
    const client = new Docker({ socketPath });
    try {
      await client.version();
      return { socketPath, client };
    } catch {
      // socket exists but doesn't answer the API (wrong uid, dead daemon) —
      // try the next candidate.
    }
  }
  return null;
}

export interface ResolvedClient {
  client: Docker;
  socketPath: string;
}

let cached: ResolvedClient | null = null;

/**
 * Resolve (once) and cache the dockerode client + its socket path. Returns
 * `null` when no socket answers — the caller surfaces this as "no container
 * runtime" via the doctor. Re-resolves after `resetClient()`.
 */
export async function resolveClient(
  preference: SocketPreference = "auto",
): Promise<ResolvedClient | null> {
  if (cached) return cached;
  const picked = await pickSocket(preference);
  if (!picked) return null;
  cached = { client: picked.client, socketPath: picked.socketPath };
  return cached;
}

/**
 * The shared client for code paths that have already resolved a runtime (every
 * consumer call after `detectRuntime` succeeded). Throws if called before
 * resolution — that's a programming error, not a runtime condition.
 */
export function getClient(): ContainerClient {
  if (!cached) {
    throw new Error(
      "getClient() called before resolveClient(); runtime not detected yet",
    );
  }
  return cached.client as unknown as ContainerClient;
}

/** Path of the resolved socket, for doctor/diagnostic display. */
export function getSocketPath(): string | undefined {
  return cached?.socketPath;
}

/**
 * Drop the cached client. Called from `plugin.stop()` so a stop/start cycle
 * re-probes the socket, and from tests to reset between cases.
 */
export function resetClient(): void {
  cached = null;
}

/**
 * Test-only: install a specific client + socket path as the resolved singleton,
 * bypassing socket probing. Pass `null` to clear.
 */
export function _setClientForTesting(
  client: ContainerClient | null,
  socketPath = "/test/docker.sock",
): void {
  cached = client ? { client: client as unknown as Docker, socketPath } : null;
}

/**
 * Run a dockerode op and normalize any throw into a categorized error. The one
 * place the `{stdout, stderr, exitCode}` CLI contract is replaced: callers
 * branch on `result.ok` instead of inspecting an exit code.
 */
export async function safe<T>(
  op: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: CategorizedError }> {
  try {
    return { ok: true, value: await op() };
  } catch (err) {
    return { ok: false, error: categorizeError(err) };
  }
}

/**
 * `inspect`-style convenience: returns `null` when the resource is absent (404)
 * and rethrows anything else. Replaces the CLI-era "exitCode !== 0 → missing"
 * idiom, which couldn't distinguish "not found" from "daemon broken".
 */
export async function safeInspect<T>(op: () => Promise<T>): Promise<T | null> {
  const result = await safe(op);
  if (result.ok) return result.value;
  if (result.error.kind === "not-found") return null;
  throw new Error(result.error.userMessage, { cause: result.error });
}

/**
 * Demultiplex a dockerode logs/exec stream into combined plain text.
 *
 * Containers started without a TTY (the dockerode default, and how every
 * managed container starts) deliver logs as a multiplexed stream: each
 * stdout/stderr chunk is prefixed with an 8-byte header
 * (`[stream-type, 0, 0, 0, len32]`). Reading the raw bytes as UTF-8 leaks those
 * headers into rendered log lines as binary garbage. `modem.demuxStream` splits
 * the framing into two writable sinks; we merge both into one text callback
 * because the plugin surfaces combined stdout+stderr (matching `podman logs`
 * semantics). The CLI used to pre-demux for us — over the API we must do it.
 *
 * Returns a function that, given a finished/destroyed source stream, has piped
 * all demuxed text into `onText`. Caller wires `onText` to a line splitter.
 */
export function demuxToText(
  modem: ContainerClient["modem"],
  source: NodeJS.ReadableStream,
  onText: (chunk: string) => void,
): void {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const forward = (chunk: Buffer | string) => onText(chunk.toString("utf8"));
  stdout.on("data", forward);
  stderr.on("data", forward);
  modem.demuxStream(source, stdout, stderr);
}

/**
 * Read a finished (non-follow) logs/exec stream fully and return the demuxed
 * combined text. Used by one-shot `getContainerLogs` and `execInContainer`,
 * which under the CLI got pre-demuxed text and now must demux a buffer.
 */
export function demuxBufferToText(
  modem: ContainerClient["modem"],
  source: NodeJS.ReadableStream,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    demuxToText(modem, source, (chunk) => {
      text += chunk;
    });
    source.on("end", () => resolve(text));
    source.on("close", () => resolve(text));
    source.on("error", reject);
  });
}
