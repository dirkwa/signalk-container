import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  ContainerRuntimeInfo,
  RuntimeName,
  RuntimePreference,
  UserMappingPayload,
} from "./types.js";
import { libpodSubordinateUidCount, resolveClient, safe } from "./client.js";

/**
 * Detect if the Signal K server is itself running inside a container.
 * Indicators:
 * - /.dockerenv file (Docker)
 * - /run/.containerenv file (Podman)
 * - container env var (some setups)
 */
export function isContainerized(): boolean {
  return (
    existsSync("/.dockerenv") ||
    existsSync("/run/.containerenv") ||
    process.env.container !== undefined
  );
}

/**
 * Resolve the effective host user (uid/gid) that managed containers
 * should run as.  Source of truth is the Signal K server's own
 * process — files created inside a container started with `--user
 * <uid>:<gid>` (or `--userns=keep-id` on rootless Podman) end up
 * owned by this same identity on the host, so a chmod sweep is no
 * longer necessary.
 *
 * Returns `null` on platforms where `process.getuid`/`process.getgid`
 * are undefined (Windows); the upcoming ownership translator must
 * suppress `--user` flags in that case.
 */
export function probeHostUser(): { uid: number; gid: number } | null {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return null;
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

/**
 * Host UID/GID resolver indirection so unit tests can stub it instead
 * of being at the mercy of whoever runs `npm test` (root in CI vs.
 * 1000 on a dev box). Windows has no UID concept and
 * `process.getuid` is undefined there — falls back to `null` and the
 * flag emitter then skips the mapping.
 */
let currentHostIds: () => { uid: number; gid: number } | null = probeHostUser;

/**
 * Test-only override for the host UID/GID resolver. Stubs let unit
 * tests assert flag emission against deterministic UIDs without
 * needing a particular runtime user.
 */
export function _setCurrentHostIdsForTesting(
  fn: (() => { uid: number; gid: number } | null) | null,
): void {
  currentHostIds = fn ?? probeHostUser;
}

/**
 * Module-level "skip user-namespace remapping" toggle. When `true`,
 * `userMappingFlags()` suppresses the rootless-Podman `--userns=keep-id`
 * flag and emits no flag at all on that branch (the in-image root then
 * maps to the host caller via the default rootless userns).
 *
 * Set from the plugin config (`disableUserNamespaceRemap`) for hosts
 * where the kernel cannot id-map the bind-mount backing filesystem and
 * `--userns=keep-id` aborts at container create time with
 * `crun: writing file /proc/<pid>/gid_map: Invalid argument`. ZFS is
 * the common case (`idmapped mounts` support is filesystem-specific
 * and kernel-version-dependent); some encrypted filesystems behave
 * the same way.
 */
let usernsRemapDisabled = false;

/**
 * Apply the plugin-config "disable user-namespace remap" toggle.
 * Called from `plugin.start()` whenever the config is (re)read.
 * Defaults to `false` so existing deployments keep the historical
 * keep-id behaviour verbatim.
 */
export function setDisableUserns(disabled: boolean): void {
  usernsRemapDisabled = disabled === true;
}

/**
 * Read the current "disable user-namespace remap" toggle. Exposed
 * for tests; consumer code should not need to call this directly.
 */
export function isDisableUserns(): boolean {
  return usernsRemapDisabled;
}

/**
 * Shape shared by `ContainerJobConfig.user` and `ContainerConfig.user`.
 * Inline-typed rather than imported to keep `runtime.ts` free of
 * `types.ts` imports (it's the lowest layer).
 */
type UserMappingIntent =
  { inImageUid?: number; inImageGid?: number } | false | undefined;

/**
 * Build the UID-mapping flags to pass to the runtime for one
 * container. Used by both `runJob` (one-shot helpers) and
 * `buildRunArgs` (long-running managed containers) so the decision
 * matrix is identical across both code paths.
 *
 * The decision matrix:
 *
 *   - `user === false` → no flag. Caller opted out (debugging, or the
 *     container doesn't write to a host-owned bind mount).
 *   - host UID resolver returns null (Windows) → no flag. Docker
 *     Desktop / Windows handles UID translation internally.
 *   - rootless Podman with `disableUserNamespaceRemap` active → no
 *     flag. Used on hosts whose backing filesystem refuses kernel
 *     idmapped mounts (ZFS being the canonical case). Container runs
 *     in the default rootless userns; for root-by-default images
 *     (`inImageUid === 0`) bind-mount file ownership still lands on
 *     the host caller. Non-root in-image images give up host-caller
 *     ownership in exchange for being able to start at all.
 *   - rootless Podman → `HostConfig.UsernsMode = "keep-id:uid=<inImageUID>,gid=<inImageGID>"`.
 *     Rewrites the in-image UID back to the host caller via the user-
 *     namespace mapping. (keep-id is meaningless under rootful Podman —
 *     there is no user namespace to map into, so podman silently no-ops
 *     it and the container runs as in-image root with host files owned
 *     by root; we therefore use `User` on the rootful branches to get
 *     caller ownership.)
 *   - Docker / rootful Podman, caller declared a `user` object →
 *     `User = "<inImageUID>:<inImageGID>"`. Direct process-UID override
 *     so the in-container process matches the image's USER directive.
 *     No namespace remap is available on this branch, so bind-mounted
 *     host files keep their host-side ownership and must be readable
 *     by the in-image UID for the in-container process to use them.
 *     Callers needing to deliver host-owned secrets to a non-root
 *     in-image UID should pass them via `env` instead of bind mounts.
 *   - Docker / rootful Podman, caller omitted `user` →
 *     `User = "<hostUID>:<hostGID>"`. Sets the in-container process UID
 *     to the host caller's UID so files created on bind mounts land
 *     owned by the same identity on the host. Implicit assumption is
 *     that the image's USER directive is root (or absent).
 *
 * `inImageUID/GID` defaults to 0 when the caller doesn't pass them —
 * matching the historical behaviour of helper images shipped before
 * this field existed (osgeo/gdal, the legacy tippecanoe image, …).
 * Images with a non-root `USER` directive (e.g. `charts-toolbox`'s
 * `USER toolbox` at UID 1001, mayara's `USER mayara` at UID 1000) need
 * the caller to declare the right value.
 */
export function userMappingFlags(
  runtime: ContainerRuntimeInfo,
  user: UserMappingIntent,
  resolveHost: () => { uid: number; gid: number } | null = currentHostIds,
): UserMappingPayload {
  if (user === false) {
    return {};
  }
  const host = resolveHost();
  if (host === null) {
    return {};
  }
  const inImageUid = user?.inImageUid ?? 0;
  const inImageGid = user?.inImageGid ?? 0;
  // Reject negatives, NaN, and non-integers. The TS shape says
  // `number` but JS callers can still pass garbage — emitting
  // `keep-id:uid=NaN,gid=-1` would let podman produce an obscure
  // runtime error far from the call site. Throw here so the consumer
  // plugin's promise rejects with a clear message before the container
  // even starts.
  assertNonNegativeInt("inImageUid", inImageUid);
  assertNonNegativeInt("inImageGid", inImageGid);

  if (runtime.runtime === "podman" && runtime.isRootless === true) {
    if (usernsRemapDisabled) {
      return {};
    }
    // `keep-id:uid=N` asks podman for a 65536-wide subordinate block. On an
    // account whose /etc/subuid allocation is narrower, podman clamps the
    // length — and at the limit clamps it to zero, which the kernel rejects
    // with `writing file /proc/<pid>/gid_map: Invalid argument`. Bounding
    // the request to the width podman reports keeps the mapping valid.
    // `size` is omitted when the width is unknown (Docker, older podman, a
    // failed probe) so the default behaviour is untouched.
    const size = runtime.subordinateUidCount;
    const bound = typeof size === "number" && size > 0 ? `size=${size},` : "";
    return {
      HostConfig: {
        UsernsMode: `keep-id:${bound}uid=${inImageUid},gid=${inImageGid}`,
      },
    };
  }
  // Docker / rootful Podman: no user-namespace remap, so `User` is a
  // direct process-UID override. When the caller declared an in-image
  // UID/GID, honour it so the in-container process matches the image's
  // USER directive — the caller is responsible for any bind-mount
  // ownership story (e.g. deliver credentials via env vars instead of
  // bind-mounted secret files). When the caller omitted `user`, fall
  // back to the host caller's UID so files created on bind mounts land
  // owned by the same identity on the host.
  if (user !== undefined) {
    return { User: `${inImageUid}:${inImageGid}` };
  }
  return { User: `${host.uid}:${host.gid}` };
}

function assertNonNegativeInt(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `user.${field} must be a non-negative integer, got ${String(value)}`,
    );
  }
}

