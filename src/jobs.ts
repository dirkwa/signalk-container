import { randomUUID } from "crypto";
import {
  ContainerJobConfig,
  ContainerJobResult,
  ContainerRuntimeInfo,
  CleanupOrphansResult,
  OrphanJobInfo,
} from "./types";
import { execRuntime, execRuntimeLong } from "./runtime";
import { volumeArg } from "./containers";
import { resourceFlagsForRun } from "./resources";

export async function runJob(
  runtime: ContainerRuntimeInfo,
  config: ContainerJobConfig,
): Promise<ContainerJobResult> {
  const id = randomUUID();
  const jobName = `sk-job-${id.slice(0, 8)}`;
  const createdAt = new Date().toISOString();

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

  try {
    const inspectResult = await execRuntime(runtime, [
      "image",
      "inspect",
      config.image,
    ]);
    if (inspectResult.exitCode !== 0) {
      result.status = "pulling";
      config.onProgress?.(`Pulling ${config.image}...`);
      // Pull gets a 5-minute cap by default — image pulls hang sometimes
      // and a stuck pull is worth surfacing as a failure rather than
      // letting it block the job indefinitely.  Caller can override
      // via `config.timeout` (in seconds) for slow links.
      const pullResult = await execRuntimeLong(
        runtime,
        ["pull", config.image],
        config.onProgress,
        config.timeout ? config.timeout * 1000 : 300000,
      );
      if (pullResult.exitCode !== 0) {
        result.status = "failed";
        result.error = `Pull failed: ${pullResult.log.slice(-3).join("\n")}`;
        result.log = pullResult.log;
        return result;
      }
    }

    result.status = "running";
    result.startedAt = new Date().toISOString();

    const args = ["run", "--rm", "--name", jobName];

    // Label every job container so cleanupOrphanedJobs can find ours
    // after a Signal K crash. `sk-charts-job=1` is the broad "this is
    // a managed sk-job from signalk-container" marker; `sk-job-owner`
    // narrows to a specific plugin so a future docking of multiple
    // sk-container-using plugins doesn't have plugins reaping each
    // other's orphans.
    //
    // The labels column we read back from `ps` is comma-delimited, so
    // any commas inside a label value would silently truncate. Use
    // encodeURIComponent on values that could contain user-supplied
    // text; parseOrphanLine decodes on the way back.
    args.push("--label", "sk-charts-job=1");
    if (config.ownerPluginId) {
      args.push(
        "--label",
        `sk-job-owner=${encodeURIComponent(config.ownerPluginId)}`,
      );
    }
    if (config.label) {
      args.push("--label", `sk-job-label=${encodeURIComponent(config.label)}`);
    }

    if (config.inputs) {
      for (const [containerPath, hostPath] of Object.entries(config.inputs)) {
        args.push("-v", volumeArg(hostPath, containerPath, runtime, true));
      }
    }

    if (config.outputs) {
      for (const [containerPath, hostPath] of Object.entries(config.outputs)) {
        args.push("-v", volumeArg(hostPath, containerPath, runtime));
      }
    }

    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    // Cgroup resource limits (--cpus, --memory, --pids-limit, etc.).
    // Fields whose backing controller is unavailable on the runtime are
    // silently dropped — same behaviour as ensureRunning.
    if (config.resources) {
      args.push(...resourceFlagsForRun(config.resources, runtime));
    }

    args.push(config.image, ...config.command);

    // No default timeout for the run phase: chart conversions and other
    // legitimate workloads can take hours.  Caller passes `config.timeout`
    // (in seconds) explicitly when they want a cap.
    const runResult = await execRuntimeLong(
      runtime,
      args,
      config.onProgress,
      config.timeout ? config.timeout * 1000 : undefined,
      config.onStdoutLine,
      config.onStderrLine,
    );

    result.exitCode = runResult.exitCode;
    result.log = runResult.log;
    result.completedAt = new Date().toISOString();
    result.status = runResult.exitCode === 0 ? "completed" : "failed";

    if (runResult.exitCode !== 0) {
      result.error = `Container exited with code ${runResult.exitCode}`;
    }
  } catch (err) {
    result.status = "failed";
    result.error = err instanceof Error ? err.message : String(err);
    result.completedAt = new Date().toISOString();

    await execRuntime(runtime, ["rm", "-f", jobName]).catch(() => {});
  }

  return result;
}

/**
 * Parse one tab-separated line emitted by `podman ps --format
 * "{{.Names}}\t{{.Image}}\t{{.Labels}}"` into an OrphanJobInfo.
 * Returns null for malformed lines.  Exposed for unit tests; the
 * runtime CLI is not mocked in the test harness.
 */
