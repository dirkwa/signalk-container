import * as net from "node:net";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { existsSync, readFileSync } from "node:fs";
import {
  ContainerConfig,
  ContainerInfo,
  ContainerRuntimeInfo,
  ContainerState,
  HealthCheckOptions,
  HealthcheckOverride,
  VolumeIssue,
  VolumeSpec,
} from "./types.js";
import {
  StreamingProcessHandle,
  isContainerized,
  makeLineSplitter,
  userMappingFlags,
} from "./runtime.js";
import {
  demuxToText,
  demuxBufferToText,
  getClient,
  safe,
  safeInspect,
  type ContainerClient,
} from "./client.js";
import { resourcePayloadForRun } from "./resources.js";
import { classifyTag } from "./updates/tagClassifier.js";
import { isOfflineError } from "./updates/offline.js";

const CONTAINER_PREFIX = "sk-";

function prefixedName(name: string): string {
  return name.startsWith(CONTAINER_PREFIX)
    ? name
    : `${CONTAINER_PREFIX}${name}`;
}

/**
 * Build the value for a `-v <source>:<dest>[:flags]` argument with the
 * correct SELinux relabel suffix for the runtime.
 *
 * `:Z` is for SELinux relabelling of bind-mount host paths under Podman
 * on Fedora/RHEL. Named volumes (no leading '/' or '.') reject `:Z` with
 * "invalid option z for named volume", so we omit the flag for them.
 *
 * Used by both ContainerConfig.volumes (containers.ts) and JobConfig
 * inputs/outputs (jobs.ts) so the named-volume guard stays in one place.
 */
export function volumeArg(
  hostPath: string,
  containerPath: string,
  runtime: ContainerRuntimeInfo,
  readOnly: boolean = false,
): string {
  const isNamedVolume = !hostPath.startsWith("/") && !hostPath.startsWith(".");
  const flags: string[] = [];
  if (readOnly) flags.push("ro");
  if (runtime.runtime === "podman" && !isNamedVolume) flags.push("Z");
  const suffix = flags.length > 0 ? `:${flags.join(",")}` : "";
  return `${hostPath}:${containerPath}${suffix}`;
}

/**
 * Extract the source string from a `volumes` entry that may be a bare
 * string or a `VolumeSpec`. Used at call sites that don't care about
 * `ifMissing` policy — `buildRunArgs` and `diffContainerConfig` both
 * consume bare-string volumes after the wrapper has run
 * `classifyVolumeSources`, but they still type their input as the
 * union for callers that bypass the wrapper.
 */
function volumeSource(raw: string | VolumeSpec): string {
  return typeof raw === "string" ? raw : raw.source;
}

/**
 * Classify each volume entry against host-source existence and the
 * declared `ifMissing` policy. Returns:
 *
 *   - `kept`: the volumes that should be passed to the runtime,
 *     normalized to bare-string form (the shape `buildRunArgs` and
 *     `diffContainerConfig` already consume).
 *   - `skipped`: host-path volumes whose source is missing AND whose
 *     policy is `'skip'`. Caller should emit `onVolumeIssue`
 *     events for each.
 *   - `aborted`: host-path volumes whose source is missing AND whose
 *     policy is `'abort'`. Caller should emit `onVolumeIssue`
 *     events then throw.
 *
 * Bare-string entries and `ifMissing: 'create'` entries always end
 * up in `kept` (the runtime auto-creates the host dir on demand,
 * matching today's behaviour for the bare-string form).
 *
 * Named volumes (source without a leading `/` or `.`) always end up
 * in `kept` regardless of policy — the runtime owns their lifecycle.
 *
 * `probe` is the host-path existence check; defaults to `existsSync`.
 * Tests inject a stub so they don't touch the filesystem.
 */
/**
 * Default the in-container `HOME` to the bind-mounted config-root path
 * when the consumer plugin didn't set HOME themselves. CLI tools inside
 * the container (kopia, rclone, anything that reads ~/.cache or
 * ~/.config) need a writable home directory; the image's baked default
 * (typically /root or /app) is not writable when docker/rootful-podman
 * starts the container as the host caller's UID. Rootless podman
 * survives an unwritable HOME because the userns remap aliases /root to
 * the host caller, but setting HOME there too is harmless and keeps the
 * shape uniform across runtimes.
 *
 * Returns the env map the runtime should see — either the input
 * unchanged (HOME present, or no config root mount) or a new object
 * with HOME added. Pure and synchronous so it's testable in isolation.
 */
export function defaultHomeForConfigRoot(
  env: Record<string, string> | undefined,
  configRootMount: string | undefined,
): Record<string, string> | undefined {
  if (!configRootMount) return env;
  if (env?.HOME !== undefined) return env;
  return { ...env, HOME: configRootMount };
}

export function classifyVolumeSources(
  volumes: Record<string, string | VolumeSpec> | undefined,
  probe: (path: string) => boolean = existsSync,
): {
  kept: Record<string, string>;
  skipped: Array<{ containerPath: string; source: string }>;
  aborted: Array<{ containerPath: string; source: string }>;
} {
  const kept: Record<string, string> = {};
  const skipped: Array<{ containerPath: string; source: string }> = [];
  const aborted: Array<{ containerPath: string; source: string }> = [];
  if (!volumes) return { kept, skipped, aborted };

  for (const [containerPath, raw] of Object.entries(volumes)) {
    const source = typeof raw === "string" ? raw : raw.source;
    const policy =
      typeof raw === "string" ? "create" : (raw.ifMissing ?? "create");

    // Named volumes (no leading `/` or `.`) pass through unchanged —
    // the runtime owns their lifecycle. Don't even probe — there is
    // no host path to check.
    const isHostPath = source.startsWith("/") || source.startsWith(".");
    if (!isHostPath) {
      kept[containerPath] = source;
      continue;
    }

    // Host path: only the missing case differentiates policies.
    if (probe(source)) {
      kept[containerPath] = source;
      continue;
    }

    if (policy === "skip") {
      skipped.push({ containerPath, source });
    } else if (policy === "abort") {
      aborted.push({ containerPath, source });
    } else {
      // 'create' — keep the volume; runtime will auto-create the host
      // dir at container-create time. Matches today's bare-string
      // behaviour.
      kept[containerPath] = source;
    }
  }

  return { kept, skipped, aborted };
}

/**
 * Given the volume issues from the last `ensureRunning` call (both
 * skipped and aborted entries) and the current call's classification,
 * return the list of entries that are now present and applied — i.e.
 * recovered. Used to fire `onVolumeIssue` with `action: 'recovered'`
 * after the inner `ensureRunning` has recreated the container to
 * include the recovered mount.
 *
 * A volume has "recovered" when:
 *   - it was in `prior.skipped` or `prior.aborted` (i.e. missing on
 *     the last call), AND
 *   - it is NOT in the current call's `currentSkipped` or
 *     `currentAborted` (i.e. it is no longer missing), AND
 *   - its `containerPath` is in `kept` (i.e. the runtime will actually
 *     mount it this time).
 *
 * Pure function — no I/O.
 */
export function collectRecoveredVolumes(
  prior:
    | {
        skipped: Array<{ containerPath: string; source: string }>;
        aborted: Array<{ containerPath: string; source: string }>;
      }
    | undefined,
  currentSkipped: Array<{ containerPath: string; source: string }>,
  currentAborted: Array<{ containerPath: string; source: string }>,
  kept: Record<string, string>,
): Array<{ containerPath: string; source: string }> {
  if (!prior) return [];
  const stillMissing = new Set(
    [...currentSkipped, ...currentAborted].map((v) => v.containerPath),
  );
  const recovered: Array<{ containerPath: string; source: string }> = [];
  for (const v of [...prior.skipped, ...prior.aborted]) {
    if (!stillMissing.has(v.containerPath) && v.containerPath in kept) {
      // Report the CURRENT source from `kept`, not the prior source.
      // If the user changed the source between calls (e.g. moved the
      // USB mount point), the recovered event should reflect what is
      // now applied, not the path that used to be missing.
      recovered.push({
        containerPath: v.containerPath,
        source: kept[v.containerPath],
      });
    }
  }
  return recovered;
}

/**
 * Invoke an `onVolumeIssue` callback safely. Synchronous throws AND
 * rejected promises both route to `reportError`, so handler bugs (in
 * either flavour) never escape as unhandled rejections.
 *
 * The declared callback type is `(event) => void | Promise<void>`,
 * but TS allows assigning a plain async function where `void` is
 * expected — the eventual rejection bypasses a naive `try/catch`.
 * Wrap the call in `Promise.resolve(...).catch(...)` so the same
 * error path catches both shapes.
 *
 * Pure-by-design: `reportError` is injected so tests can capture
 * the message instead of writing to `app.error`.
 */
export function safeInvokeVolumeIssue(
  handler: ((event: VolumeIssue) => void | Promise<void>) | undefined,
  event: VolumeIssue,
  reportError: (err: unknown) => void,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(event)).catch(reportError);
  } catch (err) {
    // Pre-promise sync throw (e.g. the call expression itself threw
    // before returning a Promise). Rare in practice but possible if
    // the handler is something weird like a Proxy.
    reportError(err);
  }
}

/**
 * Invoke an `onContainerLog` callback safely.  Synchronous throws AND
 * rejected promises both route to `reportError`, so handler bugs (in
 * either flavour) never escape as unhandled rejections.  Same shape
 * and rationale as `safeInvokeVolumeIssue` — see that helper's
 * doc for why the `try { Promise.resolve(...).catch(...) }` dance
 * is needed.
 */
export function safeInvokeContainerLog(
  handler: ((line: string) => void | Promise<void>) | undefined,
  line: string,
  reportError: (err: unknown) => void,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(line)).catch(reportError);
  } catch (err) {
    reportError(err);
  }
}

/**
 * Spawn `podman logs -f --tail=N sk-<name>` (or `docker logs -f`)
 * and emit each line to `onLine`.  Returns a stop-handle; the caller
 * manages lifecycle (start after the container is running; stop on
 * remove or recreate).
 *
 * `startTail` controls history-backfill on attach.  Default 0 →
 * only live lines after attach.  Set to e.g. 100 for "last 100 +
 * live" semantics.  Both runtime CLIs accept `--tail` identically.
 *
 * `client` is exposed for tests (defaults to the dockerode singleton).
 */
export function tailContainerLogs(
  runtime: ContainerRuntimeInfo,
  name: string,
  onLine: (line: string) => void,
  options?: {
    startTail?: number;
    onError?: (msg: string) => void;
    onExit?: (code: number | null) => void;
    client?: ContainerClient;
  },
): StreamingProcessHandle {
  const client = options?.client ?? getClient();
  const fullName = prefixedName(name);
  const tail = normalizeTail(options?.startTail, 0);

  let stopped = false;
  let stream: NodeJS.ReadableStream | null = null;
  const handle: StreamingProcessHandle = {
    pid: undefined,
    spawnFailed: false,
    stop() {
      stopped = true;
      // dockerode log streams are plain Readables — destroy() ends them;
      // there is no child process to signal.
      (stream as unknown as { destroy?: () => void } | null)?.destroy?.();
    },
  };

  // Combined stdout+stderr on a single line channel (matches
  // `podman logs <name>` semantics). Rust/Go apps (mayara, etc.) log to
  // stderr, so without merging they'd appear silent in the modal. The
  // dockerode stream is multiplexed; demux both sides into one splitter.
  const splitter = makeLineSplitter(onLine);
  client
    .getContainer(fullName)
    .logs({ follow: true, stdout: true, stderr: true, tail })
    .then((s) => {
      if (stopped) {
        (s as unknown as { destroy?: () => void }).destroy?.();
        return;
      }
      stream = s as unknown as NodeJS.ReadableStream;
      demuxToText(client.modem, stream, (chunk) => splitter.push(chunk));
      stream.on("error", (err: Error) => {
        if (!stopped) options?.onError?.(err.message);
      });
      // Both `end` and `close` can fire for the same stream; guard so the
      // broker's onExit (which drives respawn + the SSE `event: end`) runs once.
      let ended = false;
      const onEnd = () => {
        if (ended) return;
        ended = true;
        splitter.flush();
        if (!stopped) options?.onExit?.(0);
      };
      stream.on("end", onEnd);
      stream.on("close", onEnd);
    })
    .catch((err) => {
      handle.spawnFailed = true;
      options?.onError?.(err instanceof Error ? err.message : String(err));
      options?.onExit?.(null);
    });

  return handle;
}

/** Upper bound for `--tail N` accepted at the public boundary. */
export const MAX_TAIL = 10000;

/**
 * Coerce an optional caller-supplied tail count to a finite,
 * non-negative integer so a buggy or hostile caller can never
 * forward `NaN`, `Infinity`, or a negative value into a runtime
 * argv (`--tail NaN` would otherwise reach `podman`/`docker`).
 * Falls back to `fallback` for `undefined` / non-finite / fractional
 * shapes; `MAX_TAIL` caps unbounded requests.
 */
