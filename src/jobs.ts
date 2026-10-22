import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import {
  ContainerJobConfig,
  ContainerJobResult,
  ContainerRuntimeInfo,
  CleanupOrphansResult,
  OrphanJobInfo,
} from "./types.js";
import { userMappingFlags } from "./runtime.js";
import {
  jobPrefix,
  jobMarkerLabel,
  jobOwnerLabel,
  jobNameLabel,
} from "./namespace.js";
import { volumeArg, qualifyImage } from "./containers.js";
import { resourcePayloadForRun } from "./resources.js";
import {
  getClient,
  safe,
  safeInspect,
  type ContainerClient,
} from "./client.js";
import { describeError, messageWithRaw } from "./errors.js";

// `userMappingFlags` and the host-id test setter (`_setCurrentHostIdsForTesting`)
// live in `runtime.ts` so both `jobs.ts` (one-shot helpers) and
// `containers.ts` (long-running managed containers via `buildCreateOptions`)
// can share the same decision matrix without an import cycle.
export { userMappingFlags, _setCurrentHostIdsForTesting } from "./runtime.js";

const JOB_LOG_MAX_LINES = 200;
// A job that writes without newlines would otherwise grow the pending line
// inside the Signal K process without bound; longer runs are passed on in
// pieces of this many characters.
const JOB_LOG_MAX_LINE_LENGTH = 16 * 1024;
// setTimeout fires at once for any delay above 2^31-1 ms (~24.8 days), so a
// longer run-phase timeout is re-armed in steps of at most this size.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
// How long a job container's force-remove may take before runJob stops
// waiting for it, so a daemon that stops answering cannot keep a job pending.
const REMOVE_TIMEOUT_MS = 10_000;
// How long a job that has exited may still wait for its log stream: to attach
// once the deadline has passed, and to end once the container is gone.
const LOG_ATTACH_GRACE_MS = 10_000;

/**
 * Run a one-shot helper container to completion, streaming progress.
 * dockerode replaces the former `run --rm` CLI: create with
 * `AutoRemove: true`, start, follow the demuxed log stream line-wise into
 * the progress callbacks, then `wait()` for the exit code.
 */