export function parseOrphanLine(
  line: string,
  ownerPluginId: string,
): OrphanJobInfo | null {
  // Don't trim first: leading whitespace would collapse a leading
  // empty column (e.g. an empty `name` field), which would shift the
  // remaining columns and cause the parser to accept a malformed line
  // as a real job. Skip blank lines explicitly via a regex check.
  if (!/\S/.test(line)) {
    return null;
  }
  // Require the full three-column format the `ps --format` template
  // produces. A truncated row (no labels column at all) means the
  // emitter shifted shape — refuse to claim it without proof.
  const parts = line.split("\t");
  if (parts.length < 3) {
    return null;
  }
  const [name, image, labels] = parts;
  if (!name || !image) {
    return null;
  }
  // Labels come back as `key=value,key=value`. Pull our two values out
  // without depending on a particular emitter ordering. Values were
  // percent-encoded at write time (see runJob) to survive the comma
  // delimiter, so decode on the way out.
  const labelMap = new Map<string, string>();
  for (const kv of (labels ?? "").split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) {
      try {
        labelMap.set(
          kv.slice(0, eq).trim(),
          decodeURIComponent(kv.slice(eq + 1).trim()),
        );
      } catch {
        // Malformed encoding (shouldn't happen for our own labels).
        // Fall back to the raw value rather than dropping the entry.
        labelMap.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
      }
    }
  }
  // Require a positive owner-label match. The runtime's
  // `--filter label=sk-job-owner=...` query should already restrict
  // the input set, but never trust filter output enough to send `rm
  // --force` to a row that doesn't actively claim our owner — a row
  // with no `sk-job-owner` label, or a different owner, is not ours.
  const labelOwner = labelMap.get("sk-job-owner");
  if (labelOwner !== ownerPluginId) {
    return null;
  }

  return {
    name,
    image,
    ownerPluginId,
    label: labelMap.get("sk-job-label"),
  };
}

/**
 * Find every running `sk-job-*` container labelled with the given
 * `ownerPluginId`, stop and remove each one (`rm --force`), and
 * return the list so the caller can roll back any persistent state
 * tied to those jobs.
 *
 * Used by consumer plugins on their `start()` to clean up after a
 * Signal K crash that left helper containers running with no parent
 * listener.
 */
export async function cleanupOrphanedJobs(
  runtime: ContainerRuntimeInfo,
  ownerPluginId: string,
): Promise<CleanupOrphansResult> {
  // List with the format we need to construct OrphanJobInfo. `--filter
  // label=key=value` is supported by both podman and docker; combine
  // with our two markers so we never reap something some unrelated
  // tool happens to have running.
  const psResult = await execRuntime(runtime, [
    "ps",
    "-a",
    "--filter",
    "label=sk-charts-job=1",
    // Match the encoding runJob applied so a hypothetical owner id
    // containing characters that conflict with the labels column
    // delimiter still finds its containers.
    "--filter",
    `label=sk-job-owner=${encodeURIComponent(ownerPluginId)}`,
    "--format",
    "{{.Names}}\t{{.Image}}\t{{.Labels}}",
  ]);

  // A non-zero `ps` exit means cleanup never inspected the runtime —
  // not that there were zero leaked jobs. Returning `{ reaped: [] }`
  // there would make the caller skip rollback while orphan helpers
  // may still be alive. Surface the failure so the caller's catch can
  // log it; an empty stdout on a successful exit means there really
  // are no orphans and that's the only "no orphans" case.
  if (psResult.exitCode !== 0) {
    throw new Error(
      `cleanupOrphanedJobs: ps failed: ${psResult.stderr.trim() || "unknown error"}`,
    );
  }
  if (!psResult.stdout) {
    return { reaped: [] };
  }

  const reaped: OrphanJobInfo[] = [];
  for (const line of psResult.stdout.split("\n")) {
    const parsed = parseOrphanLine(line, ownerPluginId);
    if (!parsed) {
      continue;
    }

    // `rm --force` stops a running container before removing it, so
    // one call covers both states. A non-zero exit code is the
    // TOCTOU case where the container exited between `ps` and `rm`
    // — harmless, the container is gone and rollback is correct.
    // A thrown failure is different: execRuntime never finished, so
    // the helper might still be alive. In that case skip the entry
    // (don't claim a successful reap) and log; the next start() call
    // will pick the orphan up again.
    let rmResult;
    try {
      rmResult = await execRuntime(runtime, ["rm", "--force", parsed.name]);
    } catch (err) {
      console.warn(
        `[signalk-container] cleanupOrphanedJobs: rm --force ${parsed.name} threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (rmResult.exitCode !== 0) {
      console.warn(
        `[signalk-container] cleanupOrphanedJobs: rm --force ${parsed.name} exited ${rmResult.exitCode}: ${rmResult.stderr.trim()}`,
      );
    }

    reaped.push(parsed);
  }

  return { reaped };
}