function normalizeTail(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(0, Math.floor(value)), MAX_TAIL);
}

/**
 * Validate an optional unsigned-integer query parameter (e.g.
 * `?tail=200`, `?since=1700000000`) at the public REST boundary.
 * Returns `{ value }` on success (or `undefined` when the input
 * was omitted/empty) and `{ error }` with a human-readable
 * message for non-integer, negative, or non-finite inputs.
 *
 * Used by the `/logs` route to reject malformed inputs with 400
 * instead of forwarding silently-coerced values to runtime-facing
 * logic.  Exported so the parser is testable in isolation.
 */
export function parsePositiveIntQuery(
  raw: unknown,
  field: string,
): { value: number | undefined; error?: string } {
  if (raw === undefined || raw === "") return { value: undefined };
  if (typeof raw !== "string")
    return { value: undefined, error: `${field} must be a string` };
  // Decimal digits only — reject hex (`0x10`), scientific (`1e3`),
  // signs (`+5`), and any whitespace.  `Number(raw)` accepts all of
  // those silently which is surprising for an integer query param.
  if (!/^[0-9]+$/.test(raw)) {
    return {
      value: undefined,
      error: `${field} must be a non-negative integer (got ${JSON.stringify(raw)})`,
    };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    return {
      value: undefined,
      error: `${field} must be a non-negative integer (got ${JSON.stringify(raw)})`,
    };
  }
  return { value: n };
}

/**
 * Capture the last `tail` lines of a managed container's stdout
 * and stderr via `podman logs --tail <N>` (no `-f`).  Returns the
 * array of lines.  Caps `tail` at 10000 to prevent runaway-buffer
 * requests against very chatty containers; `since` is a unix-epoch-
 * seconds filter passed through to the runtime.
 *
 * Ordering caveat: the demuxed stream gives us stdout and stderr as
 * separate sinks; the OS-level chronological interleave between the two
 * is collapsed when we concatenate. We return the combined text split
 * into lines — a stderr line emitted between two stdout lines may land
 * out of order. Reconstructing true chronology would need per-line
 * `--timestamps` parsing and is out of scope.
 *
 * Used both by the `GET /containers/:name/logs` REST route and by
 * `ContainerManagerApi.getLogs` for in-process consumer-plugin calls.
 */
export async function getContainerLogs(
  runtime: ContainerRuntimeInfo,
  name: string,
  options?: { tail?: number; since?: number },
  client: ContainerClient = getClient(),
): Promise<string[]> {
  const tail = normalizeTail(options?.tail, 200);
  const logOpts: Docker.ContainerLogsOptions & { follow?: false } = {
    follow: false,
    stdout: true,
    stderr: true,
    tail,
  };
  if (
    options?.since !== undefined &&
    Number.isFinite(options.since) &&
    options.since >= 0
  ) {
    logOpts.since = Math.floor(options.since);
  }
  const result = await safe(
    () =>
      client.getContainer(prefixedName(name)).logs(logOpts) as Promise<Buffer>,
  );
  if (!result.ok) {
    throw new Error(`logs ${name}: ${result.error.userMessage}`);
  }
  // One-shot logs come back as a multiplexed buffer (non-TTY containers);
  // demux to combined text before splitting. Trailing empties are popped
  // to match the runtime's final-newline behaviour.
  const text = await demuxBufferToText(
    client.modem,
    bufferToStream(result.value),
  );
  const split = text.split(/\r?\n/);
  while (split.length > 0 && split[split.length - 1] === "") split.pop();
  return split;
}

/** Wrap a Buffer as a Readable so the demux helper can consume it. */
function bufferToStream(buf: Buffer): NodeJS.ReadableStream {
  const s = new PassThrough();
  s.end(buf);
  return s;
}

/**
 * Bare image id: 64 hex chars, optionally with the `sha256:` prefix
 * podman/docker print for `Config.Image`. Such ids must never be
 * qualified with a registry — they're addressable by content, not by
 * name.
 */
const BARE_IMAGE_ID = /^(?:sha256:)?[a-f0-9]{64}$/;

export function qualifyImage(
  image: string,
  runtime: ContainerRuntimeInfo,
): string {
  // Podman requires fully qualified image names when unqualified-search
  // registries are not configured. Prefix docker.io/ if missing.
  if (runtime.runtime === "podman") {
    // Bare image ids (e.g. `sha256:abc…` or `abc…`) are content-addressed
    // and never need a registry prefix; pass through.
    if (BARE_IMAGE_ID.test(image)) return image;
    // Strip any `@sha256:...` digest before splitting — for an
    // unqualified ref like `alpine@sha256:abc...` the digest's `:`
    // would otherwise make us think the first segment is `host:port`.
    const refWithoutDigest = image.split("@", 1)[0];
    const parts = refWithoutDigest.split("/");
    // Treat first component as a registry only if it has a dot, a colon
    // (port) appearing in a multi-segment ref, or is exactly "localhost".
    // Otherwise, prefix docker.io/.
    const looksLikeRegistry =
      parts[0].includes(".") ||
      (parts.length > 1 && parts[0].includes(":")) ||
      parts[0] === "localhost";
    if (parts.length <= 2 && !looksLikeRegistry) {
      return `docker.io/${image}`;
    }
  }
  return image;
}

export async function imageExists(
  runtime: ContainerRuntimeInfo,
  image: string,
  client: ContainerClient = getClient(),
): Promise<boolean> {
  const info = await safeInspect(() =>
    client.getImage(qualifyImage(image, runtime)).inspect(),
  );
  return info !== null;
}

/**
 * Return the local image ID (sha256 digest) for a given image reference,
 * or null if the image is not present locally. Used for digest-drift
 * detection of floating tags like :latest or :main.
 *
 * Pass either a repo:tag (e.g. "questdb/questdb:latest") to inspect a
 * pulled image, or a container name to inspect the image a running
 * container is using.
 */
export async function getImageDigest(
  runtime: ContainerRuntimeInfo,
  imageOrContainer: string,
  client: ContainerClient = getClient(),
): Promise<string | null> {
  // Try image inspect first; fall back to container inspect for names.
  const qualified = qualifyImage(imageOrContainer, runtime);
  const img = await safeInspect(() => client.getImage(qualified).inspect());
  if (img?.Id) return img.Id;

  // Maybe it's a container name; .Image on a container returns the image ID.
  const ctr = await safeInspect(() =>
    client.getContainer(imageOrContainer).inspect(),
  );
  if (ctr?.Image) return ctr.Image;

  return null;
}

/**
 * A Dockerfile `HEALTHCHECK` read back from an image's config. `test` is the
 * raw `Test` array (`["CMD-SHELL", "..."]` or `["CMD", "arg", ...]`); the
 * duration fields are nanoseconds (the runtime-agnostic JSON form).
 */
export interface ImageHealthcheck {
  test: string[];
  intervalNs?: number;
  timeoutNs?: number;
  startPeriodNs?: number;
  retries?: number;
}

interface RawHealthcheck {
  Test?: string[];
  Interval?: number;
  Timeout?: number;
  StartPeriod?: number;
  Retries?: number;
}

/**
 * Read an image's declared `HEALTHCHECK`, or `null` when it has none (or
 * declares `NONE`). We re-emit this as explicit `--health-*` flags at
 * `run` time (see `buildRunArgs`) because image-healthcheck inheritance is
 * not reliable across runtimes and API surfaces — notably it is dropped when
 * a container is created through Podman's Docker-compat socket, leaving the
 * container with an empty healthcheck and a perpetual `starting` state.
 *
 * Reads the config as JSON so duration fields come back as nanosecond
 * integers uniformly on podman and docker (a Go-template render diverges:
 * podman prints `30s`, docker prints the nanosecond count).
 */
export async function getImageHealthcheck(
  runtime: ContainerRuntimeInfo,
  imageRef: string,
  client: ContainerClient = getClient(),
): Promise<ImageHealthcheck | null> {
  const img = await safeInspect(() =>
    client.getImage(qualifyImage(imageRef, runtime)).inspect(),
  );
  // No image, or no healthcheck on it. dockerode returns the same
  // nanosecond-integer shape on podman and docker (verified live), so no
  // Go-template divergence to guard against.
  const parsed = img?.Config?.Healthcheck as RawHealthcheck | undefined;
  if (!parsed) return null;

  const test = parsed.Test ?? [];
  // A `HEALTHCHECK NONE` image surfaces as `["NONE"]` — treat as no check.
  if (test.length === 0 || test[0] === "NONE") return null;

  return {
    test,
    intervalNs: parsed.Interval,
    timeoutNs: parsed.Timeout,
    startPeriodNs: parsed.StartPeriod,
    retries: parsed.Retries,
  };
}

/**
 * Return the first RepoDigest for an image reference, as
 * `sha256:<hex>` (without the `image@` prefix). This is the
 * *manifest* digest — what consumer plugins and CI tools speak —
 * distinct from the local image ID returned by `getImageDigest`.
 *
 * Returns null when the image has no RepoDigests, which happens for:
 *   - locally-built images never pushed to a registry
 *   - images side-loaded via `podman load` from a tarball
 *
 * The resolver falls back to a `local:<image-id>` synthetic identity
 * in that case so the manifest entry still round-trips.
 */
export async function getRepoDigest(
  runtime: ContainerRuntimeInfo,
  image: string,
  client: ContainerClient = getClient(),
): Promise<string | null> {
  const img = await safeInspect(() =>
    client.getImage(qualifyImage(image, runtime)).inspect(),
  );
  const first = img?.RepoDigests?.[0];
  if (!first) return null;
  const at = first.lastIndexOf("@");
  if (at < 0) return null;
  const digest = first.slice(at + 1);
  return /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : null;
}

/**
 * Return the digest of the image a *running* container is actually
 * using, in the form `sha256:<hex>` or `local:<image-id>`.
 *
 * Distinct from "what `image:tag` resolves to right now": if someone
 * `podman pull`'d the image after the container started, the local
 * tag moved but the container is still on the old bits. This walks
 * from the container's image-id (immutable for its lifetime) to its
 * RepoDigests.
 *
 * Returns null if the container doesn't exist or the runtime can't
 * read its image-id.
 */
export async function getLiveContainerDigest(
  runtime: ContainerRuntimeInfo,
  containerName: string,
  client: ContainerClient = getClient(),
): Promise<string | null> {
  // The caller passes the unprefixed name from `ensureRunning`; the
  // running container always carries the `sk-` prefix.
  const imageId = await getImageDigest(
    runtime,
    prefixedName(containerName),
    client,
  );
  if (!imageId) return null;
  const repoDigest = await getRepoDigest(runtime, imageId, client);
  if (repoDigest) return repoDigest;
  // Locally-built image with no RepoDigests — return the local id
  // under the same `local:` namespace the resolver uses.
  return `local:${imageId}`;
}

/**
 * Pull an image, streaming progress to `onProgress`. dockerode's `pull`
 * returns a stream of JSON progress objects that must be followed to
 * completion via `modem.followProgress`; each event's `status`/`progress`
 * is surfaced line-wise to mirror the old CLI progress output.
 */
export async function pullImage(
  runtime: ContainerRuntimeInfo,
  image: string,
  onProgress?: (msg: string) => void,
  client: ContainerClient = getClient(),
): Promise<void> {
  const qualified = qualifyImage(image, runtime);
  const result = await safe(
    () =>
      new Promise<void>((resolve, reject) => {
        client
          .pull(qualified)
          .then((stream) => {
            client.modem.followProgress(
              stream,
              (err) => (err ? reject(err) : resolve()),
              (event) => {
                if (!onProgress) return;
                const e = event as { status?: string; progress?: string };
                const line = [e.status, e.progress].filter(Boolean).join(" ");
                if (line) onProgress(line);
              },
            );
          })
          .catch(reject);
      }),
  );
  if (!result.ok) {
    throw new Error(`Failed to pull ${image}: ${result.error.userMessage}`);
  }
}

