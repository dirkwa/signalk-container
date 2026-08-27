import * as net from "node:net";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  ContainerConfig,
  ContainerInfo,
  ContainerRuntimeInfo,
  ContainerState,
  DeviceIssue,
  EnsureRunningOptions,
  HealthcheckOverride,
  LocalImageSummary,
  ManagedImageRef,
  NofileLimits,
  PruneResult,
  ContainerWedged,
  ResourceClamp,
  UlimitClamp,
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
import {
  describeError,
  isStorageCorruptError,
  isUlimitRejectionText,
  messageWithRaw,
  type ErrorKind,
} from "./errors.js";
import {
  DEVICES_UNRESOLVED_LABEL,
  filterUnresolvedDeviceEntries,
  KEEP_ORIGINAL_GROUPS_ANNOTATION,
  parseUnresolvedDevicesLabel,
  presentLiveDeviceNodes,
  resolveDeviceRequests,
  resolveGroupAdd,
  unresolvedGroupNames,
  type DeviceNodeSpec,
} from "./devices.js";
import { parseResourceLimits, resourcePayloadForRun } from "./resources.js";
import { containerPrefix, requestedResourcesLabel } from "./namespace.js";
import { classifyTag } from "./updates/tagClassifier.js";
import { compareVersions } from "./updates/semver.js";
import { isOfflineError } from "./updates/offline.js";

export function prefixedName(name: string): string {
  const prefix = containerPrefix();
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
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
 * Build the `HostConfig.Binds` value for a hot-plug device directory
 * (`/dev/snd`, `/dev/input`, …). Unlike {@link volumeArg} this NEVER adds
 * Podman's `:Z` SELinux suffix: relabelling would touch the host's own
 * device nodes in a shared system directory. Kept as a named helper so
 * that intentional omission lives in code, not only in a comment, and the
 * device-bind format has a single source of truth like `volumeArg` does
 * for volumes.
 */
export function deviceBindArg(hostPath: string, containerPath: string): string {
  return `${hostPath}:${containerPath}`;
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

/**
 * Zone names that mean "no offset from UTC". Container images already
 * default to UTC, so resolving one of these means there is nothing to
 * propagate — and, in the in-container deployment, that the real host
 * zone is unknowable from in here (the container's own /etc/localtime
 * is UTC unless the operator passed the zone in).
 */
const UTC_ZONE_NAMES = new Set([
  "UTC",
  "Etc/UTC",
  "Etc/Universal",
  "Universal",
  "GMT",
  "Etc/GMT",
  "Greenwich",
  "Etc/Greenwich",
  "Zulu",
  "Etc/Zulu",
]);

/**
 * The IANA zone the SignalK process runs in, or `undefined` when it is
 * UTC (nothing to propagate — containers already default to UTC).
 * `Intl` honors the `TZ` env var and falls back to the system zone
 * (/etc/localtime), so both bare-metal and TZ-configured deployments
 * resolve correctly. `systemZone` is injectable for tests.
 */
export function resolveHostTimezone(
  systemZone: () => string = () =>
    Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | undefined {
  const zone = systemZone();
  return UTC_ZONE_NAMES.has(zone) ? undefined : zone;
}

/**
 * Default the container's `TZ` to the host timezone so wall-clock logic
 * inside managed containers (cron-style Node-RED flows, log timestamps,
 * Grafana/QuestDB time rendering) agrees with the host. A consumer that
 * sets `env.TZ` itself — any value, including "" — wins; an unknown or
 * UTC host zone injects nothing. Pure and synchronous, mirroring
 * `defaultHomeForConfigRoot`.
 */
export function defaultTimezoneEnv(
  env: Record<string, string> | undefined,
  zone: string | undefined,
): Record<string, string> | undefined {
  if (!zone) return env;
  if (env?.TZ !== undefined) return env;
  return { ...env, TZ: zone };
}

/**
 * What a host-source probe could establish about a path.
 *
 * `"unknown"` is NOT a synonym for absent. When the manager runs inside a
 * container its filesystem is not the one the runtime resolves bind sources
 * against, so `existsSync` on a host path answers a different question than
 * the one asked. Reporting that as absent drops a volume whose source is
 * perfectly real — the bug this type exists to prevent.
 */
export type VolumeSourceState = boolean | "unknown";

export function classifyVolumeSources(
  volumes: Record<string, string | VolumeSpec> | undefined,
  probe: (path: string) => VolumeSourceState = existsSync,
): {
  kept: Record<string, string>;
  skipped: Array<{ containerPath: string; source: string }>;
  aborted: Array<{ containerPath: string; source: string }>;
  /** Host paths whose existence could not be established. Kept, not dropped. */
  unverified: Array<{ containerPath: string; source: string }>;
} {
  const kept: Record<string, string> = {};
  const skipped: Array<{ containerPath: string; source: string }> = [];
  const aborted: Array<{ containerPath: string; source: string }> = [];
  const unverified: Array<{ containerPath: string; source: string }> = [];
  if (!volumes) return { kept, skipped, aborted, unverified };

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
    const state = probe(source);
    if (state === true) {
      kept[containerPath] = source;
      continue;
    }

    // Could not tell whether the source exists. Each policy keeps the
    // guarantee it promised, because the runtimes disagree about what a
    // missing bind source does -- verified against both: Docker silently
    // auto-creates an empty directory, podman refuses to start the container
    // (`statfs: no such file or directory`).
    //
    // `abort` means "cannot run without this" (TLS certs, required state).
    // Keeping it would mount an empty directory where the certs belong and
    // start anyway on Docker -- the exact outcome the policy prevents.
    //
    // `skip` and `create` are kept. Dropping a skip source here is what #245
    // reports: the mount is real and working, and omitting it is the silent
    // failure the caller cannot see. The residual risk -- a source that is
    // genuinely absent AND unverifiable -- is bounded by the probe above,
    // which returns "unknown" only when this process has no bind mount
    // covering the path and therefore cannot be the one to judge.
    if (state === "unknown") {
      if (policy === "abort") {
        aborted.push({ containerPath, source });
      } else {
        unverified.push({ containerPath, source });
        kept[containerPath] = source;
      }
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

  return { kept, skipped, aborted, unverified };
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
 * Invoke an `onDeviceIssue` callback safely. Same shape and rationale
 * as `safeInvokeVolumeIssue`.
 */
export function safeInvokeDeviceIssue(
  handler: ((event: DeviceIssue) => void | Promise<void>) | undefined,
  event: DeviceIssue,
  reportError: (err: unknown) => void,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(event)).catch(reportError);
  } catch (err) {
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
 * Invoke an `onUlimitClamped` callback safely. Same shape and rationale
 * as `safeInvokeVolumeIssue` — see that helper's doc.
 */
export function safeInvokeUlimitClamped(
  handler: ((event: UlimitClamp) => void | Promise<void>) | undefined,
  event: UlimitClamp,
  reportError: (err: unknown) => void,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(event)).catch(reportError);
  } catch (err) {
    reportError(err);
  }
}

/**
 * Resource-clamp handlers are advisory: a throwing, rejecting or
 * never-settling handler must not interrupt or delay container
 * reconciliation, so it is invoked fire-and-forget with both failure
 * shapes routed to `reportError`.
 */
export function safeInvokeResourceClamped(
  handler: ((event: ResourceClamp) => void | Promise<void>) | undefined,
  event: ResourceClamp,
  reportError: (err: unknown) => void,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(event)).catch(reportError);
  } catch (err) {
    reportError(err);
  }
}

/**
 * Invoke an `onContainerWedged` callback safely. A container wedged
 * unkillable is an operator-recoverable condition, not a lifecycle error:
 * isolate a throwing/rejecting handler so it can never re-enter the
 * reconcile path.
 */
export function safeInvokeContainerWedged(
  handler: ((event: ContainerWedged) => void | Promise<void>) | undefined,
  event: ContainerWedged,
  reportError: (err: unknown) => void,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(event)).catch(reportError);
  } catch (err) {
    reportError(err);
  }
}

/**
 * Invoke an `onUnhealthy` callback safely. Same shape and rationale as
 * `safeInvokeVolumeIssue` (isolate a throwing/rejecting handler so it can
 * never re-enter the health-check loop), but with the `(name, reason)`
 * signature `onUnhealthy` carries.
 */