export async function runJob(
  runtime: ContainerRuntimeInfo,
  config: ContainerJobConfig,
  client: ContainerClient = getClient(),
): Promise<ContainerJobResult> {
  const id = randomUUID();
  const jobName = `${jobPrefix()}${id.slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const image = qualifyImage(config.image, runtime);

  const result: ContainerJobResult = {
    id,
    status: "pending",
    image: config.image,
    command: config.command,
    label: config.label,
    log: [],
    createdAt,
    runtime: runtime.runtime,
  };

  // Caller cancelled before we even started — don't pull or create anything.
  if (config.signal?.aborted) {
    result.status = "cancelled";
    result.error = "Job cancelled";
    result.completedAt = new Date().toISOString();
    return result;
  }

  // Set by the abort listener so the post-wait branch reports "cancelled"
  // rather than the synthetic exit-1 "failed" that force-removing produces.
  let aborted = false;
  let onAbort: (() => void) | undefined;
  // Same idea for the run-phase deadline: a timed-out job reports why it
  // stopped instead of the exit status the force-remove produces.
  let timedOut = false;
  let cancelDeadline = () => {};
  let graceTimer: NodeJS.Timeout | undefined;
  // Once runJob has reported, no further log line reaches the result or the
  // caller's callbacks.
  let stopLogs = () => {};
  // Settles when the deadline fires, so a job whose force-remove fails (and
  // whose wait() therefore never returns) still resolves.
  let deadlineReached = new Promise<void>(() => {});
  let timeoutRemoveError: string | undefined;
  const timedOutError = () =>
    timeoutRemoveError === undefined
      ? `Job timed out after ${config.timeout}s`
      : `Job timed out after ${config.timeout}s, and its container could not be removed: ${timeoutRemoveError}`;

  try {
    const exists = await safeInspect(() => client.getImage(image).inspect());
    if (exists === null) {
      result.status = "pulling";
      config.onProgress?.(`Pulling ${config.image}...`);
      const pullResult = await safe(
        () =>
          new Promise<void>((resolve, reject) => {
            client
              .pull(image)
              .then((stream) => {
                client.modem.followProgress(
                  stream,
                  (err) => (err ? reject(err) : resolve()),
                  (event) => {
                    const e = event as { status?: string; progress?: string };
                    const line = [e.status, e.progress]
                      .filter(Boolean)
                      .join(" ");
                    if (line) config.onProgress?.(line);
                  },
                );
              })
              .catch(reject);
          }),
      );
      if (!pullResult.ok) {
        result.status = "failed";
        result.error = `Pull failed: ${messageWithRaw(pullResult.error.userMessage, pullResult.error.raw)}`;
        return result;
      }
    }

    // A cancel that landed during a long image pull: stop before we create
    // and start a container. After start, the abort listener below handles it.
    if (config.signal?.aborted) {
      result.status = "cancelled";
      result.error = "Job cancelled";
      result.completedAt = new Date().toISOString();
      return result;
    }

    result.status = "running";
    result.startedAt = new Date().toISOString();

    // Label every job container so cleanupOrphanedJobs can find ours after
    // a Signal K crash. The marker label (`<ns>-charts-job=1`) is the broad
    // "managed job" marker; the owner label (`<ns>-job-owner`) narrows to a
    // specific plugin so multiple sk-container-using plugins don't reap each
    // other's orphans. The label keys carry the namespace prefix too, so a
    // dev instance's reap query never even lists production's jobs. Values
    // go in dockerode's native `Labels` object verbatim — NO
    // percent-encoding (the CLI needed it to survive the comma-delimited
    // `ps --format` column; the API returns labels as a structured object).
    const labels: Record<string, string> = { [jobMarkerLabel()]: "1" };
    if (config.ownerPluginId) labels[jobOwnerLabel()] = config.ownerPluginId;
    if (config.label) labels[jobNameLabel()] = config.label;

    // Deliberately NOT AutoRemove: a short job can exit (and the daemon
    // remove it) before the post-start `logs()`/`wait()` calls attach,
    // turning fast helpers into flaky "no such container" failures. We
    // remove the container explicitly in `finally` once logs are drained
    // and the exit code is recorded.
    const hostConfig: Docker.HostConfig = { Binds: [] };
    if (config.inputs) {
      for (const [containerPath, hostPath] of Object.entries(config.inputs)) {
        hostConfig.Binds!.push(
          volumeArg(hostPath, containerPath, runtime, true),
        );
      }
    }
    if (config.outputs) {
      for (const [containerPath, hostPath] of Object.entries(config.outputs)) {
        hostConfig.Binds!.push(volumeArg(hostPath, containerPath, runtime));
      }
    }
    // Cgroup resource limits. Fields whose backing controller is
    // unavailable on the runtime are silently dropped — same as ensureRunning.
    if (config.resources) {
      Object.assign(
        hostConfig,
        resourcePayloadForRun(config.resources, runtime),
      );
    }

    const env: string[] = [];
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        env.push(`${key}=${value}`);
      }
    }

    const createOpts: Docker.ContainerCreateOptions = {
      name: jobName,
      Image: image,
      Cmd: [...config.command],
      Labels: labels,
      HostConfig: hostConfig,
    };
    // Override the image's baked ENTRYPOINT when the caller needs `command` to
    // run directly (not as arguments to the image's entrypoint). Required when
    // reusing an application image as a generic helper — e.g. wiping data with
    // a shell command in an image whose entrypoint launches the app.
    if (config.entrypoint) createOpts.Entrypoint = [...config.entrypoint];
    if (env.length > 0) createOpts.Env = env;
    // UID/GID alignment so files written into bind-mounted output dirs land
    // owned by the host caller. See `userMappingFlags` for the per-runtime
    // decision matrix.
    const userMapping = userMappingFlags(runtime, config.user);
    if (userMapping.User) createOpts.User = userMapping.User;
    if (userMapping.HostConfig?.UsernsMode) {
      hostConfig.UsernsMode = userMapping.HostConfig.UsernsMode;
    }

    const log: string[] = [];
    const pushLog = (line: string) => {
      if (log.length >= JOB_LOG_MAX_LINES) log.shift();
      log.push(line);
    };

    const container = await client.createContainer(createOpts);
    await container.start();
    // Await the exit from here on, not only once the log stream is attached,
    // so a deadline that fires while the logs attach can tell a job that has
    // already exited from one that overran.
    const exited = container.wait();
    let hasExited = false;
    exited.then(
      () => {
        hasExited = true;
      },
      () => {},
    );
    if (
      config.timeout !== undefined &&
      Number.isFinite(config.timeout) &&
      config.timeout > 0
    ) {
      const seconds = config.timeout;
      deadlineReached = new Promise<void>((resolve) => {
        cancelDeadline = startDeadline(seconds, () => {
          if (hasExited) {
            // The job finished in time; give a log request still attaching a
            // last bounded chance rather than reporting a timeout.
            graceTimer = setTimeout(resolve, LOG_ATTACH_GRACE_MS);
            return;
          }
          timedOut = true;
          void removeJobContainer(client, jobName).then((failure) => {
            timeoutRemoveError = failure;
            resolve();
          });
        });
      });
    }
    // Cancellation: force-removing the running container makes the pending
    // wait() below reject — the same path a daemon-side disappearance takes —
    // so an aborted job unwinds through the existing wait-failure handling.
    // The `aborted` flag distinguishes that from a genuine wait() failure.
    if (config.signal) {
      onAbort = () => {
        // A job that already exited keeps its own outcome.
        if (hasExited) return;
        aborted = true;
        void safe(() => client.getContainer(jobName).remove({ force: true }));
      };
      config.signal.addEventListener("abort", onAbort, { once: true });
    }
    // Attach the follow-logs stream AFTER start. A follow stream opened on a
    // not-yet-started container comes back empty/immediately-closed on podman
    // (verified live), losing all output; opening it post-start replays the
    // container's buffered output from the beginning, so nothing is missed.
    // Raced against the deadline so a log request that never answers cannot
    // keep a timed-out job pending.
    const logsRequest = container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    });
    const stream = await Promise.race([
      logsRequest,
      deadlineReached.then(() => null),
    ]);
    if (stream === null) {
      // Release a stream that answers after we stopped waiting for it.
      logsRequest.then(destroyStream, () => {});
      if (timedOut) throw new Error(timedOutError());
    }
    let drained = Promise.resolve();
    if (stream !== null) {
      const wired = wireJobLogStream(
        client,
        stream,
        pushLog,
        config.onProgress,
        config.onStdoutLine,
        config.onStderrLine,
      );
      drained = wired.drained;
      stopLogs = wired.stop;
    }

    const waitResult = await safe(() =>
      Promise.race([exited, deadlineReached]),
    );
    // A job that exited in time must not be marked timed out while its log
    // stream drains.
    cancelDeadline();
    const exitCode = waitResult.ok
      ? // undefined when the deadline won the race
        ((waitResult.value as { StatusCode?: number } | undefined)
          ?.StatusCode ?? 0)
      : 1;
    // Let the log stream finish flushing before we report — the follow
    // stream's `end` can lag the container's exit by a tick. Bounded, so a
    // stream that never ends cannot hold back the result and the cleanup;
    // removing the container below closes it.
    if (!timedOut) {
      let drainTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        drained,
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, LOG_ATTACH_GRACE_MS);
        }),
      ]);
      clearTimeout(drainTimer);
    }

    result.log = log;
    result.completedAt = new Date().toISOString();
    if (aborted) {
      // We force-removed the container on abort, so wait() rejected (or
      // returned a non-zero code). That's cancellation, not a failure — the
      // synthetic exit code is meaningless here, so don't surface it.
      result.status = "cancelled";
      result.error = "Job cancelled";
    } else if (timedOut) {
      result.status = "failed";
      result.error = timedOutError();
    } else {
      result.exitCode = exitCode;
      result.status = exitCode === 0 ? "completed" : "failed";
      if (!waitResult.ok) {
        // wait() itself failed (socket dropped, daemon restarted, container
        // already reaped) — the exit code is a synthetic 1, so carry the real
        // reason instead of an invented "exited with code 1".
        result.error = `Could not read container exit status: ${waitResult.error.raw}`;
      } else if (exitCode !== 0) {
        result.error = `Container exited with code ${exitCode}`;
      }
    }
  } catch (err) {
    result.completedAt = new Date().toISOString();
    if (aborted) {
      result.status = "cancelled";
      result.error = "Job cancelled";
    } else if (timedOut) {
      result.status = "failed";
      result.error = timedOutError();
    } else {
      result.status = "failed";
      // `safe()`/`safeInspect()` flatten the error to a generic userMessage and
      // tuck the real runtime text into `cause.raw`; surface that so the
      // consumer sees the actual reason, not "See logs for details."
      result.error = describeError(err);
    }
  } finally {
    cancelDeadline();
    clearTimeout(graceTimer);
    stopLogs();
    if (config.signal && onAbort) {
      config.signal.removeEventListener("abort", onAbort);
    }
    // Remove the container ourselves (we don't use AutoRemove). Covers both
    // the happy path and a create-but-never-started failure; `force: true`
    // stops it first if still running, and a 404 (already gone) is benign.
    // `safe()` never throws — it returns a result — so no catch is needed.
    await removeJobContainer(client, jobName);
  }

  return result;
}

/**
 * Force-remove a job container, giving up after `timeoutMs`. Resolves with
 * the reason it failed, or `undefined` once it is gone (a 404 counts).
 *
 * Exposed for unit tests.
 */
export async function removeJobContainer(
  client: ContainerClient,
  jobName: string,
  timeoutMs: number = REMOVE_TIMEOUT_MS,
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`no answer within ${timeoutMs / 1000}s`),
      timeoutMs,
    );
  });
  const removed = safe(() =>
    client.getContainer(jobName).remove({ force: true }),
  ).then((r) =>
    r.ok || r.error.kind === "not-found" ? undefined : r.error.raw,
  );
  try {
    return await Promise.race([removed, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call `onElapsed` once `seconds` have passed, re-arming the timer across
 * setTimeout's maximum delay. Returns a function that cancels it.
 *
 * Exposed for unit tests.
 */
export function startDeadline(
  seconds: number,
  onElapsed: () => void,
): () => void {
  const at = Date.now() + seconds * 1000;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    const remaining = at - Date.now();
    if (remaining <= 0) {
      onElapsed();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  arm();
  return () => clearTimeout(timer);
}

/**
 * Demux a job's follow-mode log stream line-wise into the progress/stdout/
 * stderr callbacks. dockerode multiplexes stdout/stderr with 8-byte frame
 * headers, so we split via `modem.demuxStream` and line-buffer each side.
 *
 * Returns a promise that resolves when the source stream ends, so `runJob`
 * can await full log drain before returning (the stream can outlive
 * `container.wait()` by a tick).
 */
function wireJobLogStream(
  client: ContainerClient,
  stream: NodeJS.ReadableStream,
  pushLog: (line: string) => void,
  onProgress?: (line: string) => void,
  onStdoutLine?: (line: string) => void,
  onStderrLine?: (line: string) => void,
): { drained: Promise<void>; stop: () => void } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stopped = false;
  const emit = (line: string, onLine: ((line: string) => void) | undefined) => {
    if (stopped) return;
    pushLog(line);
    onProgress?.(line);
    onLine?.(line);
  };
  const flushes: Array<() => void> = [];
  const lineBuffer = (
    sink: PassThrough,
    onLine: ((line: string) => void) | undefined,
  ) => {
    let buf = "";
    const flush = () => {
      if (buf.length > 0) emit(buf, onLine);
      buf = "";
    };
    flushes.push(flush);
    // Decode across chunks, so a character split between two log frames
    // survives intact.
    sink.setEncoding("utf8");
    sink.on("data", (chunk: string) => {
      buf += chunk;
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      const pending = splitLongLine(buf);
      buf = pending.pop() ?? "";
      for (const part of [...parts, ...pending]) {
        if (part.length === 0) continue;
        for (const piece of splitLongLine(part)) emit(piece, onLine);
      }
    });
    sink.on("end", flush);
  };
  lineBuffer(stdout, onStdoutLine);
  lineBuffer(stderr, onStderrLine);
  client.modem.demuxStream(stream, stdout, stderr);
  const drained = new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", () => resolve());
  });
  return {
    drained,
    stop: () => {
      if (stopped) return;
      for (const flush of flushes) {
        try {
          flush();
        } catch {
          // A throwing consumer callback must not skip the cleanup below or
          // the container removal after it.
        }
      }
      stopped = true;
      // Release a stream the daemon left open, so it holds no connection.
      destroyStream(stream);
      stdout.destroy();
      stderr.destroy();
    },
  };
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
}

/**
 * Cut `line` into pieces of at most `max` UTF-16 code units, never between
 * the two halves of a surrogate pair. The last piece is whatever remains and
 * may be shorter (or empty).
 *
 * Exposed for unit tests.
 */
export function splitLongLine(
  line: string,
  max: number = JOB_LOG_MAX_LINE_LENGTH,
): string[] {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`max must be a positive integer, got ${max}`);
  }
  const pieces: string[] = [];
  let start = 0;
  while (line.length - start > max) {
    let end = start + max;
    // Step back only when the piece keeps at least one code unit, so a
    // limit too small for the pair still advances.
    if (end - 1 > start && isHighSurrogate(line.charCodeAt(end - 1))) {
      end -= 1;
    }
    pieces.push(line.slice(start, end));
    start = end;
  }
  pieces.push(line.slice(start));
  return pieces;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Build an `OrphanJobInfo` from a dockerode container summary, or null if
 * it isn't ours. Labels come back as a structured object (no decoding
 * needed — the API never percent-encodes them).
 *
 * Exposed for unit tests.
 */
export function orphanFromContainer(
  c: { Names?: string[]; Image?: string; Labels?: Record<string, string> },
  ownerPluginId: string,
): OrphanJobInfo | null {
  const name = (c.Names?.[0] ?? "").replace(/^\//, "");
  const image = c.Image ?? "";
  if (!name || !image) return null;
  // Reap ONLY unmistakable one-shot jobs. `runJob` names every helper
  // `<ns>-job-<id>`; a long-running managed container (e.g. a consumer
  // plugin's service) could carry the same marker/owner labels but is NOT a
  // job, and must never be force-removed on startup. The name prefix is the
  // defining, unspoofable-by-label trait — and because it is namespaced, a
  // dev instance can never match a production `sk-job-*` helper.
  if (!name.startsWith(jobPrefix())) return null;
  const labels = c.Labels ?? {};
  // Re-verify BOTH labels the list filter queried on. The filter should
  // already restrict the set, but never trust its output enough to
  // force-remove a row that doesn't actively carry our managed-job marker
  // AND claim our owner. `runJob` sets the marker unconditionally, so a
  // `<ns>-job-*` container lacking it is not one of ours.
  if (labels[jobMarkerLabel()] !== "1") return null;
  if (labels[jobOwnerLabel()] !== ownerPluginId) return null;
  return {
    name,
    image,
    ownerPluginId,
    label: labels[jobNameLabel()],
  };
}

/**
 * Find every `<ns>-job-*` container labelled with the given `ownerPluginId`,
 * force-remove each, and return the list so the caller can roll back any
 * persistent state tied to those jobs.
 *
 * Used by consumer plugins on `start()` to clean up after a Signal K crash
 * that left helper containers running with no parent listener.
 */
export async function cleanupOrphanedJobs(
  runtime: ContainerRuntimeInfo,
  ownerPluginId: string,
  client: ContainerClient = getClient(),
): Promise<CleanupOrphansResult> {
  // `label=key=value` filters are supported by both podman and docker.
  // Values are raw (not percent-encoded) — the API matches the structured
  // label object, not a delimited string.
  const listResult = await safe(() =>
    client.listContainers({
      all: true,
      filters: {
        label: [`${jobMarkerLabel()}=1`, `${jobOwnerLabel()}=${ownerPluginId}`],
      },
    }),
  );
  // A failed list means cleanup never inspected the runtime — not that
  // there were zero leaked jobs. Surface it so the caller's catch logs it.
  if (!listResult.ok) {
    throw new Error(
      `cleanupOrphanedJobs: list failed: ${messageWithRaw(
        listResult.error.userMessage,
        listResult.error.raw,
      )}`,
      { cause: listResult.error },
    );
  }

  const reaped: OrphanJobInfo[] = [];
  for (const c of listResult.value) {
    const parsed = orphanFromContainer(c, ownerPluginId);
    if (!parsed) continue;

    // `remove({force})` stops then removes in one call. 404 is the TOCTOU
    // case where the container exited between list and remove — harmless,
    // it's gone and rollback is correct. Any other failure means the
    // helper might still be alive, so skip the entry and log.
    const rm = await safe(() =>
      client.getContainer(parsed.name).remove({ force: true }),
    );
    if (!rm.ok && rm.error.kind !== "not-found") {
      console.warn(
        `[signalk-container] cleanupOrphanedJobs: remove ${parsed.name} failed: ${messageWithRaw(rm.error.userMessage, rm.error.raw)}`,
      );
      continue;
    }
    reaped.push(parsed);
  }

  return { reaped };
}