export async function getContainerState(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<ContainerState> {
  const fullName = prefixedName(name);
  // Read multiple state fields and treat the container as running if
  // ANY of them indicate running. Rationale: rootless podman on some
  // kernels briefly returns inconsistent `State.Status` values for a
  // container that's actually running (observed during heavy concurrent
  // inspect traffic from the config panel's 5-second poll). The
  // `State.Pid` field is a more authoritative signal — if there's a
  // live PID, the container process exists regardless of what Status
  // momentarily claims. Same for `State.Running`, a boolean podman
  // populates independently from Status.
  const info = await safeInspect(() => client.getContainer(fullName).inspect());
  if (info === null) return "missing";

  const state = info.State ?? {};
  const status = (state.Status ?? "").toLowerCase().trim();
  const runningFlag = state.Running === true;
  const pid = Number(state.Pid ?? 0);
  const hasLivePid = Number.isFinite(pid) && pid > 0;

  // Running if ANY source says so. This is the defensive OR — we'd
  // rather report "running" when the container is actually stopped
  // (worst case: ensureRunning's "already running" fast path skips
  // a start call, which would then fail the subsequent health check
  // and recover) than report "stopped" when it's running (worst
  // case: update service skips legit checks, user sees flap).
  if (status === "running" || runningFlag || hasLivePid) return "running";
  return "stopped";
}

/**
 * Read the live resource limits applied to a managed container,
 * straight from `podman inspect` (i.e. the actual cgroup state).
 * Returns an empty object if the container is missing or no
 * limits are applied. Used by:
 *
 *   - the `updateResources` rollback path, to capture pre-update
 *     state so a failed recreate can be reverted
 *   - `ensureRunning`'s diff detection, to decide whether a running
 *     container needs a live resources update
 *
 * The shape conversion is the inverse of `resourceFlagsForRun`:
 *   NanoCpus       (nanoseconds/sec) → cpus (cores)
 *   Memory         (bytes)           → memory ("123m")
 *   MemorySwap     (bytes)           → memorySwap ("123m")
 *   ...etc.
 *
 * Memory values are emitted as bytes-with-suffix to round-trip
 * cleanly with what consumer plugins typically pass in (`"512m"`).
 *
 * `exec` defaults to the production execRuntime; tests pass a stub.
 */
export async function getLiveResources(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<import("./types.js").ContainerResourceLimits> {
  const fullName = prefixedName(name);
  const info = await safeInspect(() => client.getContainer(fullName).inspect());
  if (info === null) return {};

  // dockerode returns these as numbers/strings directly (verified live on
  // podman + docker); empty/zero/-1 means "unset", mirroring the prior
  // template-parse semantics.
  const hc = (info.HostConfig ?? {}) as {
    NanoCpus?: number;
    CpuShares?: number;
    CpusetCpus?: string;
    Memory?: number;
    MemorySwap?: number;
    MemoryReservation?: number;
    PidsLimit?: number | null;
    OomScoreAdj?: number;
  };
  const nanoCpus = hc.NanoCpus ?? 0;
  const cpuShares = hc.CpuShares ?? 0;
  const cpusetCpus = hc.CpusetCpus ?? "";
  const memory = hc.Memory ?? 0;
  const memorySwap = hc.MemorySwap ?? 0;
  const memoryReservation = hc.MemoryReservation ?? 0;
  const pidsLimit = hc.PidsLimit ?? 0;
  const oomScoreAdj = hc.OomScoreAdj ?? 0;

  const out: import("./types.js").ContainerResourceLimits = {};

  const nano = Number(nanoCpus);
  if (Number.isFinite(nano) && nano > 0) {
    // Round to 3 decimals to avoid float noise like 1.4999999999.
    out.cpus = Math.round((nano / 1_000_000_000) * 1000) / 1000;
  }
  const shares = Number(cpuShares);
  // 0 and 1024 are both "default" — only emit if explicitly set to
  // something else, since 1024 is the kernel default and we'd add
  // noise to comparisons.
  if (Number.isFinite(shares) && shares > 0 && shares !== 1024) {
    out.cpuShares = shares;
  }
  if (cpusetCpus && cpusetCpus.trim() !== "") {
    out.cpusetCpus = cpusetCpus.trim();
  }
  const mem = Number(memory);
  if (Number.isFinite(mem) && mem > 0) {
    out.memory = bytesToString(mem);
  }
  const memSwap = Number(memorySwap);
  // memorySwap is reported as -1 when unlimited; we only care about
  // explicit caps.
  if (Number.isFinite(memSwap) && memSwap > 0) {
    out.memorySwap = bytesToString(memSwap);
  }
  const memReserve = Number(memoryReservation);
  if (Number.isFinite(memReserve) && memReserve > 0) {
    out.memoryReservation = bytesToString(memReserve);
  }
  const pids = Number(pidsLimit);
  // PidsLimit is reported as 2048 by podman default — that's not
  // actually a "set" value, it's the default. Only emit if very
  // different. Detecting "this is the kernel default" precisely is
  // hard; treat 0 and 2048 as unset.
  if (Number.isFinite(pids) && pids > 0 && pids !== 2048) {
    out.pidsLimit = pids;
  }
  const oom = Number(oomScoreAdj);
  if (Number.isFinite(oom) && oom !== 0) {
    out.oomScoreAdj = oom;
  }

  return out;
}

/**
 * Convert a byte count back into the human form consumer plugins
 * use ("512m", "2g"). Picks the largest unit that produces an
 * integer result, falling back to bytes ("536870912b") if no clean
 * unit fits — though this should not happen for typical container
 * memory values which are always whole MiB.
 */
function bytesToString(bytes: number): string {
  const G = 1024 * 1024 * 1024;
  const M = 1024 * 1024;
  const K = 1024;
  if (bytes >= G && bytes % G === 0) return `${bytes / G}g`;
  if (bytes >= M && bytes % M === 0) return `${bytes / M}m`;
  if (bytes >= K && bytes % K === 0) return `${bytes / K}k`;
  return `${bytes}b`;
}

/**
 * One host-side endpoint for a single container port. Mirror of the
 * `{ HostIp, HostPort }` shape that podman/docker emit under
 * `NetworkSettings.Ports['<containerPort>/tcp']`.
 */
export interface PortBinding {
  hostIp: string;
  hostPort: number;
}

/**
 * Parse the JSON returned by `docker/podman inspect --format '{{json .NetworkSettings.Ports}}'`
 * into a Map keyed by integer container port. Pure function — used by both
 * `getActualPortBindings()` (against a live runtime) and the regression tests
 * (against synthetic JSON), so the parsing logic is covered without needing a
 * real container.
 *
 * Both runtimes accept multiple bindings per container port (one per host IP);
 * we keep all of them. UDP and SCTP entries are ignored — only `<port>/tcp` is
 * relevant for `signalkAccessiblePorts`.
 *
 * Returns an empty map on null/empty input or when JSON is malformed; callers
 * already handle "no binding found" so a parse error degrades gracefully into
 * "leave the existing cache alone".
 */
export function parsePortBindings(
  json: string | Record<string, unknown> | null | undefined,
): Map<number, PortBinding[]> {
  const out = new Map<number, PortBinding[]>();
  if (json === null || json === undefined || json === "null" || json === "") {
    return out;
  }

  // Accept either the raw object dockerode returns or a JSON string (the
  // pure-function test path). dockerode's `NetworkSettings.Ports` is
  // already an object, so no parse is needed in production.
  let parsed: unknown;
  if (typeof json === "string") {
    try {
      parsed = JSON.parse(json);
    } catch {
      return out;
    }
  } else {
    parsed = json;
  }
  if (!parsed || typeof parsed !== "object") return out;

  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const tcpMatch = key.match(/^(\d+)\/tcp$/);
    if (!tcpMatch) continue;
    const containerPort = Number(tcpMatch[1]);
    if (!Array.isArray(value) || value.length === 0) continue;

    const bindings: PortBinding[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const hostIp = typeof e["HostIp"] === "string" ? e["HostIp"] : "";
      const hostPortStr =
        typeof e["HostPort"] === "string" ? e["HostPort"] : "";
      const hostPort = Number(hostPortStr);
      if (!Number.isFinite(hostPort) || hostPort <= 0) continue;
      bindings.push({ hostIp, hostPort });
    }
    if (bindings.length > 0) out.set(containerPort, bindings);
  }
  return out;
}

/**
 * Read the live host-side port bindings for a managed container straight from
 * the runtime, bypassing any in-process cache. Returns a Map keyed by the
 * container's internal TCP port.
 *
 * Used by `ensureRunning` to validate `pendingPortMap` against reality just
 * after the runtime has bound the ports — closes the TOCTOU window between
 * `findAvailablePort()`'s in-process probe and `podman create`'s actual bind.
 *
 * Returns an empty map on inspect failure; callers fall back to whatever they
 * had pre-validation.
 */
export async function getActualPortBindings(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<Map<number, PortBinding[]>> {
  const fullName = prefixedName(name);
  const info = await safeInspect(() => client.getContainer(fullName).inspect());
  if (info === null) return new Map();
  return parsePortBindings(
    info.NetworkSettings?.Ports as Record<string, unknown> | undefined,
  );
}

/**
 * The recreate-requiring half of a live container's effective config, parsed
 * from a single `inspect` call. Mirror of the recreate-requiring fields on
 * `ContainerConfig` after `buildRunArgs` would have rendered them. Resources
 * have their own `getLiveResources` reader and live-update path.
 *
 * `image+tag` come from `.Config.Image` (the as-passed reference like
 * `questdb/questdb:latest`), not `.Image` (the resolved sha256 digest) —
 * digest-drift detection is the update service's job (`src/updates/`).
 */
export interface LiveContainerConfig {
  image: string;
  tag: string;
  /**
   * Set when the live `Config.Image` was a digest-pinned reference
   * (`image@sha256:...`). `tag` then holds whatever the runtime
   * reports alongside (typically the empty string or `"latest"`); the
   * authoritative comparison should use `digest`.
   */
  digest: string | null;
  command: string[] | null;
  networkMode: string;
  env: Map<string, string>;
  binds: Array<{ host: string; container: string }>;
  portBindings: Map<string, PortBinding[]>;
  extraHosts: Map<string, string>;
  /**
   * Effective `--user` spec from `.Config.User`. Empty string when the
   * container was created without `--user` (image USER, typically root).
   * Drift detection compares this against the expected mapping derived
   * from the requested `ContainerConfig.user` and the runtime's host
   * UID/GID.
   *
   * Note: `--userns=keep-id` doesn't surface in `.Config.User`; recreating
   * on `user` drift handles the practical case (Podman picks up the
   * keep-id flag on the new run).
   */
  user: string;
}

/**
 * Read the live equivalent of `ContainerConfig`'s recreate-requiring fields
 * for an already-running container. Returns `null` on inspect failure (the
 * caller treats that as "can't diff, fall back to early-return" — fail-safe).
 *
 * Used by `ensureRunning` to detect drift between the requested config and
 * what the container was actually created with, so a recreate can fire
 * automatically instead of silently ignoring the new config until restart.
 */
export async function getLiveContainerConfig(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<LiveContainerConfig | null> {
  const fullName = prefixedName(name);
  const info = await safeInspect(() => client.getContainer(fullName).inspect());
  if (info === null) return null;

  // dockerode hands back already-parsed JSON; we read the same fields the
  // CLI template emitted, with no per-field parse/exitcode handling.
  const config = (info.Config ?? {}) as {
    Image?: string;
    Cmd?: string[] | null;
    Env?: string[] | null;
    User?: string;
  };
  const hostConfig = (info.HostConfig ?? {}) as {
    NetworkMode?: string;
    Binds?: string[] | null;
    PortBindings?: Record<string, unknown> | null;
    ExtraHosts?: string[] | null;
  };
  const rawCmd = config.Cmd ?? null;
  const rawNetworkMode = hostConfig.NetworkMode;
  const rawBinds = hostConfig.Binds ?? null;
  const rawEnv = config.Env ?? null;
  const rawPortBindings = hostConfig.PortBindings ?? null;
  const rawExtraHosts = hostConfig.ExtraHosts ?? null;
  const rawUser = config.User;

  // Split image into image+tag (and optional digest). Config.Image can
  // be `repo:tag`, `repo@sha256:...`, or `repo:tag@sha256:...`.
  // Registries with ports (`localhost:5000/foo:tag`) push the
  // image-vs-tag colon past the last slash.
  const imageRef = (config.Image ?? "").trim();
  let imageAndTag = imageRef;
  let digest: string | null = null;
  const atIdx = imageRef.indexOf("@sha256:");
  if (atIdx >= 0) {
    imageAndTag = imageRef.slice(0, atIdx);
    digest = imageRef.slice(atIdx + 1);
  }
  const lastColon = imageAndTag.lastIndexOf(":");
  const lastSlash = imageAndTag.lastIndexOf("/");
  let image: string;
  let tag: string;
  if (lastColon > lastSlash) {
    image = imageAndTag.slice(0, lastColon);
    tag = imageAndTag.slice(lastColon + 1);
  } else {
    image = imageAndTag;
    tag = "latest";
  }

  let command: string[] | null = null;
  if (Array.isArray(rawCmd)) command = rawCmd.map((s) => String(s));

  const networkMode = (rawNetworkMode ?? "").trim();

  const binds: Array<{ host: string; container: string }> = [];
  if (Array.isArray(rawBinds)) {
    for (const entry of rawBinds) {
      if (typeof entry !== "string") continue;
      // Bind format: `host:container[:flags]`. `volumeArg` adds `:Z` for
      // podman binds and `:ro` for read-only mounts; strip trailing flags
      // so the diff compares semantic (host, container) tuples only.
      // Container path always begins with `/`, so the second-to-last `:`
      // is the host/container boundary regardless of flags.
      const segments = entry.split(":");
      if (segments.length < 2) continue;
      // Walk backward: keep stripping trailing segments that look like
      // option flags (Z, z, ro, rw, etc.) until we have exactly host:container.
      const FLAG_RE = /^[a-zA-Z,]+$/;
      while (
        segments.length > 2 &&
        FLAG_RE.test(segments[segments.length - 1])
      ) {
        segments.pop();
      }
      if (segments.length < 2) continue;
      const container = segments.pop() as string;
      const host = segments.join(":");
      binds.push({ host, container });
    }
  }

  const env = new Map<string, string>();
  if (Array.isArray(rawEnv)) {
    for (const entry of rawEnv) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq < 0) continue;
      env.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
  }

  const portBindings = parsePortBindingsObject(rawPortBindings);

  const extraHosts = new Map<string, string>();
  if (Array.isArray(rawExtraHosts)) {
    for (const entry of rawExtraHosts) {
      if (typeof entry !== "string") continue;
      // ExtraHosts format: "hostname:ipaddress"
      const colon = entry.indexOf(":");
      if (colon < 0) continue;
      const hostname = entry.slice(0, colon);
      const ip = entry.slice(colon + 1);
      extraHosts.set(hostname, ip);
    }
  }

  const user = (rawUser ?? "").trim();

  return {
    image,
    tag,
    digest,
    command,
    networkMode,
    env,
    binds,
    portBindings,
    extraHosts,
    user,
  };
}

/**
 * Wrapper around `parsePortBindings` that keeps the container-port key as
 * the runtime emits it (`"<port>/tcp"`, `"<port>/udp"`, …) rather than
 * stripping the protocol. The diff compares full keys so a `9000/tcp` vs
 * `9000/udp` change is detected.
 */
function parsePortBindingsObject(
  parsed: Record<string, unknown> | null | undefined,
): Map<string, PortBinding[]> {
  const out = new Map<string, PortBinding[]>();
  if (!parsed || typeof parsed !== "object") return out;
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const bindings: PortBinding[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const hostIp = typeof e["HostIp"] === "string" ? e["HostIp"] : "";
      const hostPortStr =
        typeof e["HostPort"] === "string" ? e["HostPort"] : "";
      const hostPort = Number(hostPortStr);
      if (!Number.isFinite(hostPort) || hostPort <= 0) continue;
      bindings.push({ hostIp, hostPort });
    }
    if (bindings.length > 0) out.set(key, bindings);
  }
  return out;
}

/**
 * Network-mode strings that the runtime reports for "no `--network` was
 * passed". Treated as equivalent to a requested empty/undefined networkMode
 * during diff. `bridge` is the docker default; `slirp4netns` and `pasta`
 * are podman rootless defaults; `default` is what docker reports when
 * `--network=default`.
 */
const RUNTIME_DEFAULT_NETWORK_MODES = new Set([
  "",
  "default",
  "bridge",
  "slirp4netns",
  "pasta",
]);

function canonicalNetworkMode(mode: string | undefined): string {
  const m = (mode ?? "").trim();
  return RUNTIME_DEFAULT_NETWORK_MODES.has(m) ? "" : m;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function parseRequestedHostBinding(spec: string): {
  hostIp: string;
  hostPort: number;
} | null {
  // Accept `<port>` or `<host>:<port>` forms. We only diff TCP, matching
  // `parsePortBindings`. Returns null on unparseable input.
  const colon = spec.lastIndexOf(":");
  if (colon < 0) {
    const port = Number(spec);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { hostIp: "", hostPort: port };
  }
  const hostIp = spec.slice(0, colon);
  const port = Number(spec.slice(colon + 1));
  if (!Number.isFinite(port) || port <= 0) return null;
  return { hostIp, hostPort: port };
}

function sortBindings(bindings: PortBinding[]): PortBinding[] {
  return [...bindings].sort((a, b) => {
    if (a.hostPort !== b.hostPort) return a.hostPort - b.hostPort;
    return a.hostIp.localeCompare(b.hostIp);
  });
}

function bindingsEqual(a: PortBinding[], b: PortBinding[]): boolean {
  if (a.length !== b.length) return false;
  const sa = sortBindings(a);
  const sb = sortBindings(b);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i].hostPort !== sb[i].hostPort || sa[i].hostIp !== sb[i].hostIp) {
      return false;
    }
  }
  return true;
}