export function safeInvokeUnhealthy(
  handler: ((name: string, reason: string) => void | Promise<void>) | undefined,
  name: string,
  reason: string,
  reportError: (err: unknown) => void,
): void {
  if (!handler) return;
  try {
    void Promise.resolve(handler(name, reason)).catch(reportError);
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
    throw new Error(
      `logs ${name}: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
      { cause: result.error },
    );
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
    if (parts.length === 1) {
      // A single-segment ref can never carry a registry — a dot or
      // colon here belongs to the tag (`alpine:3.19`), not a host.
      // Single-name Docker Hub repos get the implicit `library/`
      // namespace: podman canonicalizes `alpine` to
      // `docker.io/library/alpine` and reports that form in
      // `Config.Image`. Emitting anything else here would make
      // `diffContainerConfig` compare the two spellings as different
      // images and recreate the container on every ensureRunning call.
      return `docker.io/library/${image}`;
    }
    // Treat the first component as a registry only if it has a dot, a
    // colon (port), or is exactly "localhost". Otherwise, prefix
    // docker.io/.
    const looksLikeRegistry =
      parts[0].includes(".") ||
      parts[0].includes(":") ||
      parts[0] === "localhost";
    if (parts.length === 2 && !looksLikeRegistry) {
      return `docker.io/${image}`;
    }
  }
  return image;
}

/**
 * The qualified repo forms a managed image can appear under in podman's
 * local `repoTags`. `qualifyImage` emits podman's canonical spelling
 * (including the implicit `library/` namespace for single-name Docker
 * Hub repos), so this is normally a single form; the expansion below
 * only fires for inputs that still reach it in the historical
 * `docker.io/<name>` spelling (e.g. persisted manifest records).
 */
export function qualifiedRepoVariants(
  image: string,
  runtime: ContainerRuntimeInfo,
): string[] {
  const qualified = qualifyImage(image, runtime);
  const LIBRARY_PREFIX = "docker.io/";
  const rest = qualified.startsWith(LIBRARY_PREFIX)
    ? qualified.slice(LIBRARY_PREFIX.length)
    : null;
  // Only a single-segment Docker Hub repo (no user/org) gets the
  // implicit `library/` namespace from podman.
  if (rest && !rest.includes("/")) {
    return [qualified, `${LIBRARY_PREFIX}library/${rest}`];
  }
  return [qualified];
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
  // running container always carries the namespace prefix (`sk-` by
  // default — see namespace.ts).
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
    throw new Error(
      `Failed to pull ${image}: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
      { cause: result.error },
    );
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
 * Upper bound on the `.State.Error` text surfaced to callers. Some OCI
 * runtime rejections embed multi-kilobyte detail (spec dumps, nested
 * wrapper chains); the reader needs the leading human-readable cause,
 * not the whole payload.
 */
export const LAST_ERROR_MAX_CHARS = 500;

/**
 * The runtime's record of a container's most recent start/run failure
 * (inspect `.State.Error`, set by podman/docker when e.g. the OCI
 * runtime rejects the container). A container that never started has
 * no logs, so this text is the only diagnostic it leaves behind.
 * Returns `undefined` when the container is missing or the runtime
 * recorded no error; the text is trimmed and truncated to
 * `LAST_ERROR_MAX_CHARS`.
 */
export async function getContainerLastError(
  name: string,
  client: ContainerClient = getClient(),
): Promise<string | undefined> {
  const info = await safeInspect(() =>
    client.getContainer(prefixedName(name)).inspect(),
  );
  const raw = info?.State?.Error;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length <= LAST_ERROR_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, LAST_ERROR_MAX_CHARS).trimEnd()}…`;
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
  // Both runtimes report 0 when no shares were requested. 1024 is a real
  // request, not a default: on crun it maps to cpu.weight 39 where unset
  // means 100 (see CPU_PRIORITY_SHARES in configNormalize.ts).
  if (Number.isFinite(shares) && shares > 0) {
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
 * Requested-resource-limits provenance for a managed container, read
 * back from the label `buildCreateOptions` stamps at create time.
 *
 * Returns the limits the consumer requested when the container was
 * created (`{}` when it was created with none), or `undefined` when no
 * provenance exists — the container is missing, predates the label, or
 * the label doesn't parse. Callers treat `undefined` as "unknown":
 * `fieldsRequiringRecreateForUnset` then falls back to the plain
 * current-vs-target check minus runtime-injected fields.
 */
export async function getRequestedResources(
  name: string,
  client: ContainerClient = getClient(),
): Promise<import("./types.js").ContainerResourceLimits | undefined> {
  const info = await safeInspect(() =>
    client.getContainer(prefixedName(name)).inspect(),
  );
  const labels = (
    info?.Config as
      { Labels?: Record<string, unknown> | null } | null | undefined
  )?.Labels;
  const raw = labels?.[requestedResourcesLabel()];
  if (typeof raw !== "string") return undefined;
  return parseResourceLimits(raw);
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
  binds: Array<{ host: string; container: string; readOnly?: boolean }>;
  portBindings: Map<string, PortBinding[]>;
  extraHosts: Map<string, string>;
  /**
   * Device nodes from `HostConfig.Devices`. Docker reports the entries
   * it was created with; Podman applies them but reports an empty list
   * (verified live on 5.4.2 — even for CLI-created `--device`
   * containers), so the diff must not live-compare devices on Podman.
   */
  devices: DeviceNodeSpec[];
  /** `HostConfig.DeviceCgroupRules`, `[]` when unset (`null` live). */
  deviceCgroupRules: string[];
  /** `HostConfig.GroupAdd`, `[]` when unset. Both runtimes report it. */
  groupAdd: string[];
  /**
   * `Config.Labels`, `{}` when unset. Not part of drift detection as a
   * field — read for the system labels signalk-container stamps itself,
   * notably `DEVICES_UNRESOLVED_LABEL` (device entries the host rejected
   * at create time), which gates the device/volume mirror in
   * `diffContainerConfig`.
   */
  labels: Record<string, string>;
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
    Labels?: Record<string, unknown> | null;
  };
  const hostConfig = (info.HostConfig ?? {}) as {
    NetworkMode?: string;
    Binds?: string[] | null;
    PortBindings?: Record<string, unknown> | null;
    ExtraHosts?: string[] | null;
    Devices?: Array<Record<string, unknown>> | null;
    DeviceCgroupRules?: string[] | null;
    GroupAdd?: string[] | null;
  };
  const rawCmd = config.Cmd ?? null;
  const rawNetworkMode = hostConfig.NetworkMode;
  const rawBinds = hostConfig.Binds ?? null;
  const rawEnv = config.Env ?? null;
  const rawPortBindings = hostConfig.PortBindings ?? null;
  const rawExtraHosts = hostConfig.ExtraHosts ?? null;
  const rawUser = config.User;
  const rawDevices = hostConfig.Devices ?? null;
  const rawDeviceCgroupRules = hostConfig.DeviceCgroupRules ?? null;
  const rawGroupAdd = hostConfig.GroupAdd ?? null;

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

  const binds: Array<{ host: string; container: string; readOnly?: boolean }> =
    [];
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
      // `ro` is remembered rather than merely discarded — read-only is a
      // semantic difference, so flipping it has to count as drift and
      // recreate, not silently keep a writable mount.
      const FLAG_RE = /^[a-zA-Z,]+$/;
      let readOnly = false;
      while (
        segments.length > 2 &&
        FLAG_RE.test(segments[segments.length - 1])
      ) {
        const flags = (segments.pop() as string).split(",");
        // `rro` is the recursive form; both mean the mount is not writable.
        if (flags.includes("ro") || flags.includes("rro")) readOnly = true;
      }
      const container = segments.pop() as string;
      const host = segments.join(":");
      binds.push({ host, container, readOnly });
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

  const devices: DeviceNodeSpec[] = [];
  if (Array.isArray(rawDevices)) {
    for (const entry of rawDevices) {
      if (!entry || typeof entry !== "object") continue;
      const pathOnHost = entry["PathOnHost"];
      if (typeof pathOnHost !== "string" || pathOnHost === "") continue;
      const pathInContainer = entry["PathInContainer"];
      const cgroupPermissions = entry["CgroupPermissions"];
      devices.push({
        pathOnHost,
        pathInContainer:
          typeof pathInContainer === "string" && pathInContainer !== ""
            ? pathInContainer
            : pathOnHost,
        cgroupPermissions:
          typeof cgroupPermissions === "string" ? cgroupPermissions : "",
      });
    }
  }

  const deviceCgroupRules = Array.isArray(rawDeviceCgroupRules)
    ? rawDeviceCgroupRules.filter((r): r is string => typeof r === "string")
    : [];

  const groupAdd = Array.isArray(rawGroupAdd)
    ? rawGroupAdd.filter((g): g is string => typeof g === "string")
    : [];

  const labels: Record<string, string> = {};
  if (config.Labels && typeof config.Labels === "object") {
    for (const [key, value] of Object.entries(config.Labels)) {
      if (typeof value === "string") labels[key] = value;
    }
  }

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
    devices,
    deviceCgroupRules,
    groupAdd,
    labels,
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

/**
 * A `container:<id>` network mode shares another container's netns. Docker
 * rejects ExtraHosts in that mode ("conflicting options: custom host-to-IP
 * mapping and the network mode"), so the host-gateway injection and its
 * drift mirror must both skip it.
 */
function sharesContainerNetns(mode: string | undefined): boolean {
  return (mode ?? "").startsWith("container:");
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
 * Canonical, order-independent form of a device-node list for
 * comparison. Permissions letters are sorted and an empty permissions
 * string (Podman omits it) is treated as the `rwm` default, so the
 * expanded emission of `"/dev/x"` compares equal to a live
 * `{PathOnHost: "/dev/x", PathInContainer: "/dev/x", CgroupPermissions: ""}`.
 */
function canonicalDeviceKeys(devices: DeviceNodeSpec[]): string[] {
  return devices
    .map((d) => {
      const perms = [...(d.cgroupPermissions || "rwm")].sort().join("");
      return `${d.pathOnHost}:${d.pathInContainer}:${perms}`;
    })
    .sort();
}

function sortedStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Compare a requested `ContainerConfig` against the live container's
 * effective config and return the list of fields that have drifted.
 *
 * Pure function over its inputs plus the injectable host probes in
 * `devices.ts` (device stats and `/etc/group`, needed because the
 * emission being mirrored is host-state-dependent; configs without
 * `devices`/`groupAdd` never touch them). The caller (`ensureRunning`)
 * decides what to do with a non-empty drift list (today: log + remove +
 * recreate).
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
 *   - devices: compared post-transformation — what `buildCreateOptions`
 *     would emit for the requested entries on this host vs live state —
 *     so an unchanged config never false-drifts across entry-syntax
 *     variants. Directory entries compare through their bind mounts (the
 *     `volumes` axis, on both runtimes). Node entries and cgroup rules
 *     live-compare on docker only: Podman applies `HostConfig.Devices` /
 *     `DeviceCgroupRules` but reports neither back through inspect
 *     (verified live on 5.4.2), so there they compare against `prior`
 *     when available — same fallback shape as the env/command
 *     prior-unset pattern.
 *   - groupAdd: expected emission (host-resolved GIDs) compared against
 *     live `HostConfig.GroupAdd` as a sorted set; both runtimes report
 *     it, so unsetting is detected without `prior`. The rootless-podman
 *     keep-original-groups annotation is emission-only and never
 *     compared.
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

  // Resolve the requested devices to the same emission buildCreateOptions
  // would produce, so both the volumes mirror below and the devices
  // comparison diff post-transformation shapes. Warnings stay silent here
  // — buildCreateOptions already reported any skip at create time.
  //
  // Entries the live container records as unresolved (the real host
  // rejected the optimistic bind at create time — DEVICES_UNRESOLVED_LABEL)
  // are excluded from BOTH the requested and prior emissions while the
  // manager still cannot see the path; otherwise every reconcile would
  // flag drift over a bind the host can never satisfy and recreate-loop.
  // The same filter applies to `prior` so the podman fallback comparison
  // below stays symmetric.
  const unresolvedDevices = parseUnresolvedDevicesLabel(
    live.labels[DEVICES_UNRESOLVED_LABEL],
  );
  const requestedDevices = resolveDeviceRequests(
    filterUnresolvedDeviceEntries(requested.devices ?? [], unresolvedDevices),
    runtime,
  );

  // Volumes: build canonical Map<containerPath, hostPath> for each side.
  // Keyed by container path; the value pairs host path with access mode.
  // Kept as separate fields rather than a `host:ro` string, which would make a
  // read-write mount of `/data:ro` indistinguishable from a read-only `/data`.
  const requestedVolumes = new Map<string, { host: string; readOnly: boolean }>();
  if (requested.volumes) {
    for (const [containerPath, raw] of Object.entries(requested.volumes)) {
      requestedVolumes.set(stripTrailingSlash(containerPath), {
        host: stripTrailingSlash(volumeSource(raw)),
        readOnly: typeof raw === "string" ? false : (raw.readOnly ?? false),
      });
    }
  }
  // Hot-plug device directories are emitted as binds, so the live Binds
  // include them; mirror them into the requested side or every reconcile
  // of a directory-device config would flag volumes drift.
  for (const bind of requestedDevices.directoryBinds) {
    requestedVolumes.set(stripTrailingSlash(bind.pathInContainer), {
      host: stripTrailingSlash(bind.pathOnHost),
      readOnly: false,
    });
  }
  const liveVolumes = new Map<string, { host: string; readOnly: boolean }>();
  for (const { host, container, readOnly } of live.binds) {
    liveVolumes.set(stripTrailingSlash(container), {
      host: stripTrailingSlash(host),
      readOnly: readOnly === true,
    });
  }
  let volumesDrift = requestedVolumes.size !== liveVolumes.size;
  if (!volumesDrift) {
    for (const [container, want] of requestedVolumes) {
      const have = liveVolumes.get(container);
      if (!have || have.host !== want.host || have.readOnly !== want.readOnly) {
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
  // same key, and never under a `container:` network mode where the
  // injection is skipped (Docker rejects the combination).
  if (
    runtime.runtime === "docker" &&
    !requestedExtraHosts.has("host.containers.internal") &&
    !sharesContainerNetns(requested.networkMode)
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

  // Devices: node entries + cgroup rules. Docker reports both through
  // inspect, so compare the expected emission against live. Podman
  // applies them but reports Devices as [] and rules as null (verified
  // live on 5.4.2 — even for CLI-created --device containers), so a live
  // comparison there would recreate on every reconcile; fall back to
  // comparing the requested emission against the prior config's, which
  // catches add/remove/change and unset within a server lifetime. The
  // directory-bind half of a device entry is runtime-visible on both
  // engines and already flows through the volumes comparison above.
  let devicesDrift = false;
  if (runtime.runtime === "docker") {
    // Live node devices whose host path is currently absent (device
    // unplugged since create) are dropped before the comparison so an
    // unplug never registers as drift and recreates the container — the
    // requested side already omits missing nodes via resolveDeviceRequests,
    // and this restores that symmetry on the live side (the podman branch
    // has it for free, both its sides being host-probed).
    devicesDrift =
      !sortedStringArraysEqual(
        canonicalDeviceKeys(requestedDevices.nodes),
        canonicalDeviceKeys(presentLiveDeviceNodes(live.devices)),
      ) ||
      !sortedStringArraysEqual(
        requestedDevices.cgroupRules,
        live.deviceCgroupRules,
      );
  } else if (prior !== undefined) {
    const priorDevices = resolveDeviceRequests(
      filterUnresolvedDeviceEntries(prior.devices ?? [], unresolvedDevices),
      runtime,
    );
    devicesDrift =
      !sortedStringArraysEqual(
        canonicalDeviceKeys(requestedDevices.nodes),
        canonicalDeviceKeys(priorDevices.nodes),
      ) ||
      !sortedStringArraysEqual(
        requestedDevices.cgroupRules,
        priorDevices.cgroupRules,
      );
  }
  if (devicesDrift) drifted.push("devices");

  // GroupAdd: expected emission (host-resolved GIDs) vs live, as sorted
  // sets. Both runtimes report HostConfig.GroupAdd (docker: null when
  // unset, podman: []), and nothing else populates it, so a symmetric
  // comparison detects unsetting without needing `prior`. Names the host
  // can't resolve are skipped on both sides of the transform (silently
  // here; buildCreateOptions warned at create time), so they can't loop.
  const expectedGroupAdd = requested.groupAdd?.length
    ? resolveGroupAdd(requested.groupAdd)
    : [];
  if (!sortedStringArraysEqual(expectedGroupAdd, live.groupAdd)) {
    drifted.push("groupAdd");
  }

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
    try {
      return (
        parseProcLimitsNofile(readFileSync("/proc/self/limits", "utf8"))
          ?.hard ?? null
      );
    } catch {
      return null;
    }
  }
  return read("/proc/sys/fs/nr_open");
}

/**
 * Parse the `Max open files` row out of a `/proc/<pid>/limits` file:
 * `Max open files   <soft>   <hard>   files`. Returns null on any shape
 * surprise — callers treat null as "unknown", never as a limit.
 */
export function parseProcLimitsNofile(content: string): NofileLimits | null {
  const line = content.split("\n").find((l) => l.startsWith("Max open files"));
  if (!line) return null;
  const toLimit = (raw: string | undefined): number | null => {
    if (raw === "unlimited") return Infinity;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const cols = line.trim().split(/\s+/);
  const soft = toLimit(cols[3]);
  const hard = toLimit(cols[4]);
  return soft !== null && hard !== null ? { soft, hard } : null;
}

// Injection seam for tests: the /proc/<pid>/limits reader used by
// readContainerNofile. Production always uses readFileSync.
let procLimitsReader: (path: string) => string = (p) => readFileSync(p, "utf8");
export function _setProcLimitsReaderForTesting(
  fn: ((path: string) => string) | null,
): void {
  procLimitsReader = fn ?? ((p) => readFileSync(p, "utf8"));
}

// Injection seam for tests: the host nofile ceiling probe used by the
// create-time clamp and the regrant check. Production always uses
// readNofileHardCeiling (real /proc reads), which tests can't control.
let nofileCeilingFn: (runtime: ContainerRuntimeInfo) => number | null =
  readNofileHardCeiling;
export function _setNofileCeilingForTesting(
  fn: ((runtime: ContainerRuntimeInfo) => number | null) | null,
): void {
  nofileCeilingFn = fn ?? readNofileHardCeiling;
}

/**
 * The two nofile observations a container inspect yields: `live` is the
 * kernel's truth from `/proc/<pid>/limits` (readable when the Signal K
 * process shares the pid namespace and uid with the container's — the
 * bare-metal + rootless-Podman deployment); `asked` is the create-time
 * request the runtime echoes back through `HostConfig.Ulimits`. They
 * differ when the runtime silently granted less than it was asked for
 * (e.g. a daemon whose own unit limit caps what it can hand out).
 */
interface ContainerNofileState {
  live: NofileLimits | null;
  asked: NofileLimits | null;
}

async function readContainerNofileState(
  name: string,
  client: ContainerClient,
): Promise<ContainerNofileState | null> {
  const inspect = (await safeInspect(() =>
    client.getContainer(prefixedName(name)).inspect(),
  )) as {
    State?: { Running?: boolean; Pid?: number };
    HostConfig?: {
      Ulimits?: { Name?: string; Soft?: number; Hard?: number }[] | null;
    };
  } | null;
  if (!inspect) return null;

  let live: NofileLimits | null = null;
  const pid = inspect.State?.Running ? inspect.State?.Pid : undefined;
  if (typeof pid === "number" && pid > 0) {
    try {
      live = parseProcLimitsNofile(procLimitsReader(`/proc/${pid}/limits`));
    } catch {
      // unreadable (different pidns/uid) — the inspect echo remains
    }
  }

  let asked: NofileLimits | null = null;
  for (const entry of inspect.HostConfig?.Ulimits ?? []) {
    // podman's libpod shape spells it RLIMIT_NOFILE; docker/compat use nofile.
    const entryName = entry.Name?.toLowerCase().replace(/^rlimit_/, "");
    if (
      entryName === "nofile" &&
      typeof entry.Soft === "number" &&
      typeof entry.Hard === "number"
    ) {
      asked = { soft: entry.Soft, hard: entry.Hard };
      break;
    }
  }
  return { live, asked };
}

/**
 * Read the nofile limits a managed container is ACTUALLY running with —
 * as opposed to the value that was requested when it was created.
 *
 * Primary source is the live `/proc/<container-pid>/limits`; where that
 * is not readable (containerized Signal K, rootful runtimes), fall back
 * to the create-time request echoed through inspect, which the runtime
 * applied verbatim or refused, so it equals the live value whenever it
 * is present. Null means "unknown": no such container, or neither
 * source available.
 */
export async function readContainerNofile(
  name: string,
  client: ContainerClient = getClient(),
): Promise<NofileLimits | null> {
  const state = await readContainerNofileState(name, client);
  return state ? (state.live ?? state.asked) : null;
}

/** The hard nofile limit a `ContainerConfig.ulimits` request asks for, if any. */
function requestedNofileHard(
  ulimits: ContainerConfig["ulimits"],
): number | null {
  const nofile = ulimits?.["nofile"];
  if (nofile === undefined) return null;
  return typeof nofile === "number" ? nofile : nofile.hard;
}

// The live nofile hard limit observed the last time a regrant recreate was
// attempted, per (prefixed) container name. Rootless podman < 5.5.0 ignores
// the compat API's ulimit request entirely (containers/podman#25881, fixed
// by #25908) and echoes the EFFECTIVE limits back through inspect — there
// the asked-vs-grantable comparison cannot detect that a recreate already
// failed to lift the limit, so without this guard a host whose Signal K
// process carries a higher limit than its podman service would recreate the
// container on every ensureRunning. Value-keyed on the observed limit: a
// retry unlocks by itself as soon as the observed limit actually changes
// (e.g. the operator raised the podman service's limit and the next
// recreate would inherit it). In-memory by design — at worst one recreate
// attempt per Signal K process lifetime per observed value.
const nofileRegrantAttempts = new Map<string, number>();
export function _clearNofileRegrantAttemptsForTesting(): void {
  nofileRegrantAttempts.clear();
}

// Names announced as wedged (drift recreate deferred because the container
// is unkillable — orphaned rootless userns). Fired once per wedge so the
// operator gets one actionable error instead of a per-reconcile drift loop;
// self-clears when the container is recovered: a reconcile that finds no
// drift, a successful in-process recreate, or the container going missing
// (e.g. the operator ran `<runtime> rm -f`) each delete the name (see the
// three `announcedWedged.delete` sites). In-memory by design — a fresh
// Signal K process re-announces once.
const announcedWedged = new Set<string>();
export function _clearAnnouncedWedgedForTesting(): void {
  announcedWedged.clear();
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
  onClamp: (event: UlimitClamp) => void = () => {},
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
        volumeArg(
          volumeSource(raw),
          containerPath,
          runtime,
          typeof raw === "string" ? false : (raw.readOnly ?? false),
        ),
      );
    }
  }

  // Host devices. Node entries land in HostConfig.Devices; directory
  // entries (hot-plug mode) are bind-mounted via deviceBindArg (which
  // omits the podman `:Z` relabel — see there) and opened up via
  // per-class DeviceCgroupRules. Rules are empty under rootless runtimes
  // (see resolveDeviceRequests). Entries whose host path is missing
  // (device unplugged) were skipped with a warning.
  if (config.devices?.length) {
    const resolved = resolveDeviceRequests(config.devices, runtime, debug);
    if (resolved.nodes.length > 0) {
      const mappings: Docker.DeviceMapping[] = resolved.nodes.map((n) => ({
        PathOnHost: n.pathOnHost,
        PathInContainer: n.pathInContainer,
        CgroupPermissions: n.cgroupPermissions,
      }));
      hostConfig.Devices = mappings;
    }
    if (resolved.cgroupRules.length > 0) {
      hostConfig.DeviceCgroupRules = resolved.cgroupRules;
    }
    if (resolved.directoryBinds.length > 0) {
      hostConfig.Binds = [
        ...(hostConfig.Binds ?? []),
        ...resolved.directoryBinds.map((b) =>
          deviceBindArg(b.pathOnHost, b.pathInContainer),
        ),
      ];
    }
  }

  // Supplementary groups, host-resolved to numeric GIDs (see
  // resolveGroupAdd for why group names must never reach the runtime).
  // Under rootless podman the GIDs alone map into the userns subordinate
  // range, so the keep-original-groups annotation additionally carries
  // the host user's own supplementary groups into the container — the
  // half that actually grants device-node access there. Docker never
  // receives the annotation (crun-specific; dockerode's HostConfig
  // typing predates the field, hence the cast).
  if (config.groupAdd?.length) {
    const groups = resolveGroupAdd(config.groupAdd, debug);
    if (groups.length > 0) hostConfig.GroupAdd = groups;
    if (runtime.runtime === "podman" && runtime.isRootless === true) {
      (
        hostConfig as Docker.HostConfig & {
          Annotations?: Record<string, string>;
        }
      ).Annotations = { [KEEP_ORIGINAL_GROUPS_ANNOTATION]: "1" };
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
  // entries and the implicit first-match-wins override, and under a
  // `container:` network mode, which Docker rejects in combination
  // with ExtraHosts.
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
  if (
    runtime.runtime === "docker" &&
    !userHasInternalOverride &&
    !sharesContainerNetns(config.networkMode)
  ) {
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
    nofileCeilingFn(runtime),
    (requested, granted) => {
      const reason =
        `nofile ulimit ${requested} exceeds this host's hard limit; clamped to ${granted}. ` +
        `Raise the limit for the user running the container runtime to use a higher value.`;
      debug(reason);
      onClamp({ ulimit: "nofile", requested, granted, reason });
    },
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
  //
  // The requested-resources provenance label records what the consumer
  // asked for at create time — read back by getRequestedResources()
  // when a fresh server process has no in-memory provenance, so a
  // runtime-injected limit (rootless podman clamps a child's
  // oom_score_adj up to its parent's) is never misread as a user
  // unset. Stamped after the consumer labels so it can't be shadowed.
  options.Labels = {
    ...config.labels,
    [requestedResourcesLabel()]: JSON.stringify(config.resources ?? {}),
  };

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

  options?: EnsureRunningOptions,
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
  const fullName = prefixedName(name);
  let state: ContainerState;
  try {
    state = await getContainerState(runtime, name, client);
  } catch (err) {
    if (_postRecreate || !isStorageCorruptError(err)) throw err;
    // Storage corruption (issue #219): inspect 500s but force-remove still
    // works, and managed containers keep their state in bind mounts, so
    // remove + recreate is the recovery. Bounded: if removal or the re-read
    // fails we throw, and the _postRecreate re-entry never retries.
    debug(
      `Container ${fullName} has corrupt storage (${describeError(err)}); removing and recreating`,
    );
    try {
      await removeContainer(runtime, name, client);
      state = await getContainerState(runtime, name, client);
    } catch (recoveryErr) {
      throw new Error(
        `Container ${fullName} has corrupt storage and automatic recovery failed. ` +
          `Remove it manually (\`${runtime.runtime} rm -f ${fullName}\`)` +
          (runtime.runtime === "podman"
            ? " or repair the store (`podman system check --repair --force`)"
            : "") +
          ` and retry. Underlying error: ${describeError(recoveryErr)}`,
        { cause: recoveryErr },
      );
    }
  }
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
    // Re-announce device entries the live container records as
    // unresolved (host rejected them at create time). The label is the
    // durable record — re-firing here keeps operator surfaces (doctor)
    // populated across Signal K restarts, when the create-time events
    // are long gone. The original entry string wasn't recorded, so the
    // host path stands in for it.
    for (const hostPath of parseUnresolvedDevicesLabel(
      live.labels[DEVICES_UNRESOLVED_LABEL],
    )) {
      safeInvokeDeviceIssue(
        options?.onDeviceIssue,
        {
          entry: hostPath,
          hostPath,
          action: "unresolved",
          reason:
            `Device ${hostPath} was missing on the host when ${fullName} ` +
            `was created; the container runs without it. The entry is ` +
            `retried on the next recreate.`,
        },
        (err) =>
          debug(
            `ensureRunning(${name}): onDeviceIssue handler threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      );
    }
    // Re-announce unresolvable groupAdd names too, so a group-skip stays
    // visible in the doctor across Signal K restarts — the same durability
    // the device-unresolved block above gives host-path skips. No label is
    // needed here: config.groupAdd is present on every call, so re-probing
    // it against the current host /etc/group is the durable record (and it
    // self-clears the moment the group is created on the host).
    if (config.groupAdd?.length) {
      for (const groupName of unresolvedGroupNames(config.groupAdd)) {
        safeInvokeDeviceIssue(
          options?.onDeviceIssue,
          {
            entry: groupName,
            hostPath: "",
            action: "group-skipped",
            reason:
              `groupAdd "${groupName}" has no matching group in the host's ` +
              `/etc/group; ${fullName} runs without it.`,
          },
          (err) =>
            debug(
              `ensureRunning(${name}): onDeviceIssue handler threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
        );
      }
    }
    const { drifted } = diffContainerConfig(config, live, runtime, prior);
    if (drifted.length === 0) {
      // No drift to apply: if this container was previously announced as
      // wedged, it has recovered on its own (e.g. the operator ran
      // `<runtime> system migrate`), so re-arm the one-shot advisory.
      announcedWedged.delete(name);
      return false;
    }
    debug(
      `Container ${fullName} config drift detected (${drifted.join(", ")}); recreating`,
    );
    return recreateUnlessWedged(drifted.join(", "));
  };

  // Remove + recreate the container to apply a detected drift — but if removal
  // fails because the container is wedged unkillable in `Stopping` (the
  // rootless "sending SIGKILL … operation not permitted" condition) AND it is
  // still running, keep it and defer the recreate to the next start rather than
  // failing startup. Returns true if recreated, false if deferred. Shared by
  // the config-drift and digest-drift paths so both survive the wedge.
  const recreateUnlessWedged = async (driftDesc: string): Promise<boolean> => {
    try {
      await removeContainer(runtime, name, client);
    } catch (err) {
      if (
        err instanceof ContainerRemovalError &&
        err.kind === "permission" &&
        (await getContainerState(runtime, name, client)) === "running"
      ) {
        debug(
          `Container ${fullName} could not be removed to apply drift ` +
            `(${driftDesc}) — it is still running; keeping it and deferring ` +
            `the recreate. ${err.message}`,
        );
        // Announce the wedge once. This is not the ordinary "still shutting
        // down, try next reconcile" case — the runtime refused to stop or
        // remove a still-running container. `kind === "permission"` covers
        // "operation not permitted" (EPERM) and "permission denied" (EACCES),
        // and the orphaned-user-namespace diagnosis is specific to rootless
        // Podman — on Docker or rootful Podman an EPERM on remove is not a
        // pause-session wedge and `podman system migrate` would not apply. So
        // give the userns remedy only for a rootless-Podman EPERM; otherwise a
        // generic permission remedy that echoes the runtime's own message.
        // Either way it needs operator action no API call can perform, so
        // announce once instead of looping the drift log silently.
        if (!announcedWedged.has(name)) {
          announcedWedged.add(name);
          const raw = err.message.toLowerCase();
          const isUsernsWedge =
            runtime.runtime === "podman" &&
            runtime.isRootless === true &&
            (raw.includes("operation not permitted") || raw.includes("eperm"));
          // Data-safety reassurance only when it is actually true: a force-
          // remove + recreate keeps host bind mounts (and named volumes), but
          // NOT the container's writable layer. Add the note only when this
          // container has at least one host-path mount (source starts with
          // "/"), which the managed database containers that wedge in practice
          // always do.
          const hasBindMount = Object.values(config.volumes ?? {}).some((v) => {
            const source = typeof v === "string" ? v : v.source;
            // A host path (absolute or explicitly relative) is a bind mount; a
            // bare name is a named volume. Both survive a recreate, but only a
            // bind mount is what the managed database containers use.
            return source.startsWith("/") || source.startsWith(".");
          });
          const dataNote = hasBindMount
            ? ` Recorded data is safe — it lives in a host bind mount, which removing and recreating the container does not touch.`
            : ``;
          const reason = isUsernsWedge
            ? `Container ${fullName} is wedged: the ${runtime.runtime} runtime ` +
              `cannot stop or remove it (operation not permitted), so the ` +
              `${driftDesc} change cannot be applied. This is usually an orphaned ` +
              `rootless user namespace after a ${runtime.runtime} service restart. ` +
              `Recover with '${runtime.runtime} system migrate' (or kill the ` +
              `container's conmon and child processes, then '${runtime.runtime} ` +
              `rm -f ${fullName}'), then restart the plugin.${dataNote}`
            : `Container ${fullName} could not be stopped or removed to apply the ` +
              `${driftDesc} change (${err.message}). A mount the removal touches — ` +
              `or the ${runtime.runtime} API socket — is not writable by this user. ` +
              `Fix the permissions, then remove the container ` +
              `('${runtime.runtime} rm -f ${fullName}') and restart the plugin.${dataNote}`;
          safeInvokeContainerWedged(
            options?.onContainerWedged,
            { name, drift: driftDesc, reason },
            (cbErr) =>
              debug(
                `ensureRunning(${name}): onContainerWedged handler threw: ${
                  cbErr instanceof Error ? cbErr.message : String(cbErr)
                }`,
              ),
          );
        }
        return false;
      }
      throw err;
    }
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
    // Recreate succeeded — the wedge (if any) is cleared, so re-arm the
    // one-shot advisory for a future one.
    announcedWedged.delete(name);
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
    return recreateUnlessWedged(
      `digest ${liveId.slice(0, 19)}… → ${remoteId.slice(0, 19)}…`,
    );
  };

  // Emit the still-capped advisory so consumers keep showing the true live
  // state; `granted` is the limit the container actually runs with.
  const adviseNofileCapped = (grantedHard: number, requestedHard: number) =>
    safeInvokeUlimitClamped(
      options?.onUlimitClamped,
      {
        ulimit: "nofile",
        requested: requestedHard,
        granted: grantedHard,
        reason:
          `${fullName} is running with a nofile limit of ${grantedHard}, ` +
          `below the requested ${requestedHard}, and a recreate cannot ` +
          `currently do better. Raise the limit of the host service that ` +
          `runs the containers to lift it.`,
      },
      (err) =>
        debug(
          `ensureRunning(${name}): onUlimitClamped handler threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
    );

  // ulimits sit outside drift detection (changing one doesn't justify the
  // recreate downtime), which leaves one gap: after an operator raises the
  // host nofile ceiling, the existing container keeps the lower limit it was
  // created with forever — a restart re-applies the stored value. Close the
  // gap here: when the host would now ask for MORE nofile than the previous
  // create asked, recreate to apply it (completing the documented "raise the
  // host limit" fix without manual container surgery). When it can't do
  // better, re-emit the clamp advisory so consumers reflect the live capped
  // state across Signal K restarts — the create-time event alone would
  // vanish on the next plugin start while the container stayed capped. A
  // null probe means "unknown", never capped: no recreate, no advisory.
  const checkNofileRegrant = async (): Promise<boolean> => {
    const requestedHard = requestedNofileHard(config.ulimits);
    if (requestedHard === null) return false;
    const state = await readContainerNofileState(name, client);
    const live = state ? (state.live ?? state.asked) : null;
    if (!state || !live) return false;
    const ceiling = nofileCeilingFn(runtime);
    const grantable =
      ceiling !== null && Number.isFinite(ceiling)
        ? Math.min(requestedHard, ceiling)
        : requestedHard;
    // Compare against what the previous create ASKED for, not what the
    // container got: a recreate re-asks with `grantable`, so it can only
    // improve on a smaller previous ask. When the runtime granted less
    // than asked (a daemon whose own unit limit caps what it hands out —
    // asking again cannot help), recreating would thrash the container on
    // every ensureRunning without ever lifting the limit.
    const asked = state.asked ?? live;
    if (
      grantable > asked.hard &&
      nofileRegrantAttempts.get(fullName) !== live.hard
    ) {
      nofileRegrantAttempts.set(fullName, live.hard);
      debug(
        `Container ${fullName} was created asking nofile ${asked.hard} but ` +
          `the host now grants ${grantable}; recreating to apply it`,
      );
      if (await recreateUnlessWedged(`nofile ${asked.hard} → ${grantable}`)) {
        // Verify the recreate actually lifted the limit. On rootless podman
        // < 5.5.0 the re-ask is dropped like the original ask (see
        // nofileRegrantAttempts), so a skewed host — Signal K process limit
        // above the podman service's — recreates once and lands back on the
        // old value. Without this post-check that session would show no
        // advisory at all: the create emits no clamp (the ceiling looks
        // fine) and this path returned before the still-capped check below.
        // Best-effort telemetry: the recreate itself succeeded, so a probe
        // failure here must degrade to "no advisory", never fail the start.
        // A container that landed exactly on `grantable` got what the create
        // asked after clamping — the create-time clamp event (if any) already
        // reported that value, so advising again would duplicate it. A
        // container that landed anywhere else (a runtime that dropped the
        // ask) makes the create-time event wrong, and this advisory is the
        // correction.
        try {
          const after = await readContainerNofileState(name, client);
          const afterLive = after ? (after.live ?? after.asked) : null;
          if (
            afterLive &&
            // A null echo is the rejection-fallback container (created
            // without the ask): its recursive ensureRunning already advised
            // the rejection with the remove-and-restart remediation, and a
            // second, weaker advisory would overwrite it in last-event-wins
            // consumers. Every dropped-ask shape (podman <5.5) carries an
            // echo, so those still get their correction here.
            after?.asked != null &&
            requestedHard > afterLive.hard &&
            afterLive.hard !== grantable
          ) {
            adviseNofileCapped(afterLive.hard, requestedHard);
          }
        } catch (err) {
          debug(
            `ensureRunning(${name}): post-regrant nofile verify failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return true;
      }
      // Wedged — kept running on the old limit; fall through to advise.
    }
    if (requestedHard > live.hard) {
      adviseNofileCapped(live.hard, requestedHard);
    }
    return false;
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
      if (await checkNofileRegrant()) return;
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
      if (await checkNofileRegrant()) return;
      debug(`Starting stopped container ${fullName}`);
      await startByFullName(client, fullName);
      return;
    }

    case "missing": {
      // A missing container cannot be wedged. If a prior wedge was announced
      // for this name and the operator recovered it the way the advisory
      // recommends (`<runtime> rm -f <name>`), the container is now gone and
      // about to be recreated fresh — re-arm so a future wedge on the reused
      // name is announced again. (The in-process recreate and no-drift paths
      // clear it too; this covers the externally-removed path.)
      announcedWedged.delete(name);
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
      const announceClamp = (event: UlimitClamp): void =>
        safeInvokeUlimitClamped(options?.onUlimitClamped, event, (err) =>
          debug(
            `ensureRunning(${name}): onUlimitClamped handler threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      // The clamp advisory belongs to the first build only: fallback
      // retries rebuild the create options with the same (possibly
      // clamped) nofile ask, and announcing the identical clamp again on
      // every retry would duplicate consumer notifications.
      const buildOpts = (
        cfg: ContainerConfig,
        onClamp: (event: UlimitClamp) => void = announceClamp,
      ): Docker.ContainerCreateOptions =>
        buildCreateOptions(name, cfg, runtime, healthcheck, debug, onClamp);
      const fireDeviceIssue = (event: DeviceIssue): void =>
        safeInvokeDeviceIssue(options?.onDeviceIssue, event, (err) =>
          debug(
            `ensureRunning(${name}): onDeviceIssue handler threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      const createOpts = buildOpts(config);

      // Announce create-time device dispositions (skips + unverified
      // emissions). Same resolution buildCreateOptions just ran — the
      // injectable probe makes it deterministic across the two calls.
      const deviceIssues = config.devices?.length
        ? resolveDeviceRequests(config.devices, runtime).issues
        : [];
      for (const issue of deviceIssues) {
        fireDeviceIssue({
          entry: issue.entry,
          hostPath: issue.hostPath,
          action: issue.disposition,
          reason: issue.reason,
        });
      }

      // Announce groupAdd names the host could not resolve — the emitted
      // supplementary groups silently dropped them. Surfaced through the
      // same device-issue channel (action "group-skipped") so an operator
      // sees the misconfiguration instead of it living only in debug logs.
      if (config.groupAdd?.length) {
        for (const name of unresolvedGroupNames(config.groupAdd)) {
          fireDeviceIssue({
            entry: name,
            hostPath: "",
            action: "group-skipped",
            reason:
              `Skipping groupAdd "${name}": no such group in the host's ` +
              `/etc/group. ${fullName} starts without it.`,
          });
        }
      }

      let created = await createAndStart(client, createOpts);
      if (!created.ok && created.conflict) {
        // getContainerState reported "missing" because `inspect` failed,
        // but a container with this name still exists in a state inspect
        // cannot read (e.g. a corrupt storage layer after an unclean
        // shutdown). Remove the stale container and retry the create once.
        debug(
          `Container ${fullName} name conflict despite "missing" state; removing stale container and retrying`,
        );
        await removeContainer(runtime, name, client);
        created = await createAndStart(client, createOpts);
      }

      // Two start-time fallbacks share one retry loop because a create can
      // trip both — in either order — and every retry must carry ALL
      // concessions made so far: rebuilding a retry from the pristine
      // config would re-introduce a bind or an ask the runtime already
      // refused and turn a recoverable start into a failure. Termination:
      // each iteration either records a newly rejected device path
      // (bounded by the number of unverified entries) or drops the nofile
      // ask (at most once).
      //
      // Optimistic-device fallback: an unverified device bind (emitted
      // because a containerized manager cannot see the host path locally)
      // was rejected by the runtime — the path is missing on the REAL
      // host too. Retry without the rejected entries so a missing device
      // never prevents container start, and stamp the dropped host paths
      // into DEVICES_UNRESOLVED_LABEL so diffContainerConfig doesn't
      // recreate-loop over them.
      //
      // Ulimit-rejection fallback: the OCI runtime refused the nofile ask
      // at start (crun/runc setrlimit). Reaching here means the create-time
      // clamp could not see the real ceiling — the process that starts the
      // container is not one whose limits this manager can read (podman
      // machine on macOS: the limits live inside the VM; or a Signal K
      // process whose own limit exceeds the podman service's). Retry
      // without the nofile ask so the container runs on the runtime's
      // default limits instead of not at all, and advise the shortfall.
      //
      // Regrant coherence: the fallback container carries NO nofile entry in
      // its inspect echo, so checkNofileRegrant reads `asked` from the live
      // limit. Where the manager cannot read the container's /proc either
      // (macOS), both sources are null and the regrant never fires — no
      // recreate ping-pong. Where it can (bare-metal Linux with a skewed
      // Signal K limit), the regrant may attempt ONE recreate with the
      // original ask; that create fails the same way, re-enters this
      // fallback, and the per-observed-limit nofileRegrantAttempts guard
      // pins every later call to advisories only — the same one-bounce
      // bound the podman <5.5 dropped-ask shape relies on. No extra
      // attempt state is needed here.
      const unverified = deviceIssues.filter(
        (i) => i.disposition === "optimistic",
      );
      const unresolvedPaths: string[] = [];
      const requestedNofile = requestedNofileHard(config.ulimits);
      let droppedNofileAsk: number | null = null;
      const concededConfig = (): ContainerConfig => {
        let cfg = config;
        if (unresolvedPaths.length > 0) {
          cfg = {
            ...cfg,
            devices: filterUnresolvedDeviceEntries(
              cfg.devices ?? [],
              unresolvedPaths,
            ),
            labels: {
              ...cfg.labels,
              [DEVICES_UNRESOLVED_LABEL]: JSON.stringify(
                [...unresolvedPaths].sort(),
              ),
            },
          };
        }
        if (droppedNofileAsk !== null) {
          cfg = {
            ...cfg,
            ulimits: Object.fromEntries(
              Object.entries(cfg.ulimits ?? {}).filter(
                ([ulimitName]) => ulimitName !== "nofile",
              ),
            ),
          };
        }
        return cfg;
      };
      while (!created.ok) {
        const rawError = created.raw;
        const rejected = MISSING_HOST_PATH_RE.test(rawError)
          ? unverified.filter(
              (i) =>
                !unresolvedPaths.includes(i.hostPath) &&
                rawError.includes(i.hostPath),
            )
          : [];
        if (rejected.length > 0) {
          unresolvedPaths.push(...rejected.map((i) => i.hostPath));
          for (const issue of rejected) {
            const reason =
              `Device "${issue.entry}" does not exist on the host — the ` +
              `runtime rejected the container create. Starting ${fullName} ` +
              `without it; the entry is retried on the next recreate.`;
            debug(`ensureRunning(${name}): ${reason}`);
            fireDeviceIssue({
              entry: issue.entry,
              hostPath: issue.hostPath,
              action: "unresolved",
              reason,
            });
          }
        } else if (
          droppedNofileAsk === null &&
          requestedNofile !== null &&
          isUlimitRejectionText(rawError) &&
          NOFILE_REJECTION_RE.test(rawError)
        ) {
          debug(
            `ensureRunning(${name}): host rejected the nofile ulimit ` +
              `(${rawError}); retrying once without it`,
          );
          droppedNofileAsk = requestedNofile;
        } else {
          break;
        }
        // A failed start (podman resolves binds and applies rlimits at
        // start) leaves the created container behind; remove it before
        // the retry. removeContainer tolerates "already gone".
        await removeContainer(runtime, name, client);
        created = await createAndStart(
          client,
          buildOpts(concededConfig(), () => {}),
        );
      }

      if (created.ok && droppedNofileAsk !== null) {
        // Advise with the limit the container actually got; where no
        // source is readable (macOS) degrade to 0 = unknown rather than
        // fail a start that just succeeded.
        let grantedHard = 0;
        try {
          grantedHard = (await readContainerNofile(name, client))?.hard ?? 0;
        } catch {
          // unreadable — granted stays unknown
        }
        // The remediation must say remove AND restart: a bare Signal K
        // restart cannot re-grant on macOS — the regrant probe reads
        // neither the inspect echo (no nofile entry) nor the VM's /proc —
        // so removing the container is the only universal path back to
        // the full ask.
        const reason =
          `The container host rejected the requested nofile limit of ` +
          `${droppedNofileAsk}; ${fullName} now runs with the runtime's ` +
          `default limits instead. Raise the limits of the service that ` +
          `runs the container runtime (podman machine on macOS: inside ` +
          `the VM, via \`podman machine ssh\`), then remove the container ` +
          `(\`${runtime.runtime} rm -f ${fullName}\`) and restart Signal K ` +
          `so it is re-created with the requested value.`;
        debug(reason);
        safeInvokeUlimitClamped(
          options?.onUlimitClamped,
          {
            ulimit: "nofile",
            requested: droppedNofileAsk,
            granted: grantedHard,
            reason,
          },
          (err) =>
            debug(
              `ensureRunning(${name}): onUlimitClamped handler threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
        );
      }

      if (!created.ok) {
        // The result object carries `raw`, so it satisfies the cause shape
        // describeError reads — the full runtime text stays recoverable.
        throw new Error(
          `Failed to create ${fullName}: ${messageWithRaw(created.error, created.raw)}`,
          { cause: created },
        );
      }
      return;
    }
  }
}

/**
 * Runtime error text for a bind mount whose host source path is missing.
 * Podman (start phase): `statfs /dev/snd: no such file or directory`.
 * Docker (start phase): `invalid mount config for type "bind": bind
 * source path does not exist: /dev/snd`. The device-fallback path in
 * `ensureRunning` additionally requires the error to name the specific
 * unverified host path, so an unrelated missing-file error can't trigger
 * the fallback.
 */
const MISSING_HOST_PATH_RE = /no such file or directory|does not exist/i;

/**
 * Rejection texts name the limit they refused (crun spells it
 * `RLIMIT_NOFILE`, runc "rlimit type 7"). The fallback drops only the
 * nofile ask, so it must fire only on nofile evidence — dropping nofile
 * for a rejected memlock/nproc request would waste a doomed retry and
 * misattribute the failure in the debug log.
 */
const NOFILE_REJECTION_RE = /RLIMIT_NOFILE|rlimit type 7|nofile/i;

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
    throw new Error(
      `Failed to start ${fullName}: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
      { cause: result.error },
    );
  }
}

/**
 * Create + start a container from a create payload. Returns a discriminated
 * result so the caller can detect the name-conflict (409) case and retry
 * after removing the stale container. `raw` carries the runtime's original
 * error text — the device-fallback path in `ensureRunning` matches host
 * paths against it, which the sanitized `userMessage` may not preserve.
 */
async function createAndStart(
  client: ContainerClient,
  opts: Docker.ContainerCreateOptions,
): Promise<
  { ok: true } | { ok: false; conflict: boolean; error: string; raw: string }
> {
  const createResult = await safe(() => client.createContainer(opts));
  if (!createResult.ok) {
    // Only a genuine name collision warrants the stale-container remove+retry.
    // `not-found` and `invalid-config` (e.g. "conflicting options: port
    // publishing and the container type network mode", issue #183) are NOT name
    // collisions — the substring "conflict" lives inside "conflicting options",
    // so match on the whole "in use"/"409" phrasing, never a bare "conflict",
    // and never when the error was already categorized as a config rejection.
    const conflict =
      createResult.error.kind === "not-found" ||
      createResult.error.kind === "invalid-config"
        ? false
        : /already in use|name.*conflict|409/i.test(createResult.error.raw);
    return {
      ok: false,
      conflict,
      error: createResult.error.userMessage,
      raw: createResult.error.raw,
    };
  }
  const startResult = await safe(() => createResult.value.start());
  if (!startResult.ok) {
    return {
      ok: false,
      conflict: false,
      error: startResult.error.userMessage,
      raw: startResult.error.raw,
    };
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
        `Failed to stop ${fullName}: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
        { cause: result.error },
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
    // Surface the raw runtime error, not just the generic userMessage — a
    // hidden raw (e.g. podman's "sending SIGKILL … operation not permitted"
    // when a rootless container wedges in `Stopping`) is undiagnosable from
    // the report. Carry the kind so callers can react to a permission/wedge
    // failure (keep a healthy container running) vs hard-fail.
    throw new ContainerRemovalError(
      `Failed to remove ${fullName}: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
      result.error.kind,
      { cause: result.error },
    );
  }
}

/**
 * Thrown by `removeContainer` when the runtime refuses to remove a container.
 * Carries the classified `kind` so callers can distinguish a `permission`
 * failure (a rootless container wedged unkillable in `Stopping`) — where
 * keeping a healthy existing container beats failing startup — from other
 * removal failures that should propagate.
 */
export class ContainerRemovalError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContainerRemovalError";
  }
}

