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
 *
 * Throw sites that build a user-facing message from a `CategorizedError`
 * compose it via `messageWithRaw` (so the raw runtime text stays visible) and
 * attach the `CategorizedError` as `cause` (so `describeError` can recover
 * the untruncated text).
 */
export type ErrorKind =
  | "network"
  | "auth"
  | "disk"
  | "permission"
  | "not-found"
  | "socket-unreachable"
  | "invalid-config"
  | "storage-corrupt"
  | "unknown";

export interface CategorizedError {
  kind: ErrorKind;
  userMessage: string;
  raw: string;
}

// Socket-transport failures against the container daemon — distinct from a
// registry network error. Checked before NET_PATTERNS so a socket failure
// isn't mislabelled "check registry connectivity". Covers both the socket
// being absent/refusing (ENOENT/ECONNREFUSED — not bind-mounted) and the
// daemon resetting the connection mid-request (EPIPE/ECONNRESET — e.g. an old
// podman rejecting a large create payload).
//
// An EACCES on the socket is deliberately NOT here: the socket exists and is
// bind-mounted, but its owner/group ACL refuses this uid (the common Docker
// case — the container user isn't in the host `docker` group). That is a
// permission problem, not an unreachable socket, so it falls through to
// PERM_PATTERNS' `eacces` and the doctor reports `permission-denied` (with the
// `group_add` remediation) instead of the generic "socket unreachable".
const SOCKET_PATTERNS = [
  /ECONNREFUSED/,
  /ENOENT/,
  /connect ENOENT/i,
  /socket hang up/i,
  /EPIPE/,
  /ECONNRESET/,
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

// Rejected-at-create configuration conflicts the daemon reports as a 400 "bad
// parameter". The canonical case (issue #183): Docker forbids combining port
// publishing with a `container:<id>` network mode and returns "conflicting
// options: port publishing and the container type network mode". Classifying
// these distinctly keeps them out of the "unknown" bucket (which surfaces the
// useless "Unexpected error. See logs.") and — because it is NOT a name
// collision — keeps `createAndStart` from mistaking it for a stale-container
// conflict and pointlessly removing + retrying. `userMessage` deliberately
// carries no fix text; the raw daemon string is the actionable part and is
// preserved in `raw`.
const INVALID_CONFIG_PATTERNS = [
  /conflicting options/i,
  /invalid (host)?config/i,
];

// Container-storage corruption (issue #219): a power loss can zero-truncate
// the overlay `link`/`lower` metadata files of layers whose writes were still
// in flight. Every inspect of the affected container then 500s at the daemon
// ("getting graph driver info … readlink …: invalid argument"), while
// force-remove still works — so callers can recover by removing and
// recreating the container. Classification drives that destructive recovery,
// so it is deliberately strict: the daemon must have returned a 500 (keeps
// registry/network texts out) AND the body must match every pattern of one
// group — a graph-driver wrapper alone (which can carry unrelated storage
// errors) is not enough evidence.
const STORAGE_CORRUPT_PATTERN_GROUPS = [
  [/getting graph driver info/i, /readlink .*: invalid argument/i],
  [/layer not known/i],
];

const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;

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

  if (status === HTTP_NOT_FOUND) {
    return { kind: "not-found", userMessage: "Resource not found.", raw };
  }

  if (
    status === HTTP_INTERNAL_SERVER_ERROR &&
    STORAGE_CORRUPT_PATTERN_GROUPS.some((group) =>
      group.every((p) => p.test(raw)),
    )
  ) {
    return {
      kind: "storage-corrupt",
      userMessage:
        "Container storage is corrupt (typically overlay metadata truncated by a power loss). " +
        "Managed containers are removed and recreated automatically; if this persists, run " +
        "`podman system check --repair --force` or remove the container with `podman rm -f <name>`.",
      raw,
    };
  }

  if (SOCKET_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "socket-unreachable",
      userMessage:
        "Container runtime socket unreachable or reset. Check the docker/podman socket is bind-mounted; if it reset mid-request, the runtime may be too old.",
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
  if (INVALID_CONFIG_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "invalid-config",
      userMessage: `Container configuration rejected by the runtime: ${raw}`,
      raw,
    };
  }
  return {
    kind: "unknown",
    userMessage: "Unexpected error. See logs for details.",
    raw,
  };
}

/**
 * Longest raw-runtime-text snippet embedded into a thrown message. Daemon
 * error bodies can run to kilobytes (multi-line OCI/crun dumps); untruncated
 * they make setPluginStatus rows and UI error banners unusable, while the
 * full text stays reachable via `describeError` on the attached cause.
 */
export const RAW_SNIPPET_MAX_LENGTH = 300;

/**
 * Compose a user-facing failure message that keeps the runtime's raw error
 * text visible. For kind "unknown" the `userMessage` is a generic
 * "Unexpected error. See logs for details." — the raw daemon text is the only
 * actionable part, so dropping it leaves the user (and support) with nothing
 * to diagnose. The suffix is skipped when it would duplicate: the
 * `invalid-config` kind embeds `raw` in its `userMessage`. The appended
 * snippet is whitespace-collapsed and truncated to `RAW_SNIPPET_MAX_LENGTH`;
 * callers that need the full text attach the `CategorizedError` as `cause`
 * and read it back via `describeError`.
 */
export function messageWithRaw(userMessage: string, raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed === "" ||
    userMessage.includes(trimmed) ||
    trimmed.includes(userMessage)
  ) {
    return userMessage;
  }
  const collapsed = trimmed.replace(/\s+/g, " ");
  const snippet =
    collapsed.length > RAW_SNIPPET_MAX_LENGTH
      ? `${collapsed.slice(0, RAW_SNIPPET_MAX_LENGTH)}…`
      : collapsed;
  return `${userMessage} (${snippet})`;
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
 * consumer/log. `safeInspect()` rethrows as
 * `Error(messageWithRaw(userMessage, raw), { cause: CategorizedError })` —
 * the message carries a truncated raw snippet, while the untruncated
 * runtime text lives in `cause.raw`. Prefer that raw text when present;
 * fall back to the error's own message for errors thrown directly (not via
 * `safe`).
 */
export function describeError(err: unknown): string {
  if (err instanceof Error && hasRawErrorText(err.cause)) {
    return err.cause.raw;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a caught error is a `safe()`/`safeInspect()` rethrow whose
 * classified cause is `storage-corrupt` — the "this container's overlay
 * metadata is damaged, remove + recreate to recover" family.
 */
export function isStorageCorruptError(err: unknown): boolean {
  return (
    err instanceof Error &&
    typeof err.cause === "object" &&
    err.cause !== null &&
    (err.cause as { kind?: unknown }).kind === "storage-corrupt"
  );
}