/**
 * Classify the daemon behind a socket as podman or docker from its
 * `version()` payload. Podman's response carries a `Podman Engine`
 * component (and/or a `Platform.Name` mentioning podman); a docker (or
 * docker-compat) daemon does not. Defaults to docker when neither
 * marker is present — the conservative choice, since the docker `User`
 * mapping path is the broader one.
 */
function classifyRuntime(version: {
  Components?: Array<{ Name?: string }>;
  Platform?: { Name?: string };
}): RuntimeName {
  const components = version.Components ?? [];
  if (components.some((c) => /podman/i.test(c.Name ?? ""))) return "podman";
  if (version.Platform?.Name && /podman/i.test(version.Platform.Name)) {
    return "podman";
  }
  return "docker";
}

/**
 * Shape of the fields we read off `info()`. The daemon answers ONE JSON
 * object regardless of whether it's podman-native, podman's
 * docker-compat endpoint, or real docker — so we probe BOTH keyspaces:
 * podman exposes `host.security.rootless` and `host.cgroupControllers`;
 * the docker-compat / docker shape exposes `SecurityOptions`.
 */
interface DaemonInfo {
  /**
   * Podman's docker-compat `/info` exposes a top-level `Rootless`
   * boolean. (Podman's NATIVE `/libpod/info` shape with
   * `host.security.rootless` is NOT what dockerode reaches — dockerode
   * always hits the docker-compat endpoint — so we read `Rootless` and
   * `SecurityOptions`, the keys the compat shape actually returns.
   * Verified live: rootless podman 5.4.2 over its socket reports
   * `Rootless: true` and `SecurityOptions: [...,"name=rootless"]`, while
   * `host.security.rootless` comes back `undefined`.)
   */
  Rootless?: boolean;
  SecurityOptions?: string[];
  /**
   * CPU count as the daemon sees it. Both docker and podman's compat
   * `/info` report it. Read so `resources.ts` can cap `cpus` requests
   * Docker would otherwise reject at create time (issue: a 1.5-core default
   * on a 1-vCPU Docker host fails with "range of CPUs is from 0.01 to
   * 1.00").
   */
  NCPU?: number;
}