/**
 * Container path the wipe helper mounts the data directory at. Arbitrary —
 * the only requirement is that it not collide with image-baked paths the
 * helper's `rm` might depend on; a dedicated top-level dir avoids that.
 */
const WIPE_MOUNT = "/sk-wipe-target";

/** Posix error codes that signal "the host user can't delete this" and so
 * warrant the in-userns fallback rather than a hard failure. */
const OWNERSHIP_ERROR_CODES = new Set(["EACCES", "EPERM"]);

/** True for the EACCES/EPERM ownership errors that the in-userns wipe can fix.
 * Anything else (ENOENT, ENOTEMPTY from a live mount, …) is not an ownership
 * problem and should surface unchanged. */
function isOwnershipError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && OWNERSHIP_ERROR_CODES.has(code);
}

/**
 * Reject host paths that must never be recursively wiped. The guard is the
 * cheap, always-correct floor (empty / `/` / a non-absolute path); the
 * caller layers any deployment-specific "must be under the Signal K tree"
 * check on top, where it has the data/config roots to compare against.
 */
export function assertWipablePath(hostPath: string): void {
  // Require an absolute path: a relative value would `path.resolve` to a
  // cwd-relative dir and quietly pass the root check, risking an rm -rf of
  // the wrong tree. The data/config sources signalk-container deals with are
  // always absolute, so reject anything else outright. Normalize first so a
  // root-equivalent like `/..` collapses to the root and is rejected too.
  const normalized = path.normalize(hostPath || "");
  if (
    !hostPath ||
    hostPath.trim() === "" ||
    !path.isAbsolute(hostPath) ||
    normalized === path.parse(normalized).root
  ) {
    throw new Error(
      `removeManagedData: refusing to delete unsafe path ${JSON.stringify(hostPath)}`,
    );
  }
}

