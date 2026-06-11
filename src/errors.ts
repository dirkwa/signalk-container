/**
 * Error categorization for dockerode calls. Every runtime call routes through
 * `safe()` in `client.ts`, which runs `categorizeError` on any thrown error so
 * the UI and doctor can surface a stable `kind` + `userMessage` instead of a
 * raw stack.
 *
 * Adapted from signalk-updater-server/src/errors.ts. The plugin adds the
 * `socket-unreachable` kind: when the runtime moved from spawning a CLI binary
 * to talking a unix socket, "no runtime" stopped meaning "binary not on PATH"
 * and started meaning "socket missing or refusing the connection". That is the
 * single most common failure in the in-container topology (socket not
 * bind-mounted) and the doctor needs to name it distinctly.
 */
export type ErrorKind =
  | "network"
  | "auth"
  | "disk"
  | "permission"
  | "not-found"
  | "socket-unreachable"
  | "unknown";

export interface CategorizedError {
  kind: ErrorKind;
  userMessage: string;
  raw: string;
}

// ENOENT/ECONNREFUSED against the container socket mean the daemon socket is
// absent or refusing — distinct from a registry network error. Checked before
// NET_PATTERNS so a socket failure isn't mislabelled "check registry
// connectivity".
const SOCKET_PATTERNS = [
  /ECONNREFUSED/,
  /ENOENT/,
  /EACCES.*\.sock/i,
  /connect ENOENT/i,
  /socket hang up/i,
];

const NET_PATTERNS = [
  /ENOTFOUND/,
  /EHOSTUNREACH/,
  /ETIMEDOUT/,
  /no route to host/i,
  /network is unreachable/i,
];

const AUTH_PATTERNS = [
  /unauthorized/i,
  /authentication required/i,
  /denied: requested access/i,
];

const DISK_PATTERNS = [/no space left/i, /enospc/i, /disk quota/i];

const PERM_PATTERNS = [
  /permission denied/i,
  /eacces/i,
  /eperm/i,
  /operation not permitted/i,
];

const NOT_FOUND_PATTERNS = [/no such (image|container|network)/i, /not found/i];

/**
 * Pull a status code off a dockerode error when present. dockerode attaches
 * `statusCode` (HTTP status from the daemon) to the errors it throws; we use it
 * to classify 404 → not-found cheaply before falling back to message matching.
 */
function statusCodeOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

export function categorizeError(err: unknown): CategorizedError {
  const raw = err instanceof Error ? err.message : String(err);
  const status = statusCodeOf(err);

  if (status === 404) {
    return { kind: "not-found", userMessage: "Resource not found.", raw };
  }

  if (SOCKET_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "socket-unreachable",
      userMessage:
        "Container runtime socket unreachable. Is the docker/podman socket bind-mounted?",
      raw,
    };
  }
  if (NET_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "network",
      userMessage: "Network error. Check connectivity to the registry.",
      raw,
    };
  }
  if (AUTH_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "auth",
      userMessage: "Registry authentication failed.",
      raw,
    };
  }
  if (DISK_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "disk",
      userMessage: "Disk full. Free space and retry.",
      raw,
    };
  }
  if (PERM_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "permission",
      userMessage:
        "Permission denied. Check container socket and mount permissions.",
      raw,
    };
  }
  if (NOT_FOUND_PATTERNS.some((p) => p.test(raw))) {
    return { kind: "not-found", userMessage: "Resource not found.", raw };
  }
  return {
    kind: "unknown",
    userMessage: "Unexpected error. See logs for details.",
    raw,
  };
}

// Narrow to just the field describeError reads. safe()/safeInspect() attach a
// full CategorizedError as the cause, but guarding only `raw` keeps the check
// honest about what it actually asserts (and consumes).
function hasRawErrorText(value: unknown): value is { raw: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    typeof (value as { raw: unknown }).raw === "string"
  );
}

/**
 * The most informative message for a caught error, for surfacing to a
 * consumer/log. `safe()`/`safeInspect()` rethrow as `Error(userMessage, {
 * cause: CategorizedError })` — so the message alone is the generic
 * `userMessage` (e.g. "Unexpected error. See logs for details.") and the real
 * runtime text lives in `cause.raw`. Prefer that raw text when present; fall
 * back to the error's own message for errors thrown directly (not via `safe`).
 */
export function describeError(err: unknown): string {
  if (err instanceof Error && hasRawErrorText(err.cause)) {
    return err.cause.raw;
  }
  return err instanceof Error ? err.message : String(err);
}