/**
 * Compare a requested `ContainerConfig` against the live container's
 * effective config and return the list of fields that have drifted.
 *
 * Pure function — no I/O. The caller (`ensureRunning`) decides what to do
 * with a non-empty drift list (today: log + remove + recreate).
 *
 * Field semantics:
 *   - image+tag: tag-string equality only, never digest. Update detection
 *     for floating tags (`:latest` digest drift) is the update service's job.
 *   - command: explicit drift when `requested.command` is set and differs
 *     from `live.command`. When `requested.command` is undefined, drift is
 *     reported only if a `prior.command` was set (i.e. the user is now
 *     unsetting it). Without a `prior`, an undefined `requested.command`
 *     can't be told apart from "image's baked CMD" so we skip — the
 *     wrapper's prior-config cache (`lastConfigs`) closes that loop on the
 *     second-and-later calls within a single signalk-container lifetime.
 *   - networkMode: runtime defaults (`bridge`, `slirp4netns`, etc.) are
 *     normalized to `""` and compared as equivalent to requested undefined.
 *   - env: requested keys must match live values. Additionally, any key
 *     present in `prior.env` but absent from `requested.env` is treated
 *     as drift (the user is unsetting it). Image-baked env keys not in
 *     either `requested.env` or `prior.env` are ignored — they were never
 *     ours.
 *   - volumes: trailing slashes stripped on both sides; `(host, container)`
 *     tuples compared as a Map keyed by container path. Live binds have
 *     their `:Z`/`:ro` flags already stripped by `getLiveContainerConfig`.
 *   - ports: container-port key compared as runtime-emitted (`9000/tcp`).
 *     Multiple host bindings per container port compared as a sorted set.
 */
export function diffContainerConfig(
  requested: ContainerConfig,
  live: LiveContainerConfig,
  runtime: ContainerRuntimeInfo,
  prior?: ContainerConfig,
): { drifted: string[] } {
  const drifted: string[] = [];

  const requestedImageRef = qualifyImage(
    requested.digest
      ? `${requested.image}@${requested.digest}`
      : `${requested.image}:${requested.tag}`,
    runtime,
  );
  const liveImageRef = qualifyImage(
    live.digest ? `${live.image}@${live.digest}` : `${live.image}:${live.tag}`,
    runtime,
  );
  if (requestedImageRef !== liveImageRef) drifted.push("image+tag");

  if (requested.command !== undefined) {
    const liveCmd = live.command ?? [];
    if (JSON.stringify(requested.command) !== JSON.stringify(liveCmd)) {
      drifted.push("command");
    }
  } else if (prior?.command !== undefined) {
    // Unset detection: the user previously set command and now wants the
    // image default back. Recreate so the runtime drops the override.
    drifted.push("command");
  }

  if (
    canonicalNetworkMode(requested.networkMode) !==
    canonicalNetworkMode(live.networkMode)
  ) {
    drifted.push("networkMode");
  }

  let envDrift = false;
  if (requested.env) {
    for (const [key, value] of Object.entries(requested.env)) {
      if (live.env.get(key) !== value) {
        envDrift = true;
        break;
      }
    }
  }
  // Unset detection: any key we previously set that the user is now
  // dropping should force a recreate so the runtime forgets the override.
  // Image-baked keys (in live.env but never in prior.env) stay ignored.
  if (!envDrift && prior?.env) {
    for (const key of Object.keys(prior.env)) {
      if (!requested.env || !(key in requested.env)) {
        envDrift = true;
        break;
      }
    }
  }
  if (envDrift) drifted.push("env");

  // Volumes: build canonical Map<containerPath, hostPath> for each side.
  const requestedVolumes = new Map<string, string>();
  if (requested.volumes) {
    for (const [containerPath, raw] of Object.entries(requested.volumes)) {
      requestedVolumes.set(
        stripTrailingSlash(containerPath),
        stripTrailingSlash(volumeSource(raw)),
      );
    }
  }
  const liveVolumes = new Map<string, string>();
  for (const { host, container } of live.binds) {
    liveVolumes.set(stripTrailingSlash(container), stripTrailingSlash(host));
  }
  let volumesDrift = requestedVolumes.size !== liveVolumes.size;
  if (!volumesDrift) {
    for (const [container, host] of requestedVolumes) {
      if (liveVolumes.get(container) !== host) {
        volumesDrift = true;
        break;
      }
    }
  }
  if (volumesDrift) drifted.push("volumes");

  // Ports: build canonical Map<"<port>/<proto>", PortBinding[]> per side.
  const requestedPorts = new Map<string, PortBinding[]>();
  if (requested.ports) {
    for (const [containerPort, hostBind] of Object.entries(requested.ports)) {
      const key = containerPort.includes("/")
        ? containerPort
        : `${containerPort}/tcp`;
      const parsed = parseRequestedHostBinding(hostBind);
      if (!parsed) continue;
      const existing = requestedPorts.get(key) ?? [];
      existing.push(parsed);
      requestedPorts.set(key, existing);
    }
  }
  let portsDrift = requestedPorts.size !== live.portBindings.size;
  if (!portsDrift) {
    for (const [key, bindings] of requestedPorts) {
      const liveBindings = live.portBindings.get(key);
      if (!liveBindings || !bindingsEqual(bindings, liveBindings)) {
        portsDrift = true;
        break;
      }
    }
  }
  if (portsDrift) drifted.push("ports");

  // ExtraHosts: build canonical Map<hostname, ip> for each side.
  const requestedExtraHosts = new Map<string, string>();
  if (requested.extraHosts) {
    for (const [hostname, ip] of Object.entries(requested.extraHosts)) {
      requestedExtraHosts.set(hostname, ip);
    }
  }
  // This plugin injects host.containers.internal:host-gateway in
  // buildRunArgs() for Docker so containers can reach the host the
  // same way Podman does natively. Mirror that here so the live
  // ExtraHosts (which records the flag) doesn't fire false drift —
  // but only when the user didn't supply their own override for the
  // same key.
  if (
    runtime.runtime === "docker" &&
    !requestedExtraHosts.has("host.containers.internal")
  ) {
    requestedExtraHosts.set("host.containers.internal", "host-gateway");
  }
  let extraHostsDrift = requestedExtraHosts.size !== live.extraHosts.size;
  if (!extraHostsDrift) {
    for (const [hostname, ip] of requestedExtraHosts) {
      if (live.extraHosts.get(hostname) !== ip) {
        extraHostsDrift = true;
        break;
      }
    }
  }
  if (extraHostsDrift) drifted.push("extraHosts");

  // User/ownership drift. Compute the `User` form the translator would
  // emit and compare to live `Config.User`. The rootless-Podman
  // `UsernsMode: keep-id` mapping doesn't surface in `Config.User`, so
  // we only fire drift when the expected form is a `User` value — that
  // is, opt-out, rootless-Podman, and unavailable-hostUser all suppress
  // drift on this field by design.
  const expectedUser = userMappingFlags(runtime, requested.user).User ?? null;
  if (expectedUser !== null && expectedUser !== live.user) {
    drifted.push("user");
  }

  return { drifted };
}

/**
 * Parse a Docker duration string (`"30s"`, `"1m30s"`, `"500ms"`, `"2h"`)
 * into nanoseconds for the Docker API's `Healthcheck` fields. The CLI
 * accepted the human form directly; over the API we must convert.
 * Returns 0 for unparseable/empty input (the API treats 0 as "use the
 * image/runtime default").
 */
function durationToNanos(value: string | undefined): number {
  if (!value) return 0;
  const units: Record<string, number> = {
    ns: 1,
    us: 1_000,
    ms: 1_000_000,
    s: 1_000_000_000,
    m: 60_000_000_000,
    h: 3_600_000_000_000,
  };
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ns|us|ms|s|m|h)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    matched = true;
    total += Number(m[1]) * units[m[2]];
  }
  return matched ? Math.round(total) : 0;
}

/**
 * Build the dockerode `Healthcheck` create-payload fragment from a
 * healthcheck source, or `undefined` when there's nothing to set.
 *
 * An explicit `config.healthcheck` override wins over the image's own
 * `HEALTHCHECK`. The override carries human-readable durations (`"30s"`)
 * converted to nanoseconds via `durationToNanos`; the image healthcheck
 * already carries nanosecond integers (from `inspect` JSON). Both
 * collapse a `CMD-SHELL` array and a `CMD` array into the Docker API's
 * `Test` form (`["CMD-SHELL", "<shell>"]` / `["CMD", "arg0", ...]`).
 *
 * `override === false` emits `Test: ["NONE"]`: the runtime then reports
 * the container with no health status instead of parking a probeless
 * image in a perpetual `starting`. Image healthcheck is always re-emitted
 * explicitly because inheritance is unreliable over Podman's
 * docker-compat create API (the container otherwise sits in `starting`).
 */
