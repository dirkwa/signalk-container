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
import { volumeArg, qualifyImage } from "./containers.js";
import { resourcePayloadForRun } from "./resources.js";
import {
  getClient,
  safe,
  safeInspect,
  type ContainerClient,
} from "./client.js";

// `userMappingFlags` and the host-id test setter (`_setCurrentHostIdsForTesting`)
// live in `runtime.ts` so both `jobs.ts` (one-shot helpers) and
// `containers.ts` (long-running managed containers via `buildCreateOptions`)
// can share the same decision matrix without an import cycle.
export { userMappingFlags, _setCurrentHostIdsForTesting } from "./runtime.js";

const JOB_LOG_MAX_LINES = 200;
/** Name prefix that marks a container as a one-shot helper job (see runJob). */
const JOB_NAME_PREFIX = "sk-job-";

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
  const jobName = `${JOB_NAME_PREFIX}${id.slice(0, 8)}`;
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
        result.error = `Pull failed: ${pullResult.error.userMessage}`;
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
    // a Signal K crash. `sk-charts-job=1` is the broad "managed sk-job"
    // marker; `sk-job-owner` narrows to a specific plugin so multiple
    // sk-container-using plugins don't reap each other's orphans. Values
    // go in dockerode's native `Labels` object verbatim — NO
    // percent-encoding (the CLI needed it to survive the comma-delimited
    // `ps --format` column; the API returns labels as a structured object).
    const labels: Record<string, string> = { "sk-charts-job": "1" };
    if (config.ownerPluginId) labels["sk-job-owner"] = config.ownerPluginId;
    if (config.label) labels["sk-job-label"] = config.label;

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
    // Cancellation: force-removing the running container makes the pending
    // wait() below reject — the same path a daemon-side disappearance takes —
    // so an aborted job unwinds through the existing wait-failure handling.
    // The `aborted` flag distinguishes that from a genuine wait() failure.
    if (config.signal) {
      onAbort = () => {
        aborted = true;
        void safe(() => client.getContainer(jobName).remove({ force: true }));
      };
      config.signal.addEventListener("abort", onAbort, { once: true });
    }
    // Attach the follow-logs stream AFTER start. A follow stream opened on a
    // not-yet-started container comes back empty/immediately-closed on podman
    // (verified live), losing all output; opening it post-start replays the
    // container's buffered output from the beginning, so nothing is missed.
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    });
    const drained = wireJobLogStream(
      client,
      stream,
      pushLog,
      config.onProgress,
      config.onStdoutLine,
      config.onStderrLine,
    );

    const waitResult = await safe(() => container.wait());
    const exitCode = waitResult.ok
      ? ((waitResult.value as { StatusCode?: number }).StatusCode ?? 0)
      : 1;
    // Let the log stream finish flushing before we report — the follow
    // stream's `end` can lag the container's exit by a tick.
    await drained;

    result.log = log;
    result.completedAt = new Date().toISOString();
    if (aborted) {
      // We force-removed the container on abort, so wait() rejected (or
      // returned a non-zero code). That's cancellation, not a failure — the
      // synthetic exit code is meaningless here, so don't surface it.
      result.status = "cancelled";
      result.error = "Job cancelled";
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
    } else {
      result.status = "failed";
      result.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (config.signal && onAbort) {
      config.signal.removeEventListener("abort", onAbort);
    }
    // Remove the container ourselves (we don't use AutoRemove). Covers both
    // the happy path and a create-but-never-started failure; `force: true`
    // stops it first if still running, and a 404 (already gone) is benign.
    // `safe()` never throws — it returns a result — so no catch is needed.
    await safe(() => client.getContainer(jobName).remove({ force: true }));
  }

  return result;
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
): Promise<void> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lineBuffer = (
    sink: PassThrough,
    onLine: ((line: string) => void) | undefined,
  ) => {
    let buf = "";
    sink.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const part of parts) {
        if (part.length === 0) continue;
        pushLog(part);
        onProgress?.(part);
        onLine?.(part);
      }
    });
    sink.on("end", () => {
      if (buf.length > 0) {
        pushLog(buf);
        onProgress?.(buf);
        onLine?.(buf);
      }
    });
  };
  lineBuffer(stdout, onStdoutLine);
  lineBuffer(stderr, onStderrLine);
  client.modem.demuxStream(stream, stdout, stderr);
  return new Promise<void>((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", () => resolve());
  });
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
  // `sk-job-<id>`; a long-running managed container (e.g. a consumer plugin's
  // service) could carry the same `sk-charts-job`/`sk-job-owner` labels but is
  // NOT a job, and must never be force-removed on startup. The name prefix is
  // the defining, unspoofable-by-label trait.
  if (!name.startsWith(JOB_NAME_PREFIX)) return null;
  const labels = c.Labels ?? {};
  // Require a positive owner-label match. The list filter should already
  // restrict the set, but never trust filter output enough to force-remove
  // a row that doesn't actively claim our owner.
  if (labels["sk-job-owner"] !== ownerPluginId) return null;
  return {
    name,
    image,
    ownerPluginId,
    label: labels["sk-job-label"],
  };
}

/**
 * Find every `sk-job-*` container labelled with the given `ownerPluginId`,
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
        label: ["sk-charts-job=1", `sk-job-owner=${ownerPluginId}`],
      },
    }),
  );
  // A failed list means cleanup never inspected the runtime — not that
  // there were zero leaked jobs. Surface it so the caller's catch logs it.
  if (!listResult.ok) {
    throw new Error(
      `cleanupOrphanedJobs: list failed: ${listResult.error.userMessage}`,
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
        `[signalk-container] cleanupOrphanedJobs: remove ${parsed.name} failed: ${rm.error.userMessage}`,
      );
      continue;
    }
    reaped.push(parsed);
  }

  return { reaped };
}
