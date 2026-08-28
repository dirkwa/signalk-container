/**
 * Container-name namespace.
 *
 * Every managed container, one-shot job container, and job label this
 * plugin creates is prefixed with a namespace so that two Signal K servers
 * sharing one container runtime never collide, reap, or drift-recreate each
 * other's containers. The motivating case: a production install and a
 * devcontainer dev instance on the same host, both talking to the same
 * rootless-Podman socket — without a namespace the dev server's
 * `ensureRunning("questdb")` would inspect the production `sk-questdb` and
 * its job reaper could force-remove production `sk-job-*` helpers.
 *
 * The namespace is resolved ONCE from `SIGNALK_CONTAINER_NAMESPACE` at
 * plugin.start() via setNamespace(). It defaults to `sk`, so an install
 * that does not set the env var produces exactly the same container names,
 * job names, and label keys as prior releases: containers stay `sk-<name>`,
 * jobs `sk-job-<id>`, labels `sk-charts-job` / `sk-job-owner` /
 * `sk-job-label`.
 *
 * The devcontainer sets `SIGNALK_CONTAINER_NAMESPACE=devpod`, so its
 * managed containers are `devpod-<name>` and can never touch the
 * production `sk-*` stack running on the same box.
 */

const DEFAULT_NAMESPACE = "sk";

// A namespace becomes a container-name prefix (`<ns>-<name>`) and a label
// key prefix (`<ns>-job-owner`). Podman/Docker container names must match
// [a-zA-Z0-9][a-zA-Z0-9_.-]*; we keep the token to lowercase alphanumerics
// so the derived name is always valid and the two namespaces never share a
// prefix (`sk` is not a prefix of `devpod`). 1-32 chars is ample for `sk`
// and `devpod` while staying well inside runtime name limits.
const VALID_NAMESPACE = /^[a-z0-9]+$/;
const MAX_NAMESPACE_LENGTH = 32;

let namespace = DEFAULT_NAMESPACE;

/**
 * Set the active namespace from an untrusted source (an env var). An unset
 * value (`undefined`) silently defaults. An empty, over-long, or
 * non-alphanumeric value falls back to the default AND is reported via the
 * optional `onInvalid` callback so the caller can log it — the plugin must
 * still come up on a typo'd env var, just in the safe default `sk`
 * namespace. Called from plugin.start(); resetNamespace() undoes it.
 */
export function setNamespace(
  raw: string | undefined,
  onInvalid?: (value: string) => void,
): void {
  // Unset is the ordinary "no namespace chosen" case — silently default.
  // An explicit empty string is a mistake (often a broken `=$UNSET`
  // expansion), so it goes through the reported-invalid path below.
  if (raw === undefined) {
    namespace = DEFAULT_NAMESPACE;
    return;
  }
  if (
    raw === "" ||
    raw.length > MAX_NAMESPACE_LENGTH ||
    !VALID_NAMESPACE.test(raw)
  ) {
    onInvalid?.(raw);
    namespace = DEFAULT_NAMESPACE;
    return;
  }
  namespace = raw;
}

/** Restore the default namespace so a stop/start cycle can't strand a run. */
export function resetNamespace(): void {
  namespace = DEFAULT_NAMESPACE;
}

/** The active namespace token (no trailing hyphen), e.g. `sk` or `devpod`. */
export function getNamespace(): string {
  return namespace;
}

/** Managed-container / DNS name prefix: `<ns>-`. */
export function containerPrefix(): string {
  return `${namespace}-`;
}

/** One-shot job container name prefix: `<ns>-job-`. */
export function jobPrefix(): string {
  return `${namespace}-job-`;
}

/** Broad "this is a managed one-shot job" marker label key. */
export function jobMarkerLabel(): string {
  return `${namespace}-charts-job`;
}

/** Owner-plugin-id label key that narrows job reaping to one plugin. */
export function jobOwnerLabel(): string {
  return `${namespace}-job-owner`;
}

/** Human-readable job label key. */
export function jobNameLabel(): string {
  return `${namespace}-job-label`;
}

/**
 * Requested-resource-limits provenance label key on managed containers.
 * Stamped at create time so a fresh server process can tell a
 * runtime-injected limit from one a consumer actually requested.
 */
export function requestedResourcesLabel(): string {
  return `${namespace}-requested-resources`;
}

/**
 * Requested-config provenance label key on managed containers.
 * Stamped at create time so a fresh server process can still detect
 * config the consumer has since *unset* — an env key or `command`
 * dropped while Signal K was down. Holds env key NAMES only, never
 * their values (`diffContainerConfig` reads only key presence, and a
 * value can be a credential).
 */
export function requestedConfigLabel(): string {
  return `${namespace}-requested-config`;
}