function healthcheckPayload(
  override: HealthcheckOverride | undefined,
  imageHealthcheck: ImageHealthcheck | null | undefined,
): Docker.HealthConfig | undefined {
  if (override === false) {
    return { Test: ["NONE"] };
  }
  if (override) {
    const test = healthTest(override.test);
    if (!test) return undefined;
    const hc: Docker.HealthConfig = { Test: test };
    if (override.interval) hc.Interval = durationToNanos(override.interval);
    if (override.timeout) hc.Timeout = durationToNanos(override.timeout);
    if (override.startPeriod) {
      hc.StartPeriod = durationToNanos(override.startPeriod);
    }
    if (override.retries) hc.Retries = override.retries;
    return hc;
  }
  if (imageHealthcheck) {
    const test = healthTest(imageHealthcheck.test);
    if (!test) return undefined;
    const hc: Docker.HealthConfig = { Test: test };
    if (imageHealthcheck.intervalNs) hc.Interval = imageHealthcheck.intervalNs;
    if (imageHealthcheck.timeoutNs) hc.Timeout = imageHealthcheck.timeoutNs;
    if (imageHealthcheck.startPeriodNs) {
      hc.StartPeriod = imageHealthcheck.startPeriodNs;
    }
    if (imageHealthcheck.retries) hc.Retries = imageHealthcheck.retries;
    return hc;
  }
  return undefined;
}

/**
 * Normalize a `["CMD"|"CMD-SHELL", ...]` source array into the Docker API's
 * `Healthcheck.Test` shape. `CMD-SHELL` takes ONE joined string the shell
 * parses; `CMD` is exec-form and MUST keep each argv element separate —
 * collapsing `["CMD","curl","-f","url"]` into `["CMD","curl -f url"]` makes
 * Docker look for a binary literally named "curl -f url". Returns `undefined`
 * when there is no command to run.
 */
function healthTest(source: string[]): string[] | undefined {
  const [kind, ...rest] = source;
  if (kind === "CMD-SHELL") {
    return rest[0] ? ["CMD-SHELL", rest[0]] : undefined;
  }
  return rest.length > 0 ? [kind, ...rest] : undefined;
}

/**
 * Read the highest `nofile` (`RLIMIT_NOFILE`) hard limit a container on
 * this host can actually be given, so an over-request can be clamped
 * instead of being rejected at container-create time.
 *
 * The ceiling differs by privilege:
 *   - rootless: a container cannot raise its hard limit above the
 *     calling user's hard limit — only privileged processes may. Signal
 *     K server runs as that same user, so its own hard limit
 *     (`/proc/self/limits`) IS the ceiling. crun rejects anything higher
 *     with `setrlimit RLIMIT_NOFILE: Operation not permitted` and the
 *     container fails to start.
 *   - rootful / docker: the runtime is privileged and can raise up to
 *     the kernel's absolute per-process cap, `fs.nr_open`.
 *
 * Returns `null` when the ceiling can't be determined (non-Linux, the
 * proc files are absent) — the caller then passes the request through
 * unclamped, preserving today's behaviour on those platforms.
 */
export function readNofileHardCeiling(
  runtime: ContainerRuntimeInfo,
): number | null {
  const read = (path: string): number | null => {
    try {
      const raw = readFileSync(path, "utf8");
      const n = Number(raw.trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };

  if (runtime.isRootless) {
    // "Max open files   <soft>   <hard>   files" — the third column.
    try {
      const line = readFileSync("/proc/self/limits", "utf8")
        .split("\n")
        .find((l) => l.startsWith("Max open files"));
      const hard = line?.trim().split(/\s+/)[4];
      const n = hard === "unlimited" ? Infinity : Number(hard);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
  return read("/proc/sys/fs/nr_open");
}

/**
 * Translate `ContainerConfig.ulimits` into the dockerode
 * `HostConfig.Ulimits` array (`{ Name, Soft, Hard }`). A bare number sets
 * soft = hard. Returns `undefined` when no ulimits are configured so the
 * caller can leave the field unset.
 *
 * `nofileCeiling`, when set, caps both the soft and hard `nofile` limits
 * to a value the host can actually grant — a rootless container that
 * requests more `nofile` than the calling user's hard limit is rejected
 * by crun and fails to start, so clamping turns a fatal over-request into
 * the best limit the host can deliver. `onClamp` fires once when the
 * `nofile` request is lowered, so the caller can log an advisory.
 *
 * Throws on an invalid limit (non-integer, negative, or `hard < soft`) so
 * a bad consumer config fails early with a descriptive message rather than
 * as an opaque runtime create error. Exported for unit testing.
 */
export function ulimitsForRun(
  ulimits: ContainerConfig["ulimits"],
  nofileCeiling?: number | null,
  onClamp?: (requested: number, granted: number) => void,
): Docker.Ulimit[] | undefined {
  if (!ulimits) return undefined;
  const entries = Object.entries(ulimits);
  if (entries.length === 0) return undefined;
  return entries.map(([name, value]) => {
    let { soft, hard } =
      typeof value === "number" ? { soft: value, hard: value } : value;
    // Validate at the boundary: a consumer plugin's config is untrusted
    // input, and an invalid ulimit otherwise only surfaces as an opaque
    // runtime create error. Require non-negative integers with hard ≥ soft.
    for (const [bound, n] of [
      ["soft", soft],
      ["hard", hard],
    ] as const) {
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `Invalid ${bound} ulimit for "${name}": expected a non-negative integer, got ${n}`,
        );
      }
    }
    if (hard < soft) {
      throw new Error(
        `Invalid ulimit for "${name}": hard (${hard}) must be >= soft (${soft})`,
      );
    }
    if (
      name === "nofile" &&
      nofileCeiling != null &&
      Number.isFinite(nofileCeiling)
    ) {
      const requestedHard = hard;
      if (hard > nofileCeiling) hard = nofileCeiling;
      if (soft > nofileCeiling) soft = nofileCeiling;
      if (requestedHard > nofileCeiling)
        onClamp?.(requestedHard, nofileCeiling);
    }
    return { Name: name, Soft: soft, Hard: hard };
  });
}

/**
 * Build the dockerode `createContainer` options from a `ContainerConfig`.
 * Replaces the former `buildRunArgs` flag-array builder; the same fields
 * map onto the structured create payload (top-level vs `HostConfig`).
 */
function buildCreateOptions(
  name: string,
  config: ContainerConfig,
  runtime: ContainerRuntimeInfo,
  healthcheck?: ImageHealthcheck | null,
  debug: (msg: string) => void = () => {},
): Docker.ContainerCreateOptions {
  const fullName = prefixedName(name);
  const imageRef = qualifyImage(
    config.digest
      ? `${config.image}@${config.digest}`
      : `${config.image}:${config.tag}`,
    runtime,
  );

  const hostConfig: Docker.HostConfig = {};

  // Default restart policy is `unless-stopped` so containers come back
  // after a host reboot without the consumer plugin having to opt in.
  // The runtime daemon honours it at boot regardless of whether
  // signalk-server is up yet (rootless Podman needs `loginctl
  // enable-linger $USER`; see AGENTS.md "Container persistence across
  // reboots"). Consumers wanting a one-shot pass `restart: "no"`.
  const restartPolicy = config.restart ?? "unless-stopped";
  if (restartPolicy !== "no") {
    hostConfig.RestartPolicy = { Name: restartPolicy };
  }

  if (config.networkMode) {
    hostConfig.NetworkMode = config.networkMode;
  }

  // UID/GID alignment so files created inside the container on bind-
  // mounted host paths land owned by the host caller. Same decision
  // matrix as `runJob` (see `userMappingFlags`). The payload carries
  // either `{ User }` (docker/rootful podman) or
  // `{ HostConfig: { UsernsMode } }` (rootless podman keep-id), or `{}`.
  const userMapping = userMappingFlags(runtime, config.user);
  if (userMapping.HostConfig?.UsernsMode) {
    hostConfig.UsernsMode = userMapping.HostConfig.UsernsMode;
  }

  const exposedPorts: Record<string, Record<string, never>> = {};
  if (config.ports) {
    hostConfig.PortBindings = {};
    for (const [containerPort, hostBind] of Object.entries(config.ports)) {
      // Keys already carrying a protocol (e.g. `53/udp`) pass through;
      // a bare port defaults to tcp. Blindly appending `/tcp` would turn
      // `53/udp` into the invalid `53/udp/tcp` and guarantee drift against
      // the live PortBindings reader, which keeps the original key.
      const key = containerPort.includes("/")
        ? containerPort
        : `${containerPort}/tcp`;
      const binding = parseRequestedHostBinding(hostBind);
      hostConfig.PortBindings[key] = [
        {
          HostIp: binding?.hostIp ?? "",
          HostPort: String(binding?.hostPort ?? hostBind),
        },
      ];
      exposedPorts[key] = {};
    }
  }

  if (config.volumes) {
    hostConfig.Binds = [];
    for (const [containerPath, raw] of Object.entries(config.volumes)) {
      hostConfig.Binds.push(
        volumeArg(volumeSource(raw), containerPath, runtime),
      );
    }
  }

  const env: string[] = [];
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      env.push(`${key}=${value}`);
    }
  }

  // Extra hosts: user-provided + (for Docker) the
  // host.containers.internal:host-gateway mapping Podman provides
  // natively. Skip the Docker injection if the user already supplied
  // their own value for the same key to avoid duplicate /etc/hosts
  // entries and the implicit first-match-wins override.
  const userHasInternalOverride =
    !!config.extraHosts &&
    Object.prototype.hasOwnProperty.call(
      config.extraHosts,
      "host.containers.internal",
    );
  const extraHosts: string[] = [];
  if (config.extraHosts) {
    for (const [hostname, ip] of Object.entries(config.extraHosts)) {
      extraHosts.push(`${hostname}:${ip}`);
    }
  }
  if (runtime.runtime === "docker" && !userHasInternalOverride) {
    extraHosts.push("host.containers.internal:host-gateway");
  }
  if (extraHosts.length > 0) hostConfig.ExtraHosts = extraHosts;

  // Resource limits → HostConfig fields. Fields whose backing cgroup
  // controller is unavailable on this runtime are silently dropped.
  Object.assign(hostConfig, resourcePayloadForRun(config.resources, runtime));

  // Per-process ulimits → HostConfig.Ulimits. dockerode takes the same
  // {Name, Soft, Hard} shape on podman and docker. A bare number sets
  // soft = hard. Not drift-detecting (see ContainerConfig.ulimits). The
  // `nofile` request is clamped to what this host can actually grant — a
  // rootless container asking for more than the calling user's hard limit
  // is rejected by crun and never starts, so we lower it (and log) rather
  // than let the container fail.
  const ulimits = ulimitsForRun(
    config.ulimits,
    readNofileHardCeiling(runtime),
    (requested, granted) =>
      debug(
        `nofile ulimit ${requested} exceeds this host's hard limit; clamped to ${granted}. ` +
          `Raise the limit for the user running the container runtime to use a higher value.`,
      ),
  );
  if (ulimits) hostConfig.Ulimits = ulimits;

  const options: Docker.ContainerCreateOptions = {
    name: fullName,
    Image: imageRef,
    HostConfig: hostConfig,
  };

  // `--user uid:gid` (docker / rootful podman) maps to the top-level
  // `User`; rootless-podman keep-id was applied to HostConfig.UsernsMode
  // above. Exactly one of the two is ever set.
  if (userMapping.User) options.User = userMapping.User;

  if (env.length > 0) options.Env = env;
  if (Object.keys(exposedPorts).length > 0) options.ExposedPorts = exposedPorts;

  // Container labels. Informational only — not part of drift detection.
  // dockerode takes Labels as a native object; values are NOT
  // percent-encoded (unlike the old CLI --label path).
  if (config.labels) options.Labels = { ...config.labels };

  // Healthcheck. An explicit override wins over the image's own
  // HEALTHCHECK; we always emit it ourselves rather than relying on
  // image inheritance (unreliable over the docker-compat create API).
  const hc = healthcheckPayload(config.healthcheck, healthcheck);
  if (hc) options.Healthcheck = hc;

  if (config.command) options.Cmd = [...config.command];

  return options;
}

/**
 * Pull function injected into `ensureRunning` for testability. Production
 * uses the module-level `pullImage` (which pulls via the dockerode client).
 * Tests pass a stub to assert call counts and simulate offline failures
 * without touching the network.
 */
type PullFn = (
  runtime: ContainerRuntimeInfo,
  image: string,
  onProgress?: (msg: string) => void,
) => Promise<void>;

