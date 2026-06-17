import { readFile, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { PassThrough } from "node:stream";
import type {
  ContainerConfig,
  ContainerRuntimeInfo,
  RuntimeName,
  RuntimePreference,
  SelfDeploymentResult,
  SelfDeploymentStatus,
  SetupSnippetFormat,
  SetupSnippetResult,
} from "./types.js";
import { findSelfContainerId, qualifyImage } from "./containers.js";
import { isContainerized, userMappingFlags } from "./runtime.js";
import {
  type ContainerClient,
  type ResolvedClient,
  getClient,
  resolveClient,
  safe,
} from "./client.js";
import type { ErrorKind } from "./errors.js";

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
  client: ContainerClient = getClient(),
): Promise<ImageProbeResult> {
  const userMapping = userMappingFlags(runtime, user);
  const createOpts: import("dockerode").ContainerCreateOptions = {
    Image: qualifyImage(image, runtime),
    Cmd: ["sh", "-c", "touch /tmp/x && echo ok"],
    HostConfig: { AutoRemove: false },
  };
  if (userMapping.User) createOpts.User = userMapping.User;
  if (userMapping.HostConfig?.UsernsMode) {
    createOpts.HostConfig!.UsernsMode = userMapping.HostConfig.UsernsMode;
  }
  try {
    const r = await runProbeContainer(client, createOpts);
    const output = r.output;
    if (r.exitCode !== 0) {
      return {
        ok: false,
        output,
        error: `Container exited with code ${r.exitCode}`,
      };
    }
    if (!output.includes("ok")) {
      return {
        ok: false,
        output,
        error: "Probe exited 0 but did not print 'ok'; touch likely failed",
      };
    }
    return { ok: true, output };
  } catch (err) {
    return {
      ok: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create, run-to-completion, and tear down a throwaway probe container,
 * returning its exit code and combined stdout+stderr. The image-compliance
 * probe is the only caller; it needs the container's output and exit code,
 * not a long-lived handle.
 *
 * The logs stream is attached in follow mode BEFORE `start()` so no early
 * output is lost, and demuxed via `modem.demuxStream` — a non-TTY container's
 * logs are multiplexed (8-byte stdout/stderr frame headers) and reading the
 * raw bytes would leak that framing into `output`. Both demuxed sides feed one
 * combined text buffer because the probe only checks for the `"ok"` token
 * regardless of which stream it landed on. Force-remove runs unconditionally
 * (via `safe`, so a TOCTOU 404 doesn't mask the real result).
 */
async function runProbeContainer(
  client: ContainerClient,
  opts: import("dockerode").ContainerCreateOptions,
): Promise<{ exitCode: number; output: string }> {
  const container = await client.createContainer(opts);
  try {
    let output = "";
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const collect = (chunk: Buffer | string) => {
      output += chunk.toString();
    };
    stdout.on("data", collect);
    stderr.on("data", collect);
    client.modem.demuxStream(stream, stdout, stderr);

    await container.start();
    const waitResult = await safe(() => container.wait());
    const exitCode = waitResult.ok
      ? ((waitResult.value as { StatusCode?: number }).StatusCode ?? 0)
      : 1;
    return { exitCode, output };
  } finally {
    await safe(() => container.remove({ force: true }));
  }
}

/**
 * Probe-injection bag for `selfDeployment`. Production omits the arg
 * and the real helpers are used; tests pass fakes so no real podman /
 * docker / filesystem access happens.
 */
export interface SelfDeploymentProbes {
  isContainerized?: () => boolean;
  /**
   * Resolve the dockerode client + its socket path, or `null` when no
   * socket answers. Replaces the CLI-era `findBinary`/`readBinaryVersion`
   * pair: "no runtime" now means "no socket answered the Docker API", not
   * "no binary on PATH". Defaults to the real `resolveClient` from
   * `client.ts`; tests inject a fake to drive the no-socket /
   * socket-reachable branches without a live daemon.
   */
  resolveClient?: () => Promise<ResolvedClient | null>;
  /** Read an env var, returning undefined when unset. */
  readEnv?: (key: string) => string | undefined;
  /**
   * Read the cgroup v2 controllers delegated to the current cgroup
   * (production: `/sys/fs/cgroup/cgroup.controllers`). Returns the list
   * of controller names, or `null` when the file is unreadable
   * (cgroup v1 host, non-Linux, unusual mount layout) — in which case
   * the doctor skips the cgroup status escalation entirely.
   */
  readCgroupControllers?: () => Promise<string[] | null>;
  /**
   * Read the kernel boot cmdline (production: `/proc/cmdline`). Used to
   * detect the `cgroup_disable=memory` Raspberry-Pi-OS-Trixie quirk: the
   * firmware-injected cmdline disables the memory cgroup controller
   * before systemd ever gets a chance to delegate it. systemd's
   * `Delegate=memory` then has nothing to delegate, and the "missing
   * controller" symptom looks identical to plain missing delegation —
   * the systemd-snippet remediation won't help. When this probe returns
   * a cmdline containing the disable token, the remediation block
   * surfaces the cmdline fix instead.
   */
  readKernelCmdline?: () => Promise<string | null>;
  /**
   * Read `/proc/mounts` (or equivalent) as parsed entries. Returns
   * `null` when the file is unreadable (non-Linux, sandboxed). Used by
   * the rootless-Podman storage-driver probe to determine the
   * filesystem backing `~/.local/share/containers` and warn on
   * filesystems known to interact poorly with `--userns=keep-id`.
   */
  readMounts?: () => Promise<MountEntry[] | null>;
  /**
   * Resolve the path of the rootless container-storage root for the
   * current user. Defaults to `$XDG_DATA_HOME/containers` (or
   * `$HOME/.local/share/containers`) — tests can override.
   */
  resolveContainerStoragePath?: () => string | null;
  /**
   * List the usernames with systemd linger enabled (production: the
   * entries of `/var/lib/systemd/linger`, one file per lingering user).
   * Returns `"absent"` when the directory does not exist — systemd
   * creates it on the first `enable-linger`, so on a bare-metal host
   * absence means "nobody lingers", while inside a container it means
   * the host directory simply isn't bind-mounted in. Returns `null` on
   * any other read error (unreadable, non-Linux).
   */
  readLingerDir?: () => Promise<string[] | "absent" | null>;
  /**
   * Resolve the username whose linger file to look for. Defaults to
   * `os.userInfo().username`; only consulted on bare-metal (inside a
   * container the in-container username says nothing about the host
   * user owning the runtime).
   */
  resolveLingerUser?: () => string | null;
}

/**
 * One row from `/proc/mounts`. Only the fields the doctor cares about.
 */
export interface MountEntry {
  /** Mount point. */
  mountPoint: string;
  /** Filesystem type token. */
  fstype: string;
}

/**
 * cgroup v2 controllers whose absence escalates the deployment status to
 * `cgroup-controllers-incomplete`. `cpu` backs `cpus`/`cpuShares`,
 * `memory` backs `memory`/`memorySwap`/`memoryReservation`, `pids` backs
 * `pidsLimit`. Missing any of these means the corresponding limit fields
 * are silently dropped by `filterUnsupportedLimits` in resources.ts — a
 * real bug worth surfacing.
 *
 * `cpuset` is intentionally NOT here even though it backs `cpusetCpus`:
 * rootless Podman never delegates `cpuset` to the user slice (systemd's
 * default `Delegate=` for `user@.service` is `cpu cpuset io memory pids`
 * at the root, but the cpuset controller does not propagate down to
 * `user-<uid>.slice` on any current kernel/systemd). Requiring it would
 * fire a permanent false positive on every healthy rootless deployment.
 * If a user actually sets `cpusetCpus` while `cpuset` is unavailable,
 * `filterUnsupportedLimits` already drops just that one field with a
 * logged reason — so excluding it here loses no safety; it only stops
 * the spurious status escalation. (cpuset pinning is also a niche knob;
 * rootless users effectively cannot use it.)
 *
 * `io` is also NOT here even though the remediation snippet recommends
 * delegating it: no `ContainerResourceLimits` field maps to the io
 * controller, so `io` missing causes no silent-drop bug. We still
 * recommend delegating both in the remediation text because
 * `cpu cpuset io memory pids` is the standard systemd delegate set and
 * operators are likely to look it up; deviating would just look like an
 * unexplained omission.
 */
const EXPECTED_CGROUP_CONTROLLERS = ["cpu", "memory", "pids"];

/**
 * Filesystem types where rootless Podman's default `overlay` storage
 * driver triggers Podman's per-file `chown` sweep
 * (`storage-chown-by-maps`) on first `--userns=keep-id` use. ZFS is
 * the common case; CoW metadata makes the chown sweep catastrophically
 * slow and on some kernels the gid_map write fails outright. Hosts on
 * one of these filesystems should switch to `fuse-overlayfs` (which
 * stores virtual ownership in xattrs) or disable the keep-id mapping
 * via signalk-container's `disableUserNamespaceRemap` setting.
 *
 * Not exhaustive — operators can hit similar issues on encrypted
 * filesystems and some bcachefs configurations. The list captures
 * what's reported often enough to be worth proactive remediation.
 */
const IDMAP_HAZARD_FSTYPES = new Set(["zfs"]);

// Podman below this is old enough that its docker-compat socket has known
// instabilities — notably resetting the connection (write EPIPE) on a large
// `createContainer` body, which breaks big helper jobs (e.g. chart
// conversions). Advisory only; we never escalate status for it.
const PODMAN_MIN_RECOMMENDED = { major: 4, minor: 5 };

const REMEDIATION_OLD_PODMAN = [
  "Podman is older than 4.5; its docker-compat API can reset the socket on large helper-job requests (e.g. converting big chart bundles fails with 'write EPIPE').",
  "Upgrade Podman to >= 4.5 (ideally 5.x). On Debian/Ubuntu this usually means a backports or OBS/Kubic repo; on Fedora/RHEL a dnf update.",
];

// Parse the leading `major.minor` from a version string like "4.3.1" or
// "5.4.2-dev". Returns null when it doesn't start with two dot-separated ints.
function parseMajorMinor(
  version: string | null,
): { major: number; minor: number } | null {
  if (!version) return null;
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// True when `v` is strictly below the `floor` major.minor.
function isBelow(
  v: { major: number; minor: number },
  floor: { major: number; minor: number },
): boolean {
  return (
    v.major < floor.major || (v.major === floor.major && v.minor < floor.minor)
  );
}

const REMEDIATION_IDMAP_HAZARD = [
  "Rootless Podman storage appears to live on a filesystem that interacts poorly with --userns=keep-id (Podman has to chown every image file via storage-chown-by-maps).",
  "Primary fix: switch the rootless storage driver to fuse-overlayfs (virtual ownership via xattrs, no chown sweep).",
  "  ~/.config/containers/storage.conf:",
  "    [storage]",
  '    driver = "overlay"',
  "    [storage.options.overlay]",
  '    mount_program = "/usr/bin/fuse-overlayfs"',
  "  Then: podman system reset && podman system migrate",
  "  (the fuse-overlayfs binary ships in most distros' fuse-overlayfs package).",
  "Secondary fix: enable signalk-container's 'Disable user-namespace remap' setting to drop --userns=keep-id. Root-by-default images keep correct bind-mount ownership; non-root images give up host-caller ownership.",
];

const LINGER_DIR = "/var/lib/systemd/linger";

const REMEDIATION_NO_LINGER = [
  "systemd linger is not enabled for the user owning the rootless container runtime.",
  "Without linger that user's systemd instance only runs while the user is logged in: after a reboot of a headless host, the runtime socket and any containers with a restart policy stay down until someone logs in (or Signal K itself is started some other way).",
  "Enable it once on the host, as the SK-owning user (requires root):",
  '  sudo loginctl enable-linger "$USER"',
  `Verify: ls ${LINGER_DIR}   # a file named after the user should exist`,
];

async function defaultReadLingerDir(): Promise<string[] | "absent" | null> {
  try {
    return await readdir(LINGER_DIR);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : null;
  }
}

function defaultResolveLingerUser(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

/**
 * Probe systemd linger for the rootless-runtime user. Callers gate on
 * "daemon reachable AND rootless" — rootful runtimes are system
 * services and never need linger. Returns `null` when the linger state
 * isn't visible (unreadable dir, or containerized without the host's
 * linger directory bind-mounted in) so the advisory can't false-fire.
 */
async function probeLinger(
  containerized: boolean,
  readLingerDir: () => Promise<string[] | "absent" | null>,
  resolveLingerUser: () => string | null,
): Promise<SelfDeploymentResult["linger"]> {
  const entries = await readLingerDir();
  if (entries === null) return null;
  if (entries === "absent" && containerized) return null;
  const user = containerized ? null : resolveLingerUser();
  // Bare-metal with an unresolvable username: another user's linger
  // entry says nothing about ours, so the state is unknown, not a
  // finding. The any-entry fallback is reserved for the containerized
  // case where no username can exist.
  if (!containerized && user === null) return null;
  const enabled =
    entries === "absent"
      ? false
      : user !== null
        ? entries.includes(user)
        : entries.length > 0;
  return {
    user,
    enabled,
    advice: enabled ? [] : [...REMEDIATION_NO_LINGER],
  };
}

/**
 * Choose the most-specific mount entry that covers `path`. `/proc/mounts`
 * lists mounts in mount order; the deepest mount whose `mountPoint` is
 * a prefix of `path` is the effective backing mount.
 */
function findCoveringMount(
  mounts: MountEntry[],
  path: string,
): MountEntry | null {
  let best: MountEntry | null = null;
  for (const entry of mounts) {
    if (entry.mountPoint === "/" || path === entry.mountPoint) {
      if (!best || entry.mountPoint.length >= best.mountPoint.length) {
        best = entry;
      }
      continue;
    }
    const prefix = entry.mountPoint.endsWith("/")
      ? entry.mountPoint
      : entry.mountPoint + "/";
    if (path.startsWith(prefix)) {
      if (!best || entry.mountPoint.length > best.mountPoint.length) {
        best = entry;
      }
    }
  }
  return best;
}

async function defaultReadMounts(): Promise<MountEntry[] | null> {
  try {
    const raw = await readFile("/proc/mounts", "utf8");
    const entries: MountEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      // `device mountpoint fstype options ...` — fields are
      // whitespace-separated, mountpoint may contain octal escapes
      // (`\040` for space). We only need mountpoint and fstype.
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      entries.push({
        mountPoint: parts[1].replace(/\\040/g, " "),
        fstype: parts[2],
      });
    }
    return entries;
  } catch {
    return null;
  }
}

function defaultResolveContainerStoragePath(): string | null {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return `${xdg}/containers`;
  const home = process.env.HOME;
  if (home) return `${home}/.local/share/containers`;
  return null;
}

/**
 * Probe the filesystem backing the rootless Podman storage root. Only
 * meaningful for rootless Podman; callers gate before invoking.
 * Returns `null` when the mount list or storage path can't be
 * determined (non-Linux, sandboxed read of /proc/mounts, etc.).
 */
async function probeContainerStorage(
  readMounts: () => Promise<MountEntry[] | null>,
  resolveStoragePath: () => string | null,
): Promise<SelfDeploymentResult["containerStorage"]> {
  const storagePath = resolveStoragePath();
  if (!storagePath) return null;
  const mounts = await readMounts();
  if (!mounts) return null;
  const covering = findCoveringMount(mounts, storagePath);
  const fstype = covering?.fstype ?? null;
  const idmapHazard = fstype !== null && IDMAP_HAZARD_FSTYPES.has(fstype);
  return {
    storagePath,
    fstype,
    idmapHazard,
    advice: idmapHazard ? [...REMEDIATION_IDMAP_HAZARD] : [],
  };
}

/**
 * Diagnose whether this Signal K deployment can drive the container
 * runtime at all, and (when SK is itself containerized) whether the
 * prereqs for the in-container deployment path are met.
 *
 * Algorithm:
 *   1. Note `isContainerized()` (advisory — checks run regardless).
 *   2. Resolve a socket that answers the Docker API (`resolveClient`).
 *      "No runtime" now means "no socket answered", not "no binary on
 *      PATH" — the plugin talks the API, not a CLI.
 *   3. Probe the daemon with `version()` + `info()`; on failure classify
 *      off the `CategorizedError.kind` from `safe()` (socket-unreachable
 *      / permission / etc).
 *   4. When both 2 and 3 succeed AND we're containerized, run the
 *      `findSelfContainerId` cascade.
 *
 * Each failure short-circuits and produces a copy-pasteable
 * `remediation`. Never throws.
 *
 * `client` is a test-injection override that takes precedence over the
 * `resolveClient` probe; production omits it and the resolved socket's
 * client is used. `getClient()` is NOT the default here (unlike the
 * post-detection helpers) because the doctor runs precisely when runtime
 * detection may have failed — eagerly calling `getClient()` would throw
 * before the no-runtime path could report.
 */
export async function selfDeployment(
  preference: RuntimePreference,
  client: ContainerClient | null = null,
  probes: SelfDeploymentProbes = {},
): Promise<SelfDeploymentResult> {
  const probeIsContainerized = probes.isContainerized ?? isContainerized;
  const probeResolveClient = probes.resolveClient ?? resolveClient;
  const probeReadEnv = probes.readEnv ?? ((k) => process.env[k]);
  const probeReadCgroupControllers =
    probes.readCgroupControllers ?? defaultReadCgroupControllers;
  const probeReadKernelCmdline =
    probes.readKernelCmdline ?? defaultReadKernelCmdline;
  const probeReadMounts = probes.readMounts ?? defaultReadMounts;
  const probeResolveStoragePath =
    probes.resolveContainerStoragePath ?? defaultResolveContainerStoragePath;
  const probeReadLingerDir = probes.readLingerDir ?? defaultReadLingerDir;
  const probeResolveLingerUser =
    probes.resolveLingerUser ?? defaultResolveLingerUser;

  const containerized = probeIsContainerized();
  const env = {
    DOCKER_HOST: probeReadEnv("DOCKER_HOST") ?? null,
    CONTAINER_HOST: probeReadEnv("CONTAINER_HOST") ?? null,
    XDG_RUNTIME_DIR: probeReadEnv("XDG_RUNTIME_DIR") ?? null,
  };
  const cgroupControllers = await probeCgroupControllers(
    probeReadCgroupControllers,
    probeReadKernelCmdline,
  );

  // 1. Socket resolution — the first socket that answers the API wins.
  //    No socket → no runtime (was "no binary on PATH" in the CLI era).
  const resolved = await probeResolveClient();
  if (!resolved) {
    return {
      isContainerized: containerized,
      binary: { name: null, path: null, version: null },
      daemon: {
        reachable: false,
        rootless: null,
        // No runtime was detected, so there's no binary kind to key on —
        // surface whichever explicit endpoint the operator configured
        // (CONTAINER_HOST for podman, DOCKER_HOST for docker) as the
        // troubleshooting hint, rather than hardcoding the docker var.
        socketPath: env.CONTAINER_HOST ?? env.DOCKER_HOST ?? null,
        error: "no container runtime socket answered the Docker API",
      },
      env,
      selfId: { value: null, source: null },
      cgroupControllers,
      containerStorage: null,
      linger: null,
      status: "no-runtime",
      remediation: containerized
        ? REMEDIATION_NO_RUNTIME_CONTAINERIZED
        : REMEDIATION_NO_RUNTIME_BARE_METAL,
    };
  }

  // The resolved socket is authoritative for the socket path; an injected
  // `client` only overrides the API channel (tests), not the path.
  const apiClient = client ?? resolved.client;
  const socketPath = resolved.socketPath;

  // 2. Daemon reachability — `version()` + `info()`, classified off the
  //    categorized error rather than CLI stderr substring matching.
  const info = await probeDaemon(apiClient);

  // No version means the socket existed at resolve time but the API call
  // failed — fall back to the inferred env-var name for the binary field.
  const binaryName: RuntimeName = info.runtime ?? "docker";
  const binaryVersion = info.version;

  // Storage-driver / backing-filesystem advisory. Only meaningful for
  // rootless Podman: rootful Podman and Docker do not run the
  // `storage-chown-by-maps` path that the ZFS hazard triggers. Run the
  // probe regardless of `--keep-id` outcome — we want to advise even
  // when the user's containers happen to be working, so they can
  // proactively switch storage before a non-trivial image lands them
  // in the slow path.
  const containerStorage =
    binaryName === "podman" && info.reachable && info.rootless === true
      ? await probeContainerStorage(probeReadMounts, probeResolveStoragePath)
      : null;

  // Linger advisory. Runtime-agnostic but rootless-only: rootless podman
  // AND rootless docker both live in the user's systemd instance, which
  // needs linger to survive headless reboots; rootful daemons are system
  // services. Warning a rootful-Docker operator would be a false positive.
  const linger =
    info.reachable && info.rootless === true
      ? await probeLinger(
          containerized,
          probeReadLingerDir,
          probeResolveLingerUser,
        )
      : null;

  // `binary.path` is null — there is no binary concept over the socket.
  // The field shape is retained (name/version still populated from
  // `version()`) so existing consumers reading the daemon report don't
  // break on the port.
  const baseResult = {
    isContainerized: containerized,
    binary: { name: binaryName, path: null, version: binaryVersion },
    env,
    cgroupControllers,
    containerStorage,
    linger,
  };

  if (!info.reachable) {
    const status = classifyDaemonFailure(info.errorKind);
    return {
      ...baseResult,
      daemon: {
        reachable: false,
        rootless: null,
        socketPath,
        error: info.error ?? "daemon unreachable",
      },
      selfId: { value: null, source: null },
      status,
      remediation: remediationForDaemonFailure(status, binaryName, env),
    };
  }

  // 3. Self-id cascade (containerized only — bare-metal has no notion of self-id).
  let selfId: SelfDeploymentResult["selfId"] = { value: null, source: null };
  if (containerized) {
    const runtimeInfo: ContainerRuntimeInfo = {
      runtime: binaryName,
      version: binaryVersion ?? "unknown",
      isPodmanDockerShim: false,
      isRootless: info.rootless,
    };
    selfId = await resolveSelfIdWithSource(
      runtimeInfo,
      probeReadEnv,
      apiClient,
    );
    if (!selfId.value) {
      return {
        ...baseResult,
        daemon: {
          reachable: true,
          rootless: info.rootless,
          socketPath,
          error: null,
        },
        selfId,
        status: "self-id-unresolved",
        remediation: REMEDIATION_SELF_ID_UNRESOLVED,
      };
    }
  }

  // 4. Cgroup controller delegation (containerized only — bare-metal hosts
  // virtually always have full delegation, and we can't act on it anyway).
  if (containerized && cgroupControllers.missing.length > 0) {
    return {
      ...baseResult,
      daemon: {
        reachable: true,
        rootless: info.rootless,
        socketPath,
        error: null,
      },
      selfId,
      status: "cgroup-controllers-incomplete",
      remediation: remediationCgroupControllers(
        cgroupControllers.missing,
        cgroupControllers.kernelDisabledMemory,
        selfId.value,
      ),
    };
  }

  // Advisory only — an old-but-working Podman still reports `ok`, but we
  // surface the upgrade hint so a future large helper job's EPIPE isn't a
  // mystery. Never escalate status (mirrors the storage-driver advice).
  const podmanVersion = parseMajorMinor(binaryVersion);
  const oldPodmanAdvice =
    binaryName === "podman" &&
    podmanVersion !== null &&
    isBelow(podmanVersion, PODMAN_MIN_RECOMMENDED)
      ? [...REMEDIATION_OLD_PODMAN]
      : [];

  return {
    ...baseResult,
    daemon: {
      reachable: true,
      rootless: info.rootless,
      socketPath,
      error: null,
    },
    selfId,
    status: "ok",
    remediation: oldPodmanAdvice,
  };
}

/**
 * Outcome of the socket daemon probe. `runtime`/`version` come from
 * `version()`; `rootless` from `info()`. On an unreachable daemon
 * `errorKind` carries the categorized failure so `classifyDaemonFailure`
 * can map it to a status without substring-matching CLI stderr.
 */
interface DaemonProbeResult {
  reachable: boolean;
  rootless: boolean | null;
  /** Runtime name from `version()` classification; null when version failed. */
  runtime: RuntimeName | null;
  /** Server version from `version().Version`; null when version failed. */
  version: string | null;
  /** Categorized failure kind; null on a reachable daemon. */
  errorKind: ErrorKind | null;
  /** Human-readable failure message; null on a reachable daemon. */
  error: string | null;
}

/**
 * Fields read off `version()`. Podman's response carries a `Podman Engine`
 * component (and/or a `Platform.Name` mentioning podman); a docker /
 * docker-compat daemon does not.
 */
interface DaemonVersion {
  Version?: string;
  Components?: Array<{ Name?: string }>;
  Platform?: { Name?: string };
}

/**
 * Fields read off the docker-compat `info()`. dockerode always hits the
 * docker-compat endpoint, so podman's NATIVE `host.security.rootless` is
 * NOT reachable here — we read `Rootless` and `SecurityOptions`, the keys
 * the compat shape actually returns (mirrors `rootlessFromInfo` in
 * runtime.ts; rootless podman 5.x reports `Rootless: true` and
 * `SecurityOptions: [...,"name=rootless"]`).
 */
interface DaemonInfo {
  Rootless?: boolean;
  SecurityOptions?: string[];
}

function classifyRuntimeFromVersion(version: DaemonVersion): RuntimeName {
  const components = version.Components ?? [];
  if (components.some((c) => /podman/i.test(c.Name ?? ""))) return "podman";
  if (version.Platform?.Name && /podman/i.test(version.Platform.Name)) {
    return "podman";
  }
  return "docker";
}

function rootlessFromInfo(info: DaemonInfo): boolean | null {
  if (typeof info.Rootless === "boolean") return info.Rootless;
  if (Array.isArray(info.SecurityOptions)) {
    return info.SecurityOptions.some((o) => /\brootless\b/.test(o));
  }
  return null;
}

/**
 * Talk to the daemon over the socket: `version()` decides the runtime
 * name + version and doubles as the reachability check; `info()` yields
 * the rootless flag. Both go through `safe()` so a refused or unreadable
 * socket surfaces as a categorized error, never a throw.
 */
async function probeDaemon(
  client: ContainerClient,
): Promise<DaemonProbeResult> {
  const versionResult = await safe(() => client.version());
  if (!versionResult.ok) {
    return {
      reachable: false,
      rootless: null,
      runtime: null,
      version: null,
      errorKind: versionResult.error.kind,
      error: versionResult.error.raw || versionResult.error.userMessage,
    };
  }
  const version = versionResult.value as DaemonVersion;

  const infoResult = await safe(() => client.info());
  const info: DaemonInfo = infoResult.ok
    ? (infoResult.value as DaemonInfo)
    : {};

  return {
    reachable: true,
    rootless: rootlessFromInfo(info),
    runtime: classifyRuntimeFromVersion(version),
    version: version.Version ?? null,
    errorKind: null,
    error: null,
  };
}

/**
 * Map a categorized daemon-probe failure to a doctor status. The socket
 * answered at resolve time, so the failure is the API call itself: an
 * EACCES on the socket is `permission`; everything else
 * (socket-unreachable, network, unknown) collapses to socket-unreachable
 * because from the operator's seat the daemon is simply not responding.
 */
function classifyDaemonFailure(kind: ErrorKind | null): SelfDeploymentStatus {
  if (kind === "permission") return "permission-denied";
  return "socket-unreachable";
}

/**
 * Production default for the cgroup-controllers probe. Reads cgroup v2's
 * `/sys/fs/cgroup/cgroup.controllers`, returning the space-separated
 * controller names. Returns `null` on any read failure (cgroup v1 host,
 * non-Linux, unusual mount layout) — never throws.
 */
async function defaultReadCgroupControllers(): Promise<string[] | null> {
  try {
    const raw = await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8");
    return raw.trim().split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Production default for the kernel-cmdline probe. Reads `/proc/cmdline`,
 * returning the single-line contents. Returns `null` on any read failure
 * (non-Linux, restricted /proc) — never throws.
 */
async function defaultReadKernelCmdline(): Promise<string | null> {
  try {
    const raw = await readFile("/proc/cmdline", "utf8");
    return raw.trim();
  } catch {
    return null;
  }
}

/**
 * Detect whether the kernel was booted with the memory cgroup controller
 * explicitly disabled. True when `cgroup_disable=memory` appears in the
 * cmdline AND there is NO later `cgroup_enable=memory` overriding it.
 * (Kernel parameters are evaluated left-to-right, so a later occurrence
 * wins.) The Raspberry Pi OS Trixie firmware injects the disable token
 * for legacy reasons; appending `cgroup_enable=memory cgroup_memory=1`
 * to `/boot/firmware/cmdline.txt` is how you flip it back without
 * touching the firmware blob.
 */
function isKernelMemoryDisabled(cmdline: string | null): boolean {
  if (!cmdline) return false;
  const disableIdx = cmdline.lastIndexOf("cgroup_disable=memory");
  if (disableIdx < 0) return false;
  const enableIdx = cmdline.lastIndexOf("cgroup_enable=memory");
  return enableIdx <= disableIdx;
}

/**
 * Run the cgroup-controllers probe and compute the missing set against
 * `EXPECTED_CGROUP_CONTROLLERS`. When the controllers probe returns
 * `null`, missing is `[]` — we won't escalate status on a host we can't
 * inspect. The cmdline probe runs in parallel and feeds the
 * `kernelDisabledMemory` flag for the remediation block.
 */
async function probeCgroupControllers(
  readControllers: () => Promise<string[] | null>,
  readKernelCmdline: () => Promise<string | null>,
): Promise<SelfDeploymentResult["cgroupControllers"]> {
  const [available, cmdline] = await Promise.all([
    readControllers(),
    readKernelCmdline(),
  ]);
  const kernelDisabledMemory = isKernelMemoryDisabled(cmdline);
  if (available === null) {
    return { available: null, missing: [], kernelDisabledMemory };
  }
  const have = new Set(available);
  const missing = EXPECTED_CGROUP_CONTROLLERS.filter((c) => !have.has(c));
  return { available, missing, kernelDisabledMemory };
}

/**
 * Remediation block for `cgroup-controllers-incomplete`. The cause has
 * two distinct shapes; the operator needs different fixes for each.
 *
 *   1. Kernel was booted with `cgroup_disable=memory` (Raspberry Pi OS
 *      Trixie default). The memory controller never reaches systemd, so
 *      `Delegate=memory` does nothing. Fix is in the boot cmdline.
 *
 *   2. Kernel has the memory controller but the user@.service hasn't
 *      been told to delegate it. Fix is the systemd Delegate= snippet.
 *
 * We detect the kernel-level shape from /proc/cmdline and surface the
 * correct fix; otherwise the systemd-level fix is the default.
 */
function remediationCgroupControllers(
  missing: string[],
  kernelDisabledMemory: boolean,
  selfContainerId: string | null,
): string[] {
  // Operators paste these commands verbatim, so substitute the real
  // container reference for the placeholder. A full 64-hex id is
  // shortened to the conventional 12 chars; a name passes through.
  const self =
    selfContainerId === null
      ? "<sk-container>"
      : /^[0-9a-f]{64}$/.test(selfContainerId)
        ? selfContainerId.slice(0, 12)
        : selfContainerId;
  if (kernelDisabledMemory) {
    return [
      `Signal K is containerized and the kernel was booted with cgroup_disable=memory (common on Raspberry Pi OS Trixie — the GPU firmware injects this token).`,
      "Until the memory controller is enabled at the kernel level, systemd's Delegate=memory has nothing to delegate, and consumer-plugin memory limits are silently dropped.",
      "",
      "Enable the memory controller in the kernel cmdline (one-time, requires root):",
      "  sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak.$(date +%Y%m%d)",
      "  sudo sed -i 's/$/ cgroup_enable=memory cgroup_memory=1/' /boot/firmware/cmdline.txt",
      "  # Note: /boot/firmware/cmdline.txt must remain a single line — verify with `wc -l`.",
      "",
      "Reboot the host to pick up the new cmdline:",
      "  sudo reboot",
      "",
      "After reboot, the memory controller will appear in /sys/fs/cgroup/cgroup.controllers and systemd's Delegate=memory will start working.",
      "If systemd's Delegate= isn't already configured for the user@.service, apply the snippet below first; otherwise the user slice still won't have memory in its subtree_control after reboot.",
      "  sudo mkdir -p /etc/systemd/system/user@.service.d",
      // The heredoc body and its closing EOF must start at column 0 — an
      // indented terminator is not recognised, so the shell would hang
      // waiting for EOF (and swallow the following lines into the file).
      "  sudo tee /etc/systemd/system/user@.service.d/delegate.conf <<'EOF'",
      "[Service]",
      "Delegate=cpu cpuset io memory pids",
      "EOF",
      "  sudo systemctl daemon-reload",
      "",
      "Verify inside the SK container after reboot:",
      `  podman exec ${self} cat /sys/fs/cgroup/cgroup.controllers`,
      `  # or: docker exec ${self} cat /sys/fs/cgroup/cgroup.controllers`,
      "  # memory should appear in the output",
    ];
  }
  return [
    `Signal K is containerized and the host has not delegated these cgroup v2 controllers: ${missing.join(", ")}.`,
    "Consumer plugins requesting limits on the missing controllers will have those limits silently dropped.",
    "",
    "Enable delegation on the host (one-time, requires root):",
    "  sudo mkdir -p /etc/systemd/system/user@.service.d",
    // The heredoc body and its closing EOF must start at column 0 — an
    // indented terminator is not recognised, so the shell would hang
    // waiting for EOF (and swallow the following lines into the file).
    "  sudo tee /etc/systemd/system/user@.service.d/delegate.conf <<'EOF'",
    "[Service]",
    "Delegate=cpu cpuset io memory pids",
    "EOF",
    "  sudo systemctl daemon-reload",
    "",
    "Log the SK-owning user out and back in (or reboot).",
    "Then restart the Signal K CONTAINER itself. Controllers are enabled on the container's cgroup when the container starts, so the admin UI's Restart button (which only restarts the server process inside the container) is not enough:",
    "  systemctl --user restart signalk-server.service   # universal-installer (Quadlet) deployments",
    `  # or: podman restart ${self} / docker restart ${self}`,
    "Signal K's next start re-applies the requested resource limits to managed containers automatically — no manual container recreation needed.",
    "Verify inside the SK container (the host view can differ from what the process sees):",
    `  podman exec ${self} cat /sys/fs/cgroup/cgroup.controllers`,
    `  # or: docker exec ${self} cat /sys/fs/cgroup/cgroup.controllers`,
  ];
}

/**
 * The `findSelfContainerId` cascade validates HOSTNAME/cgroup/mountinfo
 * candidates with `inspect`, which over the socket needs the dockerode
 * client threaded in (containers.ts grows a trailing `client` param as
 * part of the same socket port). This local view declares that optional
 * param so the doctor can pass the resolved client while containers.ts's
 * own port lands in parallel.
 */
type FindSelfContainerId = (
  runtime: ContainerRuntimeInfo,
  debug?: (msg: string) => void,
  client?: ContainerClient,
) => Promise<string | null>;

/**
 * Run the existing `findSelfContainerId` cascade and report which
 * branch matched. We re-implement the source attribution here (the
 * underlying helper doesn't expose it) by re-checking inputs in the
 * same order it does.
 */
async function resolveSelfIdWithSource(
  runtimeInfo: ContainerRuntimeInfo,
  readEnv: (key: string) => string | undefined,
  client: ContainerClient,
): Promise<SelfDeploymentResult["selfId"]> {
  const value = await (findSelfContainerId as FindSelfContainerId)(
    runtimeInfo,
    undefined,
    client,
  );
  if (!value) return { value: null, source: null };
  const envOverride = readEnv("SIGNALK_CONTAINER_ID")?.trim();
  if (envOverride && envOverride === value) {
    return { value, source: "env" };
  }
  const hostname = readEnv("HOSTNAME")?.trim();
  if (hostname && value.startsWith(hostname)) {
    return { value, source: "hostname" };
  }
  return { value, source: "cgroup" };
}

/**
 * Pick the right remediation block for a non-`ok` daemon outcome.
 * Permission-denied is binary-agnostic; for socket-unreachable we
 * branch on `binary` so the operator sees podman-specific
 * (`systemctl --user`) vs docker-specific (`/var/run/docker.sock`)
 * guidance.
 */
function remediationForDaemonFailure(
  status: SelfDeploymentStatus,
  binary: RuntimeName,
  env: SelfDeploymentResult["env"],
): string[] {
  if (status === "permission-denied") return REMEDIATION_PERMISSION_DENIED;
  return binary === "podman"
    ? REMEDIATION_SOCKET_UNREACHABLE_PODMAN
    : remediationDockerSocket(env.DOCKER_HOST);
}

/**
 * Docker-specific socket-unreachable text. Built dynamically (not a
 * constant) so the `DOCKER_HOST=<value>` line echoes whatever the
 * operator actually has set, including `(unset)` when null.
 */
function remediationDockerSocket(dockerHost: string | null): string[] {
  return [
    "Found docker binary, but cannot connect to the Docker daemon.",
    `DOCKER_HOST=${dockerHost ?? "(unset)"}`,
    "",
    "Check on the host:",
    "  sudo systemctl status docker",
    "  ls -l /var/run/docker.sock",
    "",
    "Bind-mount the socket into this Signal K container:",
    "  -v /var/run/docker.sock:/var/run/docker.sock",
  ];
}

const REMEDIATION_NO_RUNTIME_BARE_METAL: string[] = [
  "No container runtime socket answered the Docker API. Install a runtime",
  "and make sure its socket is running:",
  "  Podman (recommended):  sudo apt install podman     (Debian/Ubuntu)",
  "                          sudo dnf install podman     (Fedora/RHEL)",
  "    then enable the socket: systemctl --user enable --now podman.socket",
  '    and enable lingering:   sudo loginctl enable-linger "$USER"',
  "      (so the socket survives logout and reboot on headless hosts)",
  "  Docker:                 https://docs.docker.com/engine/install/",
  "After install, restart Signal K.",
];

const REMEDIATION_NO_RUNTIME_CONTAINERIZED: string[] = [
  "Signal K is running inside a container, but no container runtime",
  "socket answered the Docker API from inside this container.",
  "",
  "signalk-container talks to the host runtime directly over its unix",
  "socket — no podman/docker CLI binary is needed inside the container.",
  "The one thing required is that the matching runtime socket from your",
  "host is bind-mounted in. Whichever runtime you already use on your",
  "host — Docker (HALOS, Docker Desktop, docker-ce) or Podman — is the",
  "one to wire up; signalk-container talks to whichever socket it finds.",
  "",
  "── If your host runs Docker (HALOS, Docker Desktop, plain docker-ce) ──",
  "",
  "Update your docker-compose / docker run for the SK service to add:",
  "",
  "  -v /var/run/docker.sock:/var/run/docker.sock",
  "",
  "This exposes the host's docker daemon. The SK container user must be",
  "in the host's `docker` group, or you can use rootless docker.",
  "",
  "── If your host runs Podman (Fedora, RHEL, rootless Linux setups) ──",
  "",
  "Add to your SK container start command:",
  "",
  "  -v /run/user/$(id -u)/podman/podman.sock:/var/run/docker.sock",
  "  --user $(id -u):$(id -g)",
  "",
  "(That's the rootless setup — the podman socket is mounted at the",
  " docker-socket path so it's found automatically. For rootful Podman,",
  " use /run/podman/podman.sock as the source and drop the --user flag.)",
  "",
  "── Pointing at a non-default socket path ──",
  "",
  "If you mount the socket somewhere other than the paths probed by",
  "default, set DOCKER_HOST or CONTAINER_HOST to its unix:// URL; that",
  "endpoint is then used exclusively.",
];

const REMEDIATION_SOCKET_UNREACHABLE_PODMAN: string[] = [
  "Found podman binary, but cannot reach the podman socket.",
  "Expected at: /run/user/<uid>/podman/podman.sock",
  "",
  "Check on the host:",
  "  systemctl --user status podman.socket",
  "  systemctl --user enable --now podman.socket",
  "",
  "Then ensure the socket is bind-mounted into this Signal K container:",
  "  -v /run/user/$(id -u)/podman/podman.sock:/run/user/$(id -u)/podman/podman.sock",
  "  -e CONTAINER_HOST=unix:///run/user/$(id -u)/podman/podman.sock",
];

const REMEDIATION_PERMISSION_DENIED: string[] = [
  "Runtime socket is reachable but rejected this user.",
  "",
  "Rootless Podman: the socket must belong to the same uid as the Signal K",
  "container's user. Check that --user matches the host uid that owns the",
  "podman socket.",
  "",
  "Docker rootful: the Signal K container user must be a member of the",
  "'docker' group on the host. Add to your compose, using the host's",
  "docker GID (privileged/network_mode:host do NOT bypass the socket ACL):",
  "  group_add:",
  '    - "<docker-gid-from-host>"   # getent group docker | cut -d: -f3',
];

const REMEDIATION_SELF_ID_UNRESOLVED: string[] = [
  "Signal K is containerized but its own container ID could not be detected.",
  "This breaks data-dir path translation and the sibling-bridge fallback.",
  "",
  "Set SIGNALK_CONTAINER_ID explicitly to the container name/ID:",
  "  -e SIGNALK_CONTAINER_ID=<your-signalk-container-name>",
  "",
  "(Cascade tried: $SIGNALK_CONTAINER_ID, $HOSTNAME, /proc/self/cgroup)",
];

/**
 * Default Signal K HTTP port published by the generated snippets. Kept
 * as a single named constant so the compose and `run` render paths can
 * never diverge.
 */
const DEFAULT_SIGNALK_PORT = 3000;

/**
 * Produce a ready-to-paste compose fragment or `podman/docker run`
 * command line tailored to the detected deployment shape, plus a
 * minimal Dockerfile sidecar showing image-side prereqs.
 *
 * Pure templating — runs no probes. All inputs come from a previously
 * gathered `SelfDeploymentResult` plus an optional `hostUser`. When
 * `hostUser` is omitted, snippets use `$(id -u):$(id -g)` placeholders
 * so the result stays portable across operator machines.
 *
 * Falls back to the recommended default (rootless podman) when the
 * input has no detected binary — the generator's job is to always
 * produce something usable.
 */
export function generateSetupSnippet(
  result: SelfDeploymentResult,
  format: SetupSnippetFormat = "compose",
  hostUser: { uid: number; gid: number } | null = null,
): SetupSnippetResult {
  const runtime: RuntimeName = result.binary.name ?? "podman";
  const rootless = pickRootless(runtime, result.daemon.rootless);
  const uid = hostUser?.uid ?? null;
  const gid = hostUser?.gid ?? null;

  const ctx: SnippetContext = {
    runtime,
    rootless,
    uid,
    gid,
    needsExplicitSelfId:
      result.isContainerized &&
      result.selfId.value !== null &&
      result.selfId.source !== "env",
    isSelfIdUnresolved: result.isContainerized && result.selfId.value === null,
    hostUserKnown: hostUser !== null,
  };

  const snippet =
    format === "compose" ? renderCompose(ctx) : renderRunCommand(ctx);
  const dockerfile = hostUser === null ? "" : renderDockerfile();
  const notes = buildSnippetNotes(ctx, result);

  return { format, runtime, rootless, snippet, dockerfile, notes };
}

interface SnippetContext {
  runtime: RuntimeName;
  rootless: boolean;
  uid: number | null;
  gid: number | null;
  /** SK is containerized, self-id was detected non-explicitly — adding
   *  SIGNALK_CONTAINER_ID is defensive but not required. */
  needsExplicitSelfId: boolean;
  /** SK is containerized but self-id resolution failed — operator MUST
   *  set SIGNALK_CONTAINER_ID for the in-container path to work. */
  isSelfIdUnresolved: boolean;
  hostUserKnown: boolean;
}

/**
 * Decide whether the generated snippet should use the rootless shape.
 * Trusts the probe's detection when present; otherwise defaults rootless
 * for podman (matches Dirk's standard deployment + AGENTS.md guidance)
 * and rootful for docker (the common case).
 */
function pickRootless(runtime: RuntimeName, detected: boolean | null): boolean {
  if (detected !== null) return detected;
  return runtime === "podman";
}

/**
 * Compose YAML fragment. Indentation is two spaces; the snippet is
 * meant to be pasted into a `services:` block where the `signalk`
 * entry replaces or merges with an existing one.
 */
function renderCompose(ctx: SnippetContext): string {
  const userLine = ctx.hostUserKnown
    ? `    user: "${ctx.uid}:${ctx.gid}"`
    : '    user: "${UID}:${GID}" # or $(id -u):$(id -g) from the host';
  const socketLines = socketBindAndEnv(ctx, "compose");
  const selfIdLine =
    ctx.needsExplicitSelfId || ctx.isSelfIdUnresolved
      ? "      - SIGNALK_CONTAINER_ID=signalk"
      : null;
  const groupAddBlock =
    ctx.runtime === "docker" && !ctx.rootless
      ? [
          "    group_add:",
          '      - "${DOCKER_GID}" # `getent group docker | cut -d: -f3`',
        ]
      : [];

  const lines: string[] = [
    "services:",
    "  signalk:",
    "    image: signalk/signalk-server",
    userLine,
    "    volumes:",
    ...socketLines.volumeYaml,
    "      - ~/.signalk:/home/node/.signalk",
    "    environment:",
    ...socketLines.envYaml,
  ];
  if (selfIdLine) lines.push(selfIdLine);
  lines.push(
    "    ports:",
    `      - "${DEFAULT_SIGNALK_PORT}:${DEFAULT_SIGNALK_PORT}"`,
  );
  lines.push(...groupAddBlock);
  return lines.join("\n");
}

/**
 * Multi-line `podman run` / `docker run` shell command. Uses backslash
 * line continuations so operators can copy the whole thing into a
 * terminal and run it as one invocation.
 */
function renderRunCommand(ctx: SnippetContext): string {
  const cmd = ctx.runtime;
  const userFlag = ctx.hostUserKnown
    ? `--user ${ctx.uid}:${ctx.gid}`
    : '--user "$(id -u):$(id -g)"';
  const socket = socketBindAndEnv(ctx, "run");
  const groupAdd =
    ctx.runtime === "docker" && !ctx.rootless
      ? ['--group-add "$(getent group docker | cut -d: -f3)"']
      : [];
  const selfIdEnv =
    ctx.needsExplicitSelfId || ctx.isSelfIdUnresolved
      ? ["-e SIGNALK_CONTAINER_ID=signalk"]
      : [];

  const parts: string[] = [
    `${cmd} run -d`,
    "--name signalk",
    userFlag,
    ...socket.runArgs,
    "-v ~/.signalk:/home/node/.signalk",
    ...selfIdEnv,
    ...groupAdd,
    `-p ${DEFAULT_SIGNALK_PORT}:${DEFAULT_SIGNALK_PORT}`,
    "signalk/signalk-server",
  ];
  return parts.join(" \\\n  ");
}

interface SocketLines {
  /** YAML lines for the compose `volumes:` section (already indented). */
  volumeYaml: string[];
  /** YAML lines for the compose `environment:` section (already indented). */
  envYaml: string[];
  /** Arg fragments for the shell `run` command (one flag per element). */
  runArgs: string[];
}

/**
 * Per-(runtime, rootless) socket bind paths and matching env vars.
 * Rootless podman uses the user-scoped socket path with a literal uid
 * (or `${UID}` placeholder); rootful uses the system socket; docker uses
 * `/var/run/docker.sock` and no env var.
 */
function socketBindAndEnv(
  ctx: SnippetContext,
  format: SetupSnippetFormat,
): SocketLines {
  if (ctx.runtime === "podman" && ctx.rootless) {
    const uidStr = ctx.hostUserKnown ? String(ctx.uid) : "${UID}";
    const sockPath = `/run/user/${uidStr}/podman/podman.sock`;
    const envVal = `unix://${sockPath}`;
    return {
      volumeYaml: [`      - ${sockPath}:${sockPath}`],
      envYaml: [`      - CONTAINER_HOST=${envVal}`],
      runArgs: [`-v ${sockPath}:${sockPath}`, `-e CONTAINER_HOST=${envVal}`],
    };
  }
  if (ctx.runtime === "podman") {
    const sockPath = "/run/podman/podman.sock";
    const envVal = `unix://${sockPath}`;
    return {
      volumeYaml: [`      - ${sockPath}:${sockPath}`],
      envYaml: [`      - CONTAINER_HOST=${envVal}`],
      runArgs: [`-v ${sockPath}:${sockPath}`, `-e CONTAINER_HOST=${envVal}`],
    };
  }
  // docker (rootless or rootful — same socket convention from compose's POV)
  void format;
  return {
    volumeYaml: ["      - /var/run/docker.sock:/var/run/docker.sock"],
    envYaml: [],
    runArgs: ["-v /var/run/docker.sock:/var/run/docker.sock"],
  };
}

/**
 * Image-side prerequisites note. signalk-container talks to the runtime
 * over the bind-mounted socket via the Docker API — no podman/docker CLI
 * needs to be installed in the Signal K image — so there is nothing to add
 * to the Dockerfile. The socket bind-mount in the compose/run snippet is
 * the only requirement.
 */
function renderDockerfile(): string {
  return [
    "# No Dockerfile changes are needed: signalk-container talks to the",
    "# runtime over the bind-mounted socket via the Docker API — no",
    "# podman/docker CLI has to be installed in the image. The socket",
    "# bind-mount in the snippet above is all that's required.",
  ].join("\n");
}

/**
 * Build the `notes` array — SELinux warnings, Windows-uid caveats,
 * defensive SIGNALK_CONTAINER_ID hints, etc. Order matters: the most
 * actionable items come first.
 */
function buildSnippetNotes(
  ctx: SnippetContext,
  result: SelfDeploymentResult,
): string[] {
  const out: string[] = [];

  if (ctx.isSelfIdUnresolved) {
    out.push(
      "Self-id detection failed in your current setup. The snippet sets " +
        "SIGNALK_CONTAINER_ID=signalk explicitly; rename it if your " +
        "service is called something else.",
    );
  } else if (ctx.needsExplicitSelfId) {
    out.push(
      "SIGNALK_CONTAINER_ID is set defensively. Your current install " +
        `resolved its own container id via the ${result.selfId.source} ` +
        "cascade step, which is reliable but not under your control.",
    );
  }

  if (!ctx.hostUserKnown) {
    out.push(
      "host UID/GID could not be determined (Windows or non-POSIX " +
        "platform). The snippet uses ${UID}/${GID} placeholders; on " +
        "Docker Desktop UID translation is handled internally and the " +
        "--user flag can be dropped.",
    );
  }

  if (ctx.runtime === "podman" && !ctx.rootless) {
    out.push(
      "Rootful podman: bind-mount the runtime socket and add `:Z` to " +
        "any host-path volumes on SELinux-enforcing distributions " +
        "(Fedora/RHEL) — signalk-container does this automatically for " +
        "managed containers but the Signal K container itself is yours " +
        "to configure.",
    );
  }

  if (ctx.runtime === "docker" && !ctx.rootless) {
    out.push(
      "Mounting /var/run/docker.sock grants root-equivalent access to " +
        "the host. Prefer rootless podman for production deployments.",
    );
  }

  return out;
}

/**
 * Deployment statuses that should escalate to a dashboard error even
 * though runtime detection itself succeeded. `cgroup-controllers-incomplete`
 * means resource limits are being silently dropped; `self-id-unresolved`
 * means the in-container self-detection failed and consumer plugins can't
 * mount the Signal K data dir or join its network. Both let containers run,
 * so they never make `detectRuntime()` return `null` — the operator would
 * otherwise see a healthy green status with no hint of the problem.
 *
 * `no-runtime`, `socket-unreachable`, and `permission-denied` all make
 * `detectRuntime()` return `null` and are surfaced on that path; they are
 * intentionally not listed here.
 */
const DASHBOARD_ERROR_STATUSES: ReadonlySet<SelfDeploymentStatus> = new Set([
  "cgroup-controllers-incomplete",
  "self-id-unresolved",
]);

/**
 * True when a doctor status reached after successful runtime detection
 * still warrants a dashboard error (degraded-but-running deployment).
 */
export function isDashboardDeploymentError(
  status: SelfDeploymentStatus,
): boolean {
  return DASHBOARD_ERROR_STATUSES.has(status);
}