/**
 * Detect rootless mode from `info()`. Rootless matters for Podman
 * because `HostConfig.UsernsMode: "keep-id"` only does anything when
 * there's a user namespace to map into (rootless). Under rootful podman
 * keep-id silently no-ops and the container runs as root with
 * root-owned bind-mount files — so a WRONG rootless reading is a quiet
 * ownership bug, not a loud failure, which makes this probe
 * correctness-critical.
 *
 * Reads the docker-compat `/info` keys (the only ones dockerode reaches):
 *   - `Rootless` boolean (podman sets it directly)
 *   - `SecurityOptions` containing a `name=rootless` entry (rootless
 *     podman lists it; docker lists `name=cgroupns` etc. but not
 *     rootless)
 * `null` stays advisory ("not probed") — treated as not-rootless by the
 * userns matrix, the safe default for docker.
 */
/**
 * Daemon CPU count from `/info`, or `null` when absent or not a positive
 * finite number (a daemon that omits it, or a stubbed `info()` in tests).
 * `null` means "unknown" downstream: no clamping, same as before this
 * field existed.
 */
export function hostCpusFromInfo(info: DaemonInfo): number | null {
  const n = info.NCPU;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  return null;
}

function rootlessFromInfo(info: DaemonInfo): boolean | null {
  if (typeof info.Rootless === "boolean") return info.Rootless;
  if (Array.isArray(info.SecurityOptions)) {
    return info.SecurityOptions.some((o) => /\brootless\b/.test(o));
  }
  return null;
}