export async function ensureRunning(
  runtime: ContainerRuntimeInfo,
  name: string,
  config: ContainerConfig,
  debug: (msg: string) => void,

  options?: HealthCheckOptions,
  client: ContainerClient = getClient(),
  /**
   * Prior `ContainerConfig` from the previous `ensureRunning` call within
   * this signalk-container lifetime, if any. Used to detect "unset" drift
   * — env keys removed, `command` previously set and now undefined. The
   * wrapper in `index.ts` reads from its `lastConfigs` cache before
   * overwriting it; on the first call (or after a Signal K restart) this
   * will be undefined and only positive drift is detected.
   */
  prior?: ContainerConfig,
  _postRecreate: boolean = false,
  _pull: PullFn = pullImage,
): Promise<void> {
  const state = await getContainerState(runtime, name, client);
  const fullName = prefixedName(name);
  const imageRef = qualifyImage(
    config.digest
      ? `${config.image}@${config.digest}`
      : `${config.image}:${config.tag}`,
    runtime,
  );

  // Drift detection is needed for both "running" and "stopped" — a stopped
  // container with stale env/volumes/ports/command would otherwise be
  // re-started with the OLD config. Inspect works on both states.
  const checkAndRecreateOnDrift = async (
    contextLabel: string,
  ): Promise<boolean> => {
    const live = await getLiveContainerConfig(runtime, name, client);
    if (!live) {
      debug(
        `Container ${fullName} ${contextLabel} (could not inspect for drift)`,
      );
      return false;
    }
    const { drifted } = diffContainerConfig(config, live, runtime, prior);
    if (drifted.length === 0) return false;
    debug(
      `Container ${fullName} config drift detected (${drifted.join(", ")}); recreating`,
    );
    await removeContainer(runtime, name, client);
    await ensureRunning(
      runtime,
      name,
      config,
      debug,
      options,
      client,
      prior,
      true,
      _pull,
    );
    return true;
  };

  // Floating-tag digest drift: pull the tag, compare the registry-fresh
  // image-id to the running container's image-id, treat a mismatch as drift.
  // Skipped silently on offline or any pull/inspect error — update probing
  // must never block startup. `config.digest` set means the caller already
  // pins to a digest; nothing to probe.
  const checkAndRecreateOnDigestDrift = async (): Promise<boolean> => {
    if (!config.autoUpdateOnFloatingTag) return false;
    if (config.digest) return false;
    if (classifyTag(config.tag) !== "floating") return false;

    const fullImage = `${config.image}:${config.tag}`;
    try {
      await _pull(runtime, qualifyImage(fullImage, runtime), debug);
    } catch (err) {
      if (isOfflineError(err)) {
        debug(
          `Container ${fullName} floating-tag digest check skipped (offline)`,
        );
      } else {
        debug(
          `Container ${fullName} floating-tag digest check skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return false;
    }

    // Compare image-ids (local content-store hash), not manifest digests.
    // `getImageDigest` returns the local `.Id` for both an `image:tag` ref
    // and a container name (via `.Image` on the container) — like-for-like.
    // Mixing in a `RepoDigest`-based identity here would always show drift
    // because RepoDigest and image-id are different namespaces. The same
    // image-id-vs-image-id comparison is what updates/service.ts uses.
    const remoteId = await getImageDigest(
      runtime,
      qualifyImage(fullImage, runtime),
      client,
    );
    const liveId = await getImageDigest(runtime, prefixedName(name), client);
    if (!remoteId || !liveId || remoteId === liveId) {
      return false;
    }

    debug(
      `Container ${fullName} floating-tag digest drift detected (${liveId.slice(0, 19)}… → ${remoteId.slice(0, 19)}…); recreating`,
    );
    await removeContainer(runtime, name, client);
    await ensureRunning(
      runtime,
      name,
      config,
      debug,
      options,
      client,
      prior,
      true,
      _pull,
    );
    return true;
  };

  switch (state) {
    case "running": {
      if (_postRecreate) {
        // Post-removeContainer state came back as "running" — race or
        // restart-policy interaction. Don't recurse; treat as a no-op.
        debug(
          `Container ${fullName} unexpectedly running after recreate; skipping diff`,
        );
        return;
      }
      if (await checkAndRecreateOnDrift("already running")) return;
      if (await checkAndRecreateOnDigestDrift()) return;
      debug(`Container ${fullName} already running`);
      return;
    }

    case "stopped": {
      if (_postRecreate) {
        // Post-removeContainer state came back as "stopped" — race or
        // restart-policy interaction. Don't recurse; just start it.
        debug(
          `Container ${fullName} unexpectedly stopped after recreate; starting without diff`,
        );
        await startByFullName(client, fullName);
        return;
      }
      if (await checkAndRecreateOnDrift("stopped")) return;
      if (await checkAndRecreateOnDigestDrift()) return;
      debug(`Starting stopped container ${fullName}`);
      await startByFullName(client, fullName);
      return;
    }

    case "missing": {
      const hasImage = await imageExists(runtime, imageRef, client);
      if (!hasImage) {
        debug(`Pulling ${imageRef}...`);
        await pullImage(runtime, imageRef, debug, client);
      }

      debug(`Creating container ${fullName}`);
      // Re-emit the image's HEALTHCHECK explicitly; relying on image
      // inheritance leaves containers created over the docker-compat API
      // stuck in `starting` with no probe. An explicit `config.healthcheck`
      // override supersedes the image's, so skip the extra image inspect
      // when one is present.
      const healthcheck =
        config.healthcheck !== undefined
          ? null
          : await getImageHealthcheck(runtime, imageRef, client);
      const createOpts = buildCreateOptions(
        name,
        config,
        runtime,
        healthcheck,
        debug,
      );
      const created = await createAndStart(client, createOpts);
      if (!created.ok && created.conflict) {
        // getContainerState reported "missing" because `inspect` failed,
        // but a container with this name still exists in a state inspect
        // cannot read (e.g. a corrupt storage layer after an unclean
        // shutdown). Remove the stale container and retry the create once.
        debug(
          `Container ${fullName} name conflict despite "missing" state; removing stale container and retrying`,
        );
        await removeContainer(runtime, name, client);
        const retry = await createAndStart(client, createOpts);
        if (!retry.ok) {
          throw new Error(`Failed to create ${fullName}: ${retry.error}`);
        }
        return;
      }
      if (!created.ok) {
        throw new Error(`Failed to create ${fullName}: ${created.error}`);
      }
      return;
    }
  }
}

/** Start an existing container by its prefixed name, tolerating 304 (already running). */
async function startByFullName(
  client: ContainerClient,
  fullName: string,
): Promise<void> {
  const result = await safe(() => client.getContainer(fullName).start());
  // 304 Not Modified = already running; not an error.
  if (
    !result.ok &&
    result.error.raw &&
    /304|already started/i.test(result.error.raw)
  ) {
    return;
  }
  if (!result.ok) {
    throw new Error(`Failed to start ${fullName}: ${result.error.userMessage}`);
  }
}

/**
 * Create + start a container from a create payload. Returns a discriminated
 * result so the caller can detect the name-conflict (409) case and retry
 * after removing the stale container.
 */
async function createAndStart(
  client: ContainerClient,
  opts: Docker.ContainerCreateOptions,
): Promise<{ ok: true } | { ok: false; conflict: boolean; error: string }> {
  const createResult = await safe(() => client.createContainer(opts));
  if (!createResult.ok) {
    const conflict =
      createResult.error.kind === "not-found"
        ? false
        : /already in use|conflict|409/i.test(createResult.error.raw);
    return { ok: false, conflict, error: createResult.error.userMessage };
  }
  const startResult = await safe(() => createResult.value.start());
  if (!startResult.ok) {
    return { ok: false, conflict: false, error: startResult.error.userMessage };
  }
  return { ok: true };
}

export async function startContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<void> {
  await startByFullName(client, prefixedName(name));
}

async function fixVolumePermissions(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<void> {
  const fullName = prefixedName(name);
  const state = await getContainerState(runtime, name, client);
  if (state !== "running") return;

  // Get bind-mounted volume destinations inside the container.
  const info = await safeInspect(() => client.getContainer(fullName).inspect());
  if (info === null) return;
  const mounts = (
    (info.Mounts ?? []) as Array<{ Type?: string; Destination?: string }>
  )
    .filter((m) => m.Type === "bind" && typeof m.Destination === "string")
    .map((m) => m.Destination as string);
  if (mounts.length === 0) return;

  // Grant "others" traversal+write on directories of bind mounts so the
  // host user (which may be "others" relative to the container's
  // user-namespace mapped UID) can descend the tree and delete child
  // files. Deliberately NOT widening file modes: `rm /dir/file` requires
  // write+execute on `/dir`, not on the file itself, so dir perms are
  // sufficient for cleanup. Widening file modes blanket-widens any
  // sensitive files the application may have written (private keys,
  // OAuth tokens, credentials), which is unsafe. Falls back silently if
  // `find` or `chmod` isn't available in the image (distroless etc.).
  await runExec(client, fullName, [
    "find",
    ...mounts,
    "-type",
    "d",
    "-exec",
    "chmod",
    "o+rwx",
    "{}",
    "+",
  ]);
}

export async function stopContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<void> {
  const fullName = prefixedName(name);
  await fixVolumePermissions(runtime, name, client).catch(() => {});
  const result = await safe(() => client.getContainer(fullName).stop());
  if (!result.ok) {
    const state = await getContainerState(runtime, name, client);
    if (state !== "stopped" && state !== "missing") {
      throw new Error(
        `Failed to stop ${fullName}: ${result.error.userMessage}`,
      );
    }
  }
}

export async function removeContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<void> {
  const fullName = prefixedName(name);
  await fixVolumePermissions(runtime, name, client).catch(() => {});
  // `t: 0`: skip the runtime's default 10s SIGTERM grace and SIGKILL
  // immediately. removeContainer is the destructive primitive — callers
  // that want graceful shutdown call containers.stop() instead. A
  // container whose PID 1 ignores SIGTERM (busybox `sleep`, `tail`, …)
  // would otherwise hold the stop for ~10s. We tolerate stop failures
  // (already stopped / 304 / not running) and rely on `remove({force})`
  // as the authoritative step. Works on both podman and docker.
  await safe(() => client.getContainer(fullName).stop({ t: 0 }));
  const result = await safe(() =>
    client.getContainer(fullName).remove({ force: true }),
  );
  // 404 = already gone; that's success for a remove.
  if (!result.ok && result.error.kind !== "not-found") {
    throw new Error(
      `Failed to remove ${fullName}: ${result.error.userMessage}`,
    );
  }
}

export async function listContainers(
  runtime: ContainerRuntimeInfo,
  client: ContainerClient = getClient(),
): Promise<ContainerInfo[]> {
  const result = await safe(() =>
    client.listContainers({
      all: true,
      filters: { name: [CONTAINER_PREFIX] },
    }),
  );
  if (!result.ok) return [];

  return result.value.map((c) => {
    // dockerode `Names` carries a leading slash; strip it to match the
    // bare names the rest of the plugin uses.
    const name = (c.Names?.[0] ?? "").replace(/^\//, "");
    const state: ContainerState = c.State === "running" ? "running" : "stopped";
    const ports = (c.Ports ?? [])
      .map((p) =>
        p.PublicPort
          ? `${p.IP ?? "0.0.0.0"}:${p.PublicPort}->${p.PrivatePort}/${p.Type}`
          : `${p.PrivatePort}/${p.Type}`,
      )
      .filter(Boolean);
    return {
      name,
      image: c.Image ?? "",
      state,
      created: c.Created ? String(c.Created) : "",
      ports,
      managedBy: "",
    };
  });
}

export async function pruneImages(
  runtime: ContainerRuntimeInfo,
  client: ContainerClient = getClient(),
): Promise<{ imagesRemoved: number; spaceReclaimed: string }> {
  const result = await safe(() => client.pruneImages());
  if (!result.ok) {
    throw new Error(`Prune failed: ${result.error.userMessage}`);
  }
  const deleted = result.value.ImagesDeleted ?? [];
  // ImagesDeleted lists one entry per Untagged + Deleted action; count
  // distinct Deleted ids to match the prior "images removed" semantics.
  const removed = deleted.filter(
    (d) => (d as { Deleted?: string }).Deleted,
  ).length;
  return {
    imagesRemoved: removed,
    spaceReclaimed: bytesToString(result.value.SpaceReclaimed ?? 0),
  };
}

/**
 * Run a command inside a container via the Docker exec API and collect its
 * combined output + exit code. dockerode's exec stream is multiplexed
 * (8-byte frame headers); we demux it to plain text. Replaces the
 * `podman/docker exec` CLI path.
 */
async function runExec(
  client: ContainerClient,
  fullName: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const container = client.getContainer(fullName);
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outText = "";
  let errText = "";
  stdout.on("data", (c: Buffer) => (outText += c.toString("utf8")));
  stderr.on("data", (c: Buffer) => (errText += c.toString("utf8")));
  client.modem.demuxStream(stream, stdout, stderr);
  await new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
  });
  const inspect = await exec.inspect();
  return {
    exitCode: inspect.ExitCode ?? 0,
    stdout: outText,
    stderr: errText,
  };
}

export async function execInContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
  command: string[],
  client: ContainerClient = getClient(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runExec(client, prefixedName(name), command);
}

export async function ensureNetwork(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<void> {
  const existing = await safeInspect(() => client.getNetwork(name).inspect());
  if (existing !== null) return;
  const create = await safe(() => client.createNetwork({ Name: name }));
  if (!create.ok && !/already exists/i.test(create.error.raw)) {
    throw new Error(
      `Failed to create network ${name}: ${create.error.userMessage}`,
    );
  }
}

export async function removeNetwork(
  runtime: ContainerRuntimeInfo,
  name: string,
  client: ContainerClient = getClient(),
): Promise<void> {
  const result = await safe(() => client.getNetwork(name).remove());
  if (
    !result.ok &&
    result.error.kind !== "not-found" &&
    !/not found/i.test(result.error.raw)
  ) {
    throw new Error(
      `Failed to remove network ${name}: ${result.error.userMessage}`,
    );
  }
}

export async function connectToNetwork(
  runtime: ContainerRuntimeInfo,
  containerName: string,
  networkName: string,
  client: ContainerClient = getClient(),
): Promise<void> {
  const fullName = prefixedName(containerName);
  const result = await safe(() =>
    client.getNetwork(networkName).connect({ Container: fullName }),
  );
  if (
    !result.ok &&
    // Podman: "is already connected to network"
    !/already connected/i.test(result.error.raw) &&
    // Docker: "endpoint with name ... already exists in network"
    !/already exists in network/i.test(result.error.raw)
  ) {
    throw new Error(
      `Failed to connect ${fullName} to ${networkName}: ${result.error.userMessage}`,
    );
  }
}

export async function disconnectFromNetwork(
  runtime: ContainerRuntimeInfo,
  containerName: string,
  networkName: string,
  client: ContainerClient = getClient(),
): Promise<void> {
  const fullName = prefixedName(containerName);
  const result = await safe(() =>
    client.getNetwork(networkName).disconnect({ Container: fullName }),
  );
  if (!result.ok && !/not connected/i.test(result.error.raw)) {
    throw new Error(
      `Failed to disconnect ${fullName} from ${networkName}: ${result.error.userMessage}`,
    );
  }
}

/**
 * Extract a container ID from a `/proc/self/cgroup` line, if present.
 * Exposed for unit tests; production callers go through
 * `findSelfContainerId`.
 *
 * Handles the formats we see in the wild:
 *
 *   cgroup v1 + Docker:
 *     12:cpuset:/docker/0123abc...def
 *
 *   cgroup v2 + Docker on systemd:
 *     0::/system.slice/docker-0123abc...def.scope
 *
 *   cgroup v2 + Podman rootless on systemd:
 *     0::/user.slice/user-1000.slice/.../libpod-0123abc...def.scope
 *
 *   Kubernetes / containerd (best-effort):
 *     0::/kubepods.slice/.../cri-containerd-0123abc...def.scope
 *
 * Returns null when no recognisable container-id token is found —
 * callers fall through to the next cascade step.  We accept any
 * 12+ hex char run; `docker inspect` will reject false positives
 * (e.g. systemd slice names that happen to be hex).
 */
export function parseSelfContainerIdFromCgroup(line: string): string | null {
  // 1) cgroup v1 path: `/<runtime>/<id>` where runtime is `docker`,
  //    `kubepods/...`, etc.
  const v1 = line.match(/[/]([0-9a-f]{12,64})(?:[/.]|$)/i);
  if (v1) return v1[1];
  // 2) cgroup v2 systemd slice: `<prefix>-<id>.scope`
  const v2 = line.match(
    /(?:docker|libpod|crio|cri-containerd|kubepods.*pod[^-]*)-([0-9a-f]{12,64})\.scope/i,
  );
  if (v2) return v2[1];
  return null;
}

/**
 * Pure: extract every parseable container-ID candidate from a multi-
 * line cgroup file content, in source-line order, deduplicated.
 * Returns an empty array when no line yields a candidate.
 *
 * Exists separately from `readSelfContainerIdsFromCgroup` so unit
 * tests can drive the multi-line / dedup logic without touching
 * `/proc/self/cgroup` (which varies across test hosts).
 */
export function parseSelfContainerIdsFromCgroupFile(content: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    const id = parseSelfContainerIdFromCgroup(line);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Read `/proc/self/cgroup` (cgroup v1: many lines, one per controller,
 * all typically pointing at the same container; v2: single `0::/...`
 * line) and extract every recognisable container-ID candidate.
 * Returned in source-line order, deduplicated.  Empty array when not
 * in a container, when the file isn't readable, or when no parseable
 * id is present.
 *
 * Returning all candidates instead of just the first lets
 * `findSelfContainerId` validate each via `inspect` and skip false
 * positives — important because `parseSelfContainerIdFromCgroup`'s
 * regex is permissive on purpose (matches short 12-char ids and
 * various runtime prefixes), so a non-container path that happens
 * to embed a 12+ hex run could otherwise short-circuit detection.
 *
 * Skipped in production paths when `isContainerized()` is false.
 */
export function readSelfContainerIdsFromCgroup(): string[] {
  let content: string;
  try {
    content = readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return [];
  }
  return parseSelfContainerIdsFromCgroupFile(content);
}

/**
 * Pure: extract every parseable container-ID candidate from a
 * `/proc/self/mountinfo` style payload, in source-line order,
 * deduplicated. The runtime stamps the full container id into the
 * mount source path for the bindfs files it injects (`/etc/hostname`,
 * `/etc/resolv.conf`, `/run/.containerenv`):
 *
 *   - Podman: `…/containers/overlay-containers/<64-hex>/userdata/…`
 *   - Docker: `/<64-hex>/…` (rooted at the storage driver's container dir)
 *
 * Both patterns yield the same 64-character id when matched. We
 * require 64 hex chars (not 12+) to avoid matching arbitrary content-
 * addressed paths like overlay layers (which use the same hex length
 * but DIFFERENT ids).
 *
 * Exists separately from `readSelfContainerIdsFromMountinfo` so unit
 * tests can drive the parser without touching `/proc/self/mountinfo`.
 */
export function parseSelfContainerIdsFromMountinfo(content: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  // Podman: …/containers/overlay-containers/<id>/userdata/…
  const podmanRx =
    /\/containers\/overlay-containers\/([0-9a-f]{64})\/userdata\//g;
  // Docker: a 64-hex path component immediately followed by a known
  // bindfs file name. Tight enough to avoid layer-hash false positives.
  const dockerRx =
    /\/([0-9a-f]{64})\/(?:hostname|resolv\.conf|hosts|containerenv|userdata)/g;
  for (const line of content.split("\n")) {
    for (const rx of [podmanRx, dockerRx]) {
      let m: RegExpExecArray | null;
      // Use the global regex's lastIndex by reading it from a fresh
      // copy each line, otherwise iterating two lines could skip
      // matches that fell behind lastIndex from the previous line.
      rx.lastIndex = 0;
      while ((m = rx.exec(line)) !== null) {
        const id = m[1];
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

/**
 * Read `/proc/self/mountinfo` and extract every recognisable container
 * id. Returned in source-line order, deduplicated. Empty array when
 * the file isn't readable or no id is present.
 *
 * This is the fourth detection step in `findSelfContainerId`, picking
 * up the case where:
 *   - SIGNALK_CONTAINER_ID is unset, AND
 *   - HOSTNAME is empty (Quadlet doesn't set it for the container
 *     env by default), AND
 *   - /proc/self/cgroup is `0::/` (split-cgroups Quadlet setup), AND
 *   - the container is running with `Network=host` (so /etc/hostname
 *     returns the host machine name, not the container name).
 *
 * The mountinfo source path is the same for every container the
 * runtime starts, so it works regardless of network mode, cgroup
 * delegation, or whether HOSTNAME is set.
 */
export function readSelfContainerIdsFromMountinfo(): string[] {
  let content: string;
  try {
    content = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return [];
  }
  return parseSelfContainerIdsFromMountinfo(content);
}

/**
 * Validate that `candidateId` is a real container by trying
 * `<runtime> inspect <candidateId>`.  Returns the same `candidateId`
 * on success, null otherwise.  Used by `findSelfContainerId` to
 * filter out HOSTNAME values that aren't actually our container
 * (the bug from issue #23: under `network_mode: host`, HOSTNAME is
 * the machine name, not a container id).
 */
async function tryInspect(
  runtime: ContainerRuntimeInfo,
  candidateId: string,
  debug: (msg: string) => void,
  source: string,
  client: ContainerClient = getClient(),
): Promise<string | null> {
  if (!candidateId) return null;
  const info = await safeInspect(() =>
    client.getContainer(candidateId).inspect(),
  );
  if (info?.Id) {
    return candidateId;
  }
  debug(
    `findSelfContainerId(${source}): inspect '${candidateId}' failed (not found)`,
  );
  return null;
}

/**
 * Find this signalk-server's own container id, cascading across the
 * known-reliable signals to the brittle ones:
 *
 *   1. `SIGNALK_CONTAINER_ID` env var — explicit override.  Doc-ed
 *      escape hatch for any deployment where automatic detection
 *      proves unreliable.
 *   2. `HOSTNAME` env var — works in default-network deployments
 *      where Docker/Podman set HOSTNAME to the (short) container id.
 *      Validated via `inspect`: under `network_mode: host` the
 *      container inherits the host's hostname (e.g. "halos") and
 *      `inspect` fails — we fall through to the next step.  This
 *      is the bug fixed by this helper (issue #23).
 *   3. `/proc/self/cgroup` — robust against host-network mode and
 *      any other case where HOSTNAME is wrong.  The id we extract
 *      gets the same `inspect`-validation treatment.
 *   4. `/proc/self/mountinfo` — the runtime stamps the full
 *      container id into the source path of `/etc/hostname`,
 *      `/etc/resolv.conf`, `/run/.containerenv` and friends.  This
 *      catches the case where step 2 and step 3 both fail: under a
 *      Podman Quadlet with `Network=host`, HOSTNAME is empty (the
 *      Quadlet doesn't forward it into the container's environment)
 *      AND `/proc/self/cgroup` is the rootless `0::/` placeholder.
 *      mountinfo is set by the runtime regardless of network mode or
 *      cgroup delegation, so this step succeeds where the others
 *      can't.
 *
 * Returns null when none of the cascade steps yield a valid id.
 * Callers should treat this exactly like the previous "HOSTNAME
 * unset" behaviour — fall back to bare-metal-style handling, or
 * return null to the caller (depends on the consumer).
 */
export async function findSelfContainerId(
  runtime: ContainerRuntimeInfo,
  debug: (msg: string) => void = () => {},
  client: ContainerClient = getClient(),
): Promise<string | null> {
  // 1. Explicit override — no `inspect` validation needed since the
  //    operator chose this deliberately.  An invalid value here
  //    surfaces as the same downstream error the user would have
  //    seen without the env var.
  const envOverride = process.env.SIGNALK_CONTAINER_ID;
  if (envOverride && envOverride.trim()) {
    return envOverride.trim();
  }

  // 2. HOSTNAME, validated by `inspect`.
  const hostname = process.env.HOSTNAME ?? "";
  const fromHostname = await tryInspect(
    runtime,
    hostname,
    debug,
    "HOSTNAME",
    client,
  );
  if (fromHostname) return fromHostname;

  // 3. /proc/self/cgroup, also validated by `inspect`.  Walk every
  //    parseable candidate (cgroup v1 lists one per controller; v2
  //    has only one) so a permissive regex match on an early line
  //    that doesn't actually correspond to our container can't
  //    short-circuit detection — we keep trying until one validates.
  for (const id of readSelfContainerIdsFromCgroup()) {
    const validated = await tryInspect(
      runtime,
      id,
      debug,
      "/proc/self/cgroup",
      client,
    );
    if (validated) return validated;
  }

  // 4. /proc/self/mountinfo — same validation pattern as cgroup. The
  //    parser only yields 64-char hex ids matched against known
  //    bindfs file paths (hostname / resolv.conf / containerenv /
  //    userdata), so `inspect` validation guards against the
  //    unlikely false positive.
  for (const id of readSelfContainerIdsFromMountinfo()) {
    const validated = await tryInspect(
      runtime,
      id,
      debug,
      "/proc/self/mountinfo",
      client,
    );
    if (validated) return validated;
  }

  return null;
}

/**
 * Extract `InspectedMount[]` from a dockerode container inspect. dockerode
 * returns `Mounts` as structured objects (`{Type, Name, Source,
 * Destination}`), replacing the `{{range .Mounts}}...` template parse.
 */
function mountsFromInspect(info: {
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
  }>;
}): InspectedMount[] {
  return (info.Mounts ?? []).map((m) => ({
    type: m.Type ?? "",
    name: m.Name ?? "",
    source: m.Source ?? "",
    dest: m.Destination ?? "",
  }));
}

/**
 * Resolve what to mount in a managed container to give it access to
 * the SignalK data directory, regardless of how SignalK itself is deployed.
 *
 * Returns the string to use as the LEFT side of a `-v <source>:<dest>` flag:
 *   - Bare-metal SignalK: returns dataDir directly (it is already a host path).
 *   - SignalK in Docker, volume-backed dataDir: returns the named volume.
 *   - SignalK in Docker, bind-backed dataDir: returns the exact host path
 *     (computing the subpath when a parent directory is bind-mounted).
 *   - Fallback (mount not found): returns dataDir — the caller's `-v` will
 *     fail gracefully at container-create time with a clear Docker error.
 *
 * The result can be used directly as `volumes: { [mountPoint]: source }` in
 * a ContainerConfig.  The content visible at mountPoint inside the managed
 * container will always correspond to the root of dataDir.
 */
export async function resolveSignalkDataSource(
  dataDir: string,
  runtime: ContainerRuntimeInfo,
  debug: (msg: string) => void = () => {},
  client: ContainerClient = getClient(),
): Promise<string> {
  if (!isContainerized()) {
    // Running bare-metal: dataDir is already a host filesystem path.
    return dataDir;
  }

  // Running inside a container.  `findSelfContainerId` cascades
  // SIGNALK_CONTAINER_ID -> HOSTNAME -> /proc/self/cgroup so that
  // network_mode: host deployments (where HOSTNAME is the host
  // machine name, not a container id) still resolve correctly.
  const selfId = await findSelfContainerId(runtime, debug, client);
  if (!selfId) {
    debug(
      `resolveSignalkDataSource: could not detect self container id; falling back to dataDir=${dataDir}`,
    );
    return dataDir;
  }

  const info = await safeInspect(() => client.getContainer(selfId).inspect());
  if (info === null) {
    debug(
      `resolveSignalkDataSource: inspect ${selfId} failed; falling back to dataDir=${dataDir}`,
    );
    return dataDir;
  }

  const mounts = mountsFromInspect(info);

  // Find the mount whose Destination is the longest prefix of dataDir
  // (handles both exact matches and parent-directory bind mounts).
  let best: InspectedMount | null = null;
  for (const m of mounts) {
    if (dataDir === m.dest || dataDir.startsWith(m.dest + "/")) {
      if (!best || m.dest.length > best.dest.length) {
        best = m;
      }
    }
  }

  if (!best) {
    debug(
      `resolveSignalkDataSource: no mount covers dataDir=${dataDir}; mounts=${JSON.stringify(mounts)}; falling back to dataDir`,
    );
    return dataDir;
  }

  if (best.type === "volume") {
    // Named volume. Docker doesn't support subpath mounts on volumes,
    // so we return the volume name as-is. The consumer's mount point
    // will correspond to best.dest; if that equals dataDir (the common
    // case) the consumer can use mountPoint directly. If best.dest is a
    // parent of dataDir, the consumer must append the relative suffix —
    // signalk-container surfaces this via ContainerManagerApi if needed.
    return best.name;
  }

  // Bind mount. Compute the exact host path that corresponds to dataDir,
  // even when the bind covers a parent directory.
  return best.source + dataDir.slice(best.dest.length);
}

/**
 * Mount entry as parsed from `podman inspect --format '{{range .Mounts}}...'`.
 * Exposed so tests can drive `resolveHostPathFromMounts` directly without
 * touching a real runtime.
 */
export interface InspectedMount {
  type: string;
  name: string;
  source: string;
  dest: string;
}

/**
 * Pure (source, subPath) resolution given a list of mounts and an
 * absolute path.  Factored out of `resolveHostPath` so the matching
 * logic can be unit-tested independently of the runtime.  Returns null
 * when no mount covers `absPath`.
 */
export function resolveHostPathFromMounts(
  absPath: string,
  mounts: InspectedMount[],
): ContainerMountResolution | null {
  // Longest-prefix match.  Same logic as resolveSignalkDataSource — handles
  // exact matches and parent-directory mounts uniformly.
  let best: InspectedMount | null = null;
  for (const m of mounts) {
    if (absPath === m.dest || absPath.startsWith(m.dest + "/")) {
      if (!best || m.dest.length > best.dest.length) {
        best = m;
      }
    }
  }
  if (!best) return null;

  // Subpath inside the mount (relative to its Destination).  Empty when
  // the mount covers absPath exactly.
  const subPath =
    absPath === best.dest ? "" : absPath.slice(best.dest.length + 1);

  if (best.type === "volume") {
    // Named volume.  The runtime cannot subpath-mount volumes (Docker
    // and Podman both reject `-v vol/sub:/dest`), so we return the
    // volume name as the source and let the consumer navigate to
    // subPath from inside the mounted volume root.
    return { source: best.name, subPath };
  }

  // Bind mount.  We CAN subpath-bind the host filesystem — and doing so
  // gives the helper container the narrowest possible view of the host.
  // Return the exact host path corresponding to absPath as the source,
  // with subPath empty (the consumer's mount destination IS the absPath).
  const hostPath = subPath === "" ? best.source : `${best.source}/${subPath}`;
  return { source: hostPath, subPath: "" };
}

/**
 * Result shape for `resolveHostPath`.
 *
 * `source` is the LEFT side of a `-v <source>:<dest>` flag, suitable for
 * dropping into ContainerJobConfig.inputs / outputs as the value:
 *
 *     runJob({ inputs: { "/in": resolution.source }, ... })
 *
 * `subPath` is the path INSIDE the mount where the original absolute
 * path lives.  Empty string when the source already corresponds to
 * the absolute path (no further indirection needed).  Otherwise the
 * consumer must navigate to it from the mount root, e.g.:
 *
 *     command: ["gdal_translate", `/in/${resolution.subPath}/file.000`, ...]
 *
 * The slash-prefix discipline is the consumer's: `subPath` itself never
 * has a leading slash.
 */
export interface ContainerMountResolution {
  source: string;
  subPath: string;
}

/**
 * Translate an arbitrary absolute path into the `(source, subPath)` pair
 * that lets a managed container reach that path on the host, regardless
 * of how SignalK itself is deployed.  Generalises
 * `resolveSignalkDataSource` to paths outside `app.getDataDirPath()`.
 *
 * Use cases:
 *   - SignalK in a container with a bind mount that covers a *parent*
 *     directory (typical: `-v /opt/signalk:/home/node/.signalk`).
 *     Both the data dir and any sibling chart directory under `/opt/signalk`
 *     are reachable through the same mount.
 *   - SignalK in a container with a named volume that covers a parent
 *     directory.  The same volume name is returned and the consumer
 *     mounts it whole — the runtime cannot subpath-mount volumes.
 *   - Bare-metal SignalK: any absolute path is its own host path.
 *
 * Returns `null` when:
 *   - The runtime can't be inspected (we couldn't determine our own
 *     mounts, e.g. HOSTNAME unset, inspect failed).
 *   - We're inside a container but no mount covers `absPath` — meaning
 *     the host runtime physically cannot see this path.  The consumer
 *     should surface an actionable error (not silently fall through, as
 *     `resolveSignalkDataSource` does for backwards-compat).
 */
export async function resolveHostPath(
  absPath: string,
  runtime: ContainerRuntimeInfo,
  debug: (msg: string) => void = () => {},
  client: ContainerClient = getClient(),
): Promise<ContainerMountResolution | null> {
  if (!isContainerized()) {
    // Bare-metal: the absolute path IS the host path.  No subpath needed.
    return { source: absPath, subPath: "" };
  }

  // Cascade SIGNALK_CONTAINER_ID -> HOSTNAME -> /proc/self/cgroup
  // so `network_mode: host` deployments (where HOSTNAME is the host
  // machine name, not a container id) still resolve correctly.
  const selfId = await findSelfContainerId(runtime, debug, client);
  if (!selfId) {
    debug(
      `resolveHostPath: could not detect self container id; cannot resolve ${absPath}`,
    );
    return null;
  }

  const info = await safeInspect(() => client.getContainer(selfId).inspect());
  if (info === null) {
    debug(`resolveHostPath: inspect ${selfId} failed`);
    return null;
  }

  const mounts = mountsFromInspect(info);

  const resolved = resolveHostPathFromMounts(absPath, mounts);
  if (!resolved) {
    debug(
      `resolveHostPath: no mount covers ${absPath}; mounts=${JSON.stringify(mounts)}`,
    );
  }
  return resolved;
}

/**
 * Process-local set of ports that are currently reserved by an in-flight
 * `findAvailablePort()` call.  Prevents two concurrent `ensureRunning()`
 * calls from probing and claiming the same host port before either
 * container has actually been created.
 *
 * Ports are added here just before `findAvailablePort()` resolves and
 * removed via `releaseReservedPort()` once the container runtime holds the
 * binding (successful create) or the attempt fails.
 */
const reservedPorts = new Set<number>();

/**
 * Release a port that was reserved by `findAvailablePort()`.
 * Must be called after the container runtime has successfully bound the port
 * (so the OS-level bind now prevents collisions), or when the container
 * creation failed (so the next attempt can re-probe freely).
 */
export function releaseReservedPort(port: number): void {
  reservedPorts.delete(port);
}

/**
 * Test whether `port` is bindable on 127.0.0.1.
 * Returns `true` if the socket can be opened and closed without error.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find the lowest available TCP port on 127.0.0.1 starting at `preferred`.
 *
 * Probes by briefly binding a server socket and also skips ports that are
 * already reserved in-process by a concurrent `findAvailablePort()` call,
 * eliminating the TOCTOU window between the probe and the container create.
 *
 * The chosen port is added to the process-local `reservedPorts` set before
 * this function resolves.  The caller is responsible for releasing it via
 * `releaseReservedPort()` once the runtime holds the binding or the attempt
 * fails.
 *
 * Used by the `signalkAccessiblePorts` bare-metal path to prefer the
 * declared port number while gracefully stepping over conflicts.
 */
export async function findAvailablePort(preferred: number): Promise<number> {
  for (let port = preferred; port <= 65535; port++) {
    if (reservedPorts.has(port)) continue;
    if (await isPortAvailable(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
  throw new Error("No available port found in range 1024–65535");
}

// Reserved default-network names that do NOT provide same-network container
// DNS: Docker's `bridge`, rootless Podman's `podman`, plus the `host`/`none`
// virtual modes. A container on any of these can't be reached by name, so the
// `signalkAccessiblePorts` resolver excludes them and shares SignalK's netns
// instead. Neither runtime lets a user-defined network reuse these names.
const DNSLESS_DEFAULT_NETWORKS = new Set(["bridge", "podman", "host", "none"]);

/**
 * From the network names a container is attached to, return only the ones that
 * support same-network container-name DNS — i.e. drop the reserved defaults
 * (`bridge`, `podman`, `host`, `none`). Pure so it can be unit-tested without a
 * runtime; `resolveSignalkNetworks` wraps it around live inspect data.
 */
export function userDefinedDnsNetworks(networkNames: string[]): string[] {
  return networkNames.filter((n) => !DNSLESS_DEFAULT_NETWORKS.has(n));
}

/**
 * Return the user-defined Docker/Podman networks that the current SignalK
 * container is connected to (i.e. networks other than the default `bridge`,
 * `host`, or `none`).
 *
 * Used by the `signalkAccessiblePorts` containerized path to attach a
 * managed container to SignalK's own network so the two can communicate
 * via DNS name without exposing any host port.
 *
 * Returns:
 *   - `null`    when running bare-metal, or when self-container detection
 *               fails (`SIGNALK_CONTAINER_ID` unset, HOSTNAME unusable
 *               under `network_mode: host`, and `/proc/self/cgroup` not
 *               parseable).  Callers should treat this like bare-metal
 *               and publish ports instead.
 *   - `string[]` (possibly empty) when inspect succeeds.  An empty array means
 *               SignalK is only on the default bridge — callers should fall
 *               back to `networkMode: container:<self-container-id>`.  A non-empty
 *               array contains the user-defined network names to attach to.
 */
export async function resolveSignalkNetworks(
  runtime: ContainerRuntimeInfo,
  debug: (msg: string) => void = () => {},
  client: ContainerClient = getClient(),
): Promise<string[] | null> {
  if (!isContainerized()) return null;

  // Cascade detection — see `findSelfContainerId`.  Critically this fixes
  // `network_mode: host` deployments where HOSTNAME is the host machine
  // name (e.g. "halos") rather than the container id.
  const selfId = await findSelfContainerId(runtime, debug, client);
  if (!selfId) {
    debug(
      "resolveSignalkNetworks: could not detect self container id, returning null",
    );
    return null;
  }

  const info = await safeInspect(() => client.getContainer(selfId).inspect());
  if (info === null) {
    debug(
      `resolveSignalkNetworks: inspect ${selfId} failed — treating as bare-metal`,
    );
    return null;
  }

  const all = Object.keys(info.NetworkSettings?.Networks ?? {});
  // Default networks don't provide container-name DNS resolution, so a
  // managed container attached to one is unreachable by name — callers must
  // fall back to sharing SignalK's netns instead. The docker-compat
  // network-inspect API doesn't expose a DNS flag, so we match the reserved
  // default-network names rather than probing.
  const userDefined = userDefinedDnsNetworks(all);
  debug(
    `resolveSignalkNetworks: all=${all.join(",")} userDefined=${userDefined.join(",")}`,
  );
  return userDefined;
}

export async function waitForReady(
  url: string,
  timeoutMs: number = 30000,
  intervalMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url} to become ready`);
}