/**
 * Result of one wipe-job run, mirroring the bits of `ContainerJobResult`
 * that `removeManagedData` reasons about. Keeps `containers.ts` free of a
 * `jobs.ts` import (jobs.ts already imports from here — the cycle would be
 * real) while staying fully testable via an injected runner.
 */
export interface WipeJobOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Delete a managed container's bind-mount data, working around the
 * rootless-Podman subuid-ownership trap.
 *
 * Sequence:
 *   1. Remove the container `name` (idempotent — a missing container is fine)
 *      so nothing holds the mount.
 *   2. Try a direct host-side `fs.rm(hostPath, {recursive, force})`. On
 *      docker / rootful Podman the files are host-owned and this succeeds.
 *   3. On EACCES/EPERM (the rootless-Podman case — files are owned by a
 *      subuid the host user can't touch) run `runWipeJob`: a one-shot helper
 *      that bind-mounts `hostPath` and `rm -rf`s its CONTENTS from inside the
 *      userns as in-container root, then retry the host-side delete to drop
 *      the now-empty host-owned parent dir.
 *
 * `runWipeJob(image, hostPath)` is injected so the runtime logic stays out
 * of the `jobs.ts` import cycle and so unit tests can drive every branch
 * without a real runtime. The wrapper in `index.ts` wires it to `runJob`
 * with the container's own (already-present) image.
 *
 * `wipeImage` is the container's own image, captured from `inspect` BEFORE
 * removal so the helper reuses bits already on disk — no registry pull on a
 * possibly-offline boat. `null` when the container was already gone; the
 * fallback then can't run, so a still-undeletable dir surfaces as an error.
 */
export async function removeManagedData(
  runtime: ContainerRuntimeInfo,
  name: string,
  hostPath: string,
  runWipeJob: (image: string, hostPath: string) => Promise<WipeJobOutcome>,
  client: ContainerClient = getClient(),
  // Invoked exactly once, the instant the container is removed (before the data
  // delete). Lets the caller tear down container-scoped state (ports, log
  // broker) only when removal actually happened — not on a pre-removal failure
  // such as a non-404 inspect error, when the container is still running.
  onRemoved: () => void = () => {},
): Promise<void> {
  assertWipablePath(hostPath);

  // Capture the image before removal so the in-userns fallback can reuse it
  // (guaranteed present locally — the container was just running it).
  const fullName = prefixedName(name);
  const info = await safeInspect(() => client.getContainer(fullName).inspect());
  const wipeImage =
    typeof info?.Config?.Image === "string" ? info.Config.Image : null;

  await removeContainer(runtime, name, client);
  onRemoved();

  // Docker / rootful Podman: bind-mount files are host-owned, plain rm works.
  try {
    await rm(hostPath, { recursive: true, force: true });
    return;
  } catch (err) {
    if (!isOwnershipError(err)) throw err;
  }

  // Rootless-Podman subuid case: the host user can't delete subuid-owned
  // files. Wipe the dir contents from inside the userns (as in-container
  // root, which owns them) using the container's own image, then retry the
  // host-side delete to drop the now-empty host-owned parent.
  if (!wipeImage) {
    throw new Error(
      `removeManagedData: ${hostPath} is not deletable by the Signal K user ` +
        `and the container's image is unknown (it was already removed), so the ` +
        `in-userns cleanup helper cannot run. Delete ${hostPath} manually.`,
    );
  }

  const wipe = await runWipeJob(wipeImage, hostPath);
  if (!wipe.ok) {
    throw new Error(
      `removeManagedData: in-userns wipe of ${hostPath} failed: ${wipe.error ?? "unknown error"}`,
    );
  }

  try {
    await rm(hostPath, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(
      `removeManagedData: ${hostPath} still not removable after in-userns wipe (${code}). ` +
        `Delete it manually.`,
      { cause: err },
    );
  }
}

/**
 * Container path the wipe helper mounts the data directory at — re-exported
 * for the wrapper that builds the `runJob` config and for tests asserting the
 * mount/command shape.
 */
export const WIPE_MOUNT_PATH = WIPE_MOUNT;

export async function listContainers(
  runtime: ContainerRuntimeInfo,
  client: ContainerClient = getClient(),
): Promise<ContainerInfo[]> {
  const prefix = containerPrefix();
  const result = await safe(() =>
    client.listContainers({
      all: true,
      filters: { name: [prefix] },
    }),
  );
  if (!result.ok) return [];

  // The daemon `name` filter is a substring match, not a prefix match, so a
  // foreign container whose name merely *contains* the token (or another
  // namespace's container) can slip through. Anchor client-side so the
  // managed list only ever holds this namespace's containers.
  return result.value
    .filter((c) => (c.Names?.[0] ?? "").replace(/^\//, "").startsWith(prefix))
    .map((c) => {
      // dockerode `Names` carries a leading slash; strip it to match the
      // bare names the rest of the plugin uses.
      const name = (c.Names?.[0] ?? "").replace(/^\//, "");
      const state: ContainerState =
        c.State === "running" ? "running" : "stopped";
      const ports = (c.Ports ?? [])
        .map((p) =>
          p.PublicPort
            ? `${p.IP ?? "0.0.0.0"}:${p.PublicPort}->${p.PrivatePort}/${p.Type}`
            : `${p.PrivatePort}/${p.Type}`,
        )
        .filter(Boolean);
      return {
        name,
        // The filter above guarantees `name` starts with `prefix`.
        unprefixedName: name.slice(prefix.length),
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
    throw new Error(
      `Prune failed: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
      { cause: result.error },
    );
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
 * `getImage(id).remove` options for the reaper. `force: true` is needed
 * because a superseded image can still carry several tags (e.g. `0.6.6`
 * and `latest`); without it the daemon refuses to delete a multi-tagged
 * image by ID. It is safe here — the selector already excludes the
 * running image and anything in use by a container, so a forced removal
 * can only drop a genuinely superseded, unreferenced image. `noprune:
 * true` leaves the now-dangling parent layers for `pruneImages`, which
 * runs in the same scheduled tick.
 */
const REAPER_IMAGE_REMOVE_OPTS = { force: true, noprune: true } as const;

/**
 * Split a `registry/repo:tag` reference into its repo and tag. Returns
 * null when the string carries no tag (a bare repo) — the trailing
 * segment is only a tag when it contains no `/` (otherwise the colon
 * belongs to a `registry:port` host, not a tag).
 */
function splitRepoTag(repoTag: string): { repo: string; tag: string } | null {
  const colon = repoTag.lastIndexOf(":");
  if (colon === -1) return null;
  const tag = repoTag.slice(colon + 1);
  if (tag.includes("/")) return null;
  return { repo: repoTag.slice(0, colon), tag };
}

/**
 * Order two tags newest-first. Semver tags compare by version (so
 * `0.6.7` sorts ahead of `0.6.6`); a semver tag always sorts ahead of a
 * non-semver one (a real release is preferred for keeping over a stale
 * `latest`/date blob). Two non-semver tags are treated as equal here and
 * fall back to the image `created` tie-breaker in the caller.
 */
function compareTagsNewestFirst(a: string, b: string): number {
  const aSemver = classifyTag(a) === "semver";
  const bSemver = classifyTag(b) === "semver";
  if (aSemver && bSemver) return -compareVersions(a, b);
  if (aSemver) return -1;
  if (bSemver) return 1;
  return 0;
}

/**
 * The newest tag of an image for a given managed repo, used to order
 * that image against its siblings. Null when the image carries no tag
 * for the repo (shouldn't happen once bucketed, but keeps the ordering
 * total).
 */
function newestTagForRepo(
  image: LocalImageSummary,
  repo: string,
): string | null {
  let best: string | null = null;
  for (const repoTag of image.repoTags) {
    const split = splitRepoTag(repoTag);
    if (!split || split.repo !== repo) continue;
    if (best === null || compareTagsNewestFirst(split.tag, best) < 0) {
      best = split.tag;
    }
  }
  return best;
}

/**
 * Pure selection: given every local image, the managed repos with their
 * running image-IDs, and how many prior versions to keep, return the
 * de-duplicated image-IDs to remove.
 *
 * `managed[].image` must already be in the same qualified form the local
 * `repoTags` use (the executor qualifies via `qualifyImage` at the
 * boundary), so a bare Docker Hub repo and its `docker.io/`-prefixed
 * local tag compare equal.
 *
 * Guarantees, by construction:
 *   - unrelated images are never returned (an image is only considered
 *     under a repo it is actually tagged for, and only managed repos
 *     are walked);
 *   - the running image is never returned (excluded by image-ID);
 *   - an image in use by any container (running OR stopped) is never
 *     returned (excluded by `inUseCount`);
 *   - the newest `keepImageVersions` superseded versions per repo survive;
 *   - an image shared across managed repos survives if ANY repo retains
 *     it (reaping it for one would untag it from the others).
 */
export function selectImagesToReap(
  images: LocalImageSummary[],
  managed: ManagedImageRef[],
  keepImageVersions: number,
): string[] {
  const keep = Math.max(0, keepImageVersions);
  const runningIds = new Set(
    managed.map((m) => m.runningImageId).filter((id): id is string => !!id),
  );
  // A repo whose running image-ID we couldn't resolve (container missing,
  // inspect failed) has no anchor to reap against — keep every version of
  // it rather than risk removing the live one.
  const unanchoredRepos = new Set(
    managed.filter((m) => m.runningImageId === null).map((m) => m.image),
  );
  const toReap = new Set<string>();
  // An image tagged for more than one managed repo must survive if ANY
  // repo retains it — reaping it for one repo would untag it from the
  // others. Collect the "keep" decision across all repos first, then
  // subtract it from the reap set.
  const toKeep = new Set<string>();

  for (const repo of new Set(managed.map((m) => m.image))) {
    const candidates = images.filter(
      (img) =>
        img.inUseCount === 0 &&
        !runningIds.has(img.id) &&
        img.repoTags.some((rt) => splitRepoTag(rt)?.repo === repo),
    );

    // An unanchored repo (running image unresolved) keeps every version.
    // Add its images to `toKeep` rather than skipping the repo — a digest
    // shared with an anchored repo would otherwise be reaped for that
    // repo and, via `force` removal, untagged from this protected one.
    if (unanchoredRepos.has(repo)) {
      candidates.forEach((img) => toKeep.add(img.id));
      continue;
    }

    const ordered = [...candidates].sort((a, b) => {
      const tagOrder = compareTagsNewestFirst(
        newestTagForRepo(a, repo) ?? "",
        newestTagForRepo(b, repo) ?? "",
      );
      if (tagOrder !== 0) return tagOrder;
      return b.created - a.created;
    });

    ordered.slice(0, keep).forEach((img) => toKeep.add(img.id));
    ordered.slice(keep).forEach((img) => toReap.add(img.id));
  }

  return [...toReap].filter((id) => !toKeep.has(id));
}

/**
 * Remove superseded versions of managed-container images, keeping the
 * running one plus `keepImageVersions` prior versions per repo. The
 * selection is delegated to the pure `selectImagesToReap`; this layer
 * only does I/O (list, remove) and never throws — a listing failure or a
 * single stuck image must not abort the rest of the scheduled tick.
 */
export async function reapSupersededImages(
  runtime: ContainerRuntimeInfo,
  managed: ManagedImageRef[],
  keepImageVersions: number,
  client: ContainerClient = getClient(),
): Promise<PruneResult> {
  const listed = await safe(() => client.listImages());
  if (!listed.ok) return { imagesRemoved: 0, spaceReclaimed: "0b" };

  // The `Containers` field on a listImages summary is unreliable across
  // runtimes — Docker returns -1 ("not computed") by default, which would
  // make every image look in-use. Derive the in-use set authoritatively
  // from the container list instead (all containers, running or stopped);
  // each carries the resolved `ImageID` of the image it references. If the
  // container list can't be read, fall back to "every image is in use" so
  // the reaper errs toward keeping images rather than deleting a live one.
  const containers = await safe(() => client.listContainers({ all: true }));
  const inUseIds = containers.ok
    ? new Set(containers.value.map((c) => c.ImageID).filter(Boolean))
    : null;

  const summaries: LocalImageSummary[] = listed.value.map((info) => ({
    id: info.Id,
    repoTags: (info.RepoTags ?? []).filter((t) => t && t !== "<none>:<none>"),
    created: info.Created ?? 0,
    size: info.Size ?? 0,
    inUseCount: inUseIds === null || inUseIds.has(info.Id) ? 1 : 0,
  }));
  const bySize = new Map(summaries.map((s) => [s.id, s.size]));

  // Qualify each managed repo the way podman qualifies the local
  // `repoTags`, so the pure selector's string match lines up across
  // runtimes. `qualifiedRepoVariants` also covers records persisted in
  // the historical `docker.io/<name>` spelling of single-name Docker
  // Hub images (podman reports `docker.io/library/<name>`), emitting
  // both forms with the same runningImageId.
  const qualifiedManaged = managed.flatMap((m) =>
    qualifiedRepoVariants(m.image, runtime).map((image) => ({ ...m, image })),
  );

  const ids = selectImagesToReap(
    summaries,
    qualifiedManaged,
    keepImageVersions,
  );

  let removed = 0;
  let reclaimed = 0;
  for (const id of ids) {
    const result = await safe(() =>
      client.getImage(id).remove(REAPER_IMAGE_REMOVE_OPTS),
    );
    // A `not-found` means the image is already gone (a concurrent prune,
    // or another tag of it was removed first) — count it as reaped. Any
    // other error (e.g. a 409 from a race where it became in-use) skips
    // this id and leaves the rest of the sweep untouched.
    if (result.ok || result.error.kind === "not-found") {
      removed++;
      reclaimed += bySize.get(id) ?? 0;
    }
  }

  return { imagesRemoved: removed, spaceReclaimed: bytesToString(reclaimed) };
}

export interface PruneRunLogger {
  debug: (msg: string) => void;
  error: (msg: string, err: unknown) => void;
}

/**
 * One scheduled cleanup pass. Reaps superseded managed versions first:
 * that untags them, turning their parent layers dangling, so the prune
 * that follows reclaims those layers in the same pass rather than
 * leaving them until the next one. Each phase is isolated — collecting
 * managed refs can throw (manifest read, digest probe), and that must
 * not stop the dangling prune, which is the original, more important
 * cleanup. A failure in either phase is rethrown after both have run,
 * so the scheduler leaves the run unrecorded and retries it instead of
 * waiting out a full interval — both phases are idempotent.
 */
/**
 * Build the reaper's view of managed images: every container recorded in a
 * manifest, paired with the immutable image-ID it is currently running (or
 * null when that cannot be determined). A per-container probe failure (e.g.
 * corrupt storage making inspect 500 — issue #219) must not abort the whole
 * list: the ref is kept with `runningImageId: null`, which
 * `selectImagesToReap` treats as unanchored and keeps every version of that
 * image — fail-safe.
 */
export async function collectManagedImageRefs(
  runtime: ContainerRuntimeInfo,
  manifests: ReadonlyArray<{ containers: Record<string, { image: string }> }>,
  debug: (msg: string) => void,
  client: ContainerClient = getClient(),
): Promise<ManagedImageRef[]> {
  const refs: ManagedImageRef[] = [];
  for (const manifest of manifests) {
    for (const [containerName, entry] of Object.entries(manifest.containers)) {
      let runningImageId: string | null = null;
      try {
        // Inspect the container directly — going through getImageDigest
        // would try an image-name lookup first, so a local image tagged
        // with the container's name would shadow the container's .Image.
        const info = await safeInspect(() =>
          client.getContainer(prefixedName(containerName)).inspect(),
        );
        runningImageId = (info?.Image as string | undefined) ?? null;
      } catch (err) {
        debug(
          `Image reaper: cannot read the running image of ${prefixedName(containerName)} ` +
            `(${describeError(err)}); keeping all versions of ${entry.image} this run`,
        );
      }
      refs.push({ image: entry.image, runningImageId });
    }
  }
  return refs;
}

export async function runScheduledPrune(
  runtime: ContainerRuntimeInfo,
  collectManaged: () => Promise<ManagedImageRef[]>,
  keepImageVersions: number,
  log: PruneRunLogger,
  client: ContainerClient = getClient(),
): Promise<void> {
  let firstError: unknown = null;
  try {
    const managed = await collectManaged();
    const reaped = await reapSupersededImages(
      runtime,
      managed,
      keepImageVersions,
      client,
    );
    log.debug(
      `Reaped ${reaped.imagesRemoved} superseded managed images, reclaimed ${reaped.spaceReclaimed}`,
    );
  } catch (err) {
    log.error("Managed-image reaping failed:", err);
    firstError = err;
  }
  try {
    const result = await pruneImages(runtime, client);
    log.debug(
      `Pruned ${result.imagesRemoved} images, reclaimed ${result.spaceReclaimed}`,
    );
  } catch (err) {
    log.error("Auto-prune failed:", err);
    firstError ??= err;
  }
  if (firstError !== null) throw firstError;
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
      `Failed to create network ${name}: ${messageWithRaw(create.error.userMessage, create.error.raw)}`,
      { cause: create.error },
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
      `Failed to remove network ${name}: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
      { cause: result.error },
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
      `Failed to connect ${fullName} to ${networkName}: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
      { cause: result.error },
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
      `Failed to disconnect ${fullName} from ${networkName}: ${messageWithRaw(result.error.userMessage, result.error.raw)}`,
      { cause: result.error },
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
 * Can `existsSync(hostPath)` be trusted inside this container?
 *
 * The caller holds a HOST path and stats that same string locally, so the
 * mount has to make those two the same thing. Three conditions, and all are
 * load-bearing:
 *
 * - **Bind mounts only.** A named volume's contents are not the host
 *   filesystem at that path, so a file seen inside one proves nothing.
 * - **Path-preserving only** (`source === dest`). A bind of `/host/data` to
 *   `/data` puts the host's `/host/data` at `/data`; the string `/data` inside
 *   the container names `/host/data` on the host, and the host's own `/data`
 *   is not visible at all. Verified against a real runtime. Trusting such a
 *   mount would let `existsSync("/data/certs")` answer about
 *   `/host/data/certs` and report a nonexistent required source as present --
 *   exactly the `ifMissing: "abort"` failure this guards.
 * - **Exact-or-child.** A mount at `/data` covers `/data` and `/data/sub`,
 *   never `/database`.
 *
 * Factored out of `ownBindMountCoverage` so the rule is testable without a
 * runtime.
 */
export function isPathUnderBindMount(
  absPath: string,
  mounts: readonly InspectedMount[],
): boolean {
  return mounts.some(
    (m) =>
      m.type === "bind" &&
      m.source === m.dest &&
      (absPath === m.dest || absPath.startsWith(m.dest + "/")),
  );
}

/**
 * Host paths this container can see truthfully, as a predicate.
 *
 * A bind mount makes this container's view of a path the HOST's view at a
 * known offset, so `existsSync` under one is authoritative in both directions.
 * Anywhere else a containerized process is looking at a different filesystem
 * entirely, and neither answer means anything about the host.
 *
 * Returns a predicate rather than resolving one path so the inspect happens
 * ONCE per reconcile instead of once per volume. On bare metal, or when the
 * self-inspect fails, every path is covered / not covered respectively — the
 * caller decides what that means.
 */
export async function ownBindMountCoverage(
  runtime: ContainerRuntimeInfo,
  debug: (msg: string) => void = () => {},
  client: ContainerClient = getClient(),
): Promise<(absPath: string) => boolean> {
  if (!isContainerized()) return () => true;

  // Every failure below degrades to "covers nothing", never to a throw.
  // safeInspect rethrows anything that is not a 404, and findSelfContainerId
  // touches the runtime too; letting either escape would reject ensureRunning
  // outright on a transient daemon hiccup, when the tri-state classification
  // is designed to carry on with "unknown" instead.
  try {
    const selfId = await findSelfContainerId(runtime, debug, client);
    if (!selfId) {
      debug("ownBindMountCoverage: could not detect self container id");
      return () => false;
    }
    const info = await safeInspect(() => client.getContainer(selfId).inspect());
    if (info === null) {
      debug(`ownBindMountCoverage: inspect ${selfId} failed`);
      return () => false;
    }

    const mounts = mountsFromInspect(info);
    return (absPath: string) => isPathUnderBindMount(absPath, mounts);
  } catch (err) {
    debug(
      `ownBindMountCoverage: could not read own mounts (${
        err instanceof Error ? err.message : String(err)
      }); treating every path as unverifiable`,
    );
    return () => false;
  }
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
 *   - `null`    when running bare-metal, when the SignalK container itself
 *               uses `network_mode: host` (the host loopback IS SignalK's
 *               loopback, so published ports are directly reachable), or
 *               when self-container detection fails (`SIGNALK_CONTAINER_ID`
 *               unset, HOSTNAME unusable under `network_mode: host`, and
 *               `/proc/self/cgroup` not parseable).  Callers should treat
 *               this like bare-metal and publish ports instead.
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

  // A host-networked SignalK container shares the host netns, so ports
  // published on the host loopback are directly reachable — exactly the
  // bare-metal strategy. Falling through to the netns-join fallback
  // instead would put managed containers on the host network (and on
  // Docker the create is outright rejected because the injected
  // host-gateway ExtraHosts conflicts with `container:` network mode).
  if (info.HostConfig?.NetworkMode?.trim() === "host") {
    debug(
      `resolveSignalkNetworks: ${selfId} uses host networking — treating as bare-metal (publish ports on 127.0.0.1)`,
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