/**
 * cgroup v2 controllers available to the runtime, read from the kernel
 * (`/sys/fs/cgroup/cgroup.controllers`) rather than `info()`. dockerode
 * reaches podman's docker-compat `/info`, which does NOT expose
 * `CgroupControllers` (verified live: `host.cgroupControllers` comes
 * back `undefined`), so the filesystem is the only reliable source.
 * Returns the controller names, or `null` on any read failure (cgroup
 * v1, non-Linux, restricted mount) — `null` means "not probed", and
 * `resources.ts` then gates nothing, matching the historical default.
 *
 * Only meaningful for podman: rootless podman commonly has delegation
 * for `cpu memory pids` but not `cpuset`. Docker runs with full
 * delegation, so we return `null` there (treat all as available).
 *
 * Which file answers depends on where the containers land. Inside a
 * container the root file is the container's own cgroup (cgroupns), so
 * it lists exactly what was delegated. On a bare-metal host it lists
 * every kernel controller, while rootless podman creates its containers
 * under the caller's user manager (`user@<uid>.service`) and can only
 * use what systemd delegated to that unit — `Delegate=pids memory` on
 * systemd < 252, no `cpu`. Asking crun for a controller that is not
 * there fails container creation outright ("the requested cgroup
 * controller `cpu` is not available"), so for rootless podman the user
 * manager's file is read first and the root file is the fallback.
 */
