import type { ContainerConfig, ContainerRuntimeInfo } from "./types.js";
import { type ExecFn, qualifyImage } from "./containers.js";
import { execRuntime, userMappingFlags } from "./runtime.js";

/**
 * Outcome of an image-compliance probe. `ok` is the headline; `output`
 * and `error` give the operator enough to fix a failure.
 */
export interface ImageProbeResult {
  ok: boolean;
  /**
   * Combined stdout/stderr of the probe container. Always non-null —
   * empty string when nothing was printed (a successful run prints `"ok"`).
   */
  output: string;
  /** Reason the probe failed; absent on `ok: true`. */
  error?: string;
}

/**
 * Run the image as the host caller (via the existing `userMappingFlags`
 * matrix), execute `touch /tmp/x && echo ok`, and report whether the
 * image is non-root-friendly enough for the ownership-aligned mount
 * model.
 *
 * Failure modes:
 *   - Image has a non-writable `/tmp` for the host UID.
 *   - Image has no `HOME` writable for the host UID and the entrypoint
 *     touches `~`.
 *   - Image's `USER` directive doesn't grant write on the paths
 *     downstream code will need.
 *
 * Implementation deliberately reuses `userMappingFlags` so the probe
 * runs with the *same* uid mapping `ensureRunning` would use for the
 * managed container — `ok` here means "the live mapping works", not
 * "any mapping works".
 *
 * Returns `ok: false` (never throws) on:
 *   - non-zero exit
 *   - exit 0 but stdout doesn't contain `"ok"` (the probe shell short-
 *     circuited via `&&` and printed nothing — the touch failed silently)
 *   - exec layer failure (timeout, binary missing)
 */
export async function imageRunsAsUser(
  runtime: ContainerRuntimeInfo,
  image: string,
  user: ContainerConfig["user"],
  exec: ExecFn = execRuntime,
): Promise<ImageProbeResult> {
  const userFlags = userMappingFlags(runtime, user);
  const args = [
    "run",
    "--rm",
    ...userFlags,
    qualifyImage(image, runtime),
    "sh",
    "-c",
    "touch /tmp/x && echo ok",
  ];
  try {
    const r = await exec(runtime, args);
    const output = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (r.exitCode !== 0) {
      return {
        ok: false,
        output,
        error: `Container exited with code ${r.exitCode}`,
      };
    }
    if (!r.stdout.includes("ok")) {
      return {
        ok: false,
        output,
        error: "Probe exited 0 but did not print 'ok'; touch likely failed",
      };
    }
    return { ok: true, output: r.stdout };
  } catch (err) {
    return {
      ok: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
