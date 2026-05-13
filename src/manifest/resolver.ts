import type {
  ContainerConfig,
  ContainerRuntimeInfo,
  ResolveResult,
} from "../types.js";
import type { ExecFn } from "../containers.js";

/** sha256 digest format used everywhere a digest is declared or stored. */
export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/**
 * Functions the resolver calls into. Injected so tests can stub
 * without touching the real runtime. Production callers bind these to
 * the live implementations in `src/containers.ts`.
 */
export interface ResolveDeps {
  qualifyImage(image: string, runtime: ContainerRuntimeInfo): string;
  imageExists(
    runtime: ContainerRuntimeInfo,
    image: string,
    exec?: ExecFn,
  ): Promise<boolean>;
  pullImage(
    runtime: ContainerRuntimeInfo,
    image: string,
    onProgress?: (msg: string) => void,
  ): Promise<void>;
  getRepoDigest(
    runtime: ContainerRuntimeInfo,
    image: string,
    exec?: ExecFn,
  ): Promise<string | null>;
  getImageDigest(
    runtime: ContainerRuntimeInfo,
    imageOrContainer: string,
  ): Promise<string | null>;
}

/**
 * Decide the effective image reference for a `ContainerConfig`, pull
 * it if absent, and return the resolved manifest digest for the
 * consumer manifest record.
 *
 * Three paths:
 *   1. `digest` set and valid: pull `image@digest` if absent.
 *      `resolvedDigest` is the declared digest; `source: "declared"`.
 *   2. `digest` unset: pull `image:tag` if absent, then read the
 *      RepoDigest. If the image has no RepoDigests (locally-built),
 *      synthesize a `local:<image-id>` identity so the manifest still
 *      has a stable per-host key. `source: "resolved-from-tag"`.
 *   3. `digest` set but malformed: throw synchronously before any
 *      runtime call.
 */
export async function resolveImage(
  runtime: ContainerRuntimeInfo,
  config: Pick<ContainerConfig, "image" | "tag" | "digest">,
  deps: ResolveDeps,
  onProgress?: (msg: string) => void,
): Promise<ResolveResult> {
  if (config.digest !== undefined && !DIGEST_RE.test(config.digest)) {
    throw new Error(
      `Invalid digest for ${config.image}: expected sha256:<64-hex>, got ${config.digest}`,
    );
  }

  if (config.digest) {
    const pullSpec = deps.qualifyImage(
      `${config.image}@${config.digest}`,
      runtime,
    );
    if (!(await deps.imageExists(runtime, pullSpec))) {
      await deps.pullImage(runtime, pullSpec, onProgress);
    }
    return { pullSpec, resolvedDigest: config.digest, source: "declared" };
  }

  const pullSpec = deps.qualifyImage(`${config.image}:${config.tag}`, runtime);
  if (!(await deps.imageExists(runtime, pullSpec))) {
    await deps.pullImage(runtime, pullSpec, onProgress);
  }
  const repoDigest = await deps.getRepoDigest(runtime, pullSpec);
  if (repoDigest) {
    return {
      pullSpec,
      resolvedDigest: repoDigest,
      source: "resolved-from-tag",
    };
  }
  // Locally-built / never-pushed: fall back to local image id so the
  // manifest has a stable identity on this host even without a
  // registry digest. Two hosts won't see the same identity, but
  // locally-built consumer-plugin images are rare in practice.
  const localId = await deps.getImageDigest(runtime, pullSpec);
  return {
    pullSpec,
    resolvedDigest: `local:${localId ?? "unknown"}`,
    source: "resolved-from-tag",
  };
}