export async function probeCgroupControllers(
  runtime: RuntimeName,
  rootless: boolean | null,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
  uid: number | undefined = process.getuid?.(),
): Promise<string[] | null> {
  if (runtime !== "podman") return null;
  const candidates: string[] = [];
  if (rootless && uid !== undefined) {
    candidates.push(
      `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
    );
  }
  candidates.push("/sys/fs/cgroup/cgroup.controllers");
  for (const path of candidates) {
    try {
      const raw = await read(path);
      const controllers = raw.trim().split(/\s+/).filter(Boolean);
      if (controllers.length > 0) return controllers;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Resolve the container runtime by finding a socket that answers the
 * Docker API and reading its `version()`/`info()`. Replaces the old
 * binary-probe (`podman --version` / `docker --version`) detection.
 *
 * The `ContainerRuntimeInfo` shape is preserved so every consumer and
 * the diff logic are untouched; only the SOURCE of each field changes
 * from CLI-template parsing to JSON field access. `preference` biases the
 * socket pick order so `PluginConfig.runtime = "docker" | "podman"` is
 * honoured on a host where both endpoints are reachable; an explicit
 * endpoint via `DOCKER_HOST`/`CONTAINER_HOST` always wins (see
 * `client.ts`).
 */
/**
 * `--userns=keep-id:size=` landed in Podman 5.4.0 (containers/podman#24387);
 * 5.3 and earlier reject the whole option, so emitting it there would break
 * container creation on an install that works today. Unparseable versions
 * are treated as too old — the bound is an optimisation, and going without
 * it is the long-standing behaviour.
 */
/** First Podman release accepting `--userns=keep-id:size=` (#24387). */
const KEEP_ID_SIZE_MIN = { major: 5, minor: 4 };

/**
 * `major.minor` of a runtime version string, or null when it is not one.
 *
 * Podman reports SemVer (`6.1.0`, `6.1.0-rc.1`, occasionally two components),
 * so a prerelease or build suffix parses and trailing junk does not:
 * `6.1.0garbage`, `6.1.0-` and `6.1.0+` are rejected rather than read as
 * 6.1. Every caller treats null as "too old", so an unreadable version costs
 * a capability rather than wrongly claiming one.
 */
function parseMajorMinor(
  version: string | null,
): { major: number; minor: number } | null {
  if (!version) return null;
  const m = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function atLeast(
  version: string | null,
  min: { major: number; minor: number },
): boolean {
  const v = parseMajorMinor(version);
  if (!v) return false;
  return v.major > min.major || (v.major === min.major && v.minor >= min.minor);
}

export function supportsKeepIdSize(version: string | null): boolean {
  return atLeast(version, KEEP_ID_SIZE_MIN);
}

/**
 * Podman's Docker-compat `/containers/create` accepts
 * `Mounts[].VolumeOptions.Subpath` on every version, but only applies it on
 * newer ones: measured ignored on 5.4.2 and honoured on 6.1.0, where inspect
 * also echoes it back as `SubPath`.
 *
 * The exact release in between is unverified, so this is deliberately a
 * "known to honour" bound rather than a precise one — it gates a test's
 * expectation, not plugin behaviour. Both measurements are x86_64; arm64 is
 * assumed to match (the endpoint is architecture-independent Go) but has not
 * been measured, and the canary reports the truth wherever it runs. The plugin never sends a subpath on any
 * version, so `assertVolumeIsNotBroaderThanRequested` stays correct either
 * way; what changes is only whether narrowing *could* work.
 */
/** First Podman release measured to apply a compat-API volume subpath. */
const VOLUME_SUBPATH_MIN = { major: 6, minor: 1 };

export function honoursVolumeSubpath(version: string | null): boolean {
  return atLeast(version, VOLUME_SUBPATH_MIN);
}

export async function detectRuntime(
  preference: RuntimePreference,
): Promise<ContainerRuntimeInfo | null> {
  const resolved = await resolveClient(preference);
  if (!resolved) return null;
  const { client, socketPath } = resolved;

  const versionResult = await safe(() => client.version());
  if (!versionResult.ok) return null;
  const version = versionResult.value as {
    Version?: string;
    Components?: Array<{ Name?: string }>;
    Platform?: { Name?: string };
  };

  const runtime = classifyRuntime(version);

  const infoResult = await safe(() => client.info());
  const info: DaemonInfo = infoResult.ok
    ? (infoResult.value as DaemonInfo)
    : {};

  const isRootless = rootlessFromInfo(info);
  return {
    runtime,
    version: version.Version ?? "unknown",
    isPodmanDockerShim: false,
    cgroupControllers: await probeCgroupControllers(runtime, isRootless),
    subordinateUidCount:
      runtime === "podman" &&
      isRootless &&
      supportsKeepIdSize(version.Version ?? null)
        ? await libpodSubordinateUidCount(client)
        : null,
    hostCpus: hostCpusFromInfo(info),
    isRootless,
    hostUser: probeHostUser(),
    socketPath,
    isContainerized: isContainerized(),
  };
}

/**
 * Buffered line splitter for stdout/stderr chunks.  Returns a function
 * that takes raw chunk strings and emits complete lines, holding partial
 * data across calls so a line split across two `data` events is not
 * truncated.  Treats `\r\n`, bare `\n`, and bare `\r` as line terminators
 * — tools like tippecanoe repaint a progress line in place using bare
 * `\r`, and a naive `split("\n")` would silently swallow every update
 * after the first.  Empty lines are dropped.  Call the returned `flush`
 * helper after the stream ends to emit any trailing partial data.
 */
export function makeLineSplitter(emit: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.length > 0) emit(part);
      }
    },
    flush() {
      if (buffer.length > 0) {
        emit(buffer);
        buffer = "";
      }
    },
  };
}

/**
 * Handle returned by `tailContainerLogs`. The caller MUST call `stop()`
 * when done — a follow-mode log stream does not end on its own.
 */
export interface StreamingProcessHandle {
  /** Stop the stream by destroying the underlying Readable; idempotent. */
  stop(): void;
  /** Always `undefined` for the dockerode log stream (a socket stream has
   *  no process). Retained on the interface for debug logging only. */
  pid: number | undefined;
  /** True when the stream could not be established (e.g. the logs API
   *  call rejected). The log-stream broker checks THIS rather than
   *  `pid === undefined` to decide a tail failed, since dockerode
   *  streams never carry a pid. */
  spawnFailed?: boolean;
}
