import { execFile } from "node:child_process";
import type {
  ContainerConfig,
  ContainerRuntimeInfo,
  RuntimeName,
  RuntimePreference,
  SelfDeploymentResult,
  SelfDeploymentStatus,
} from "./types.js";
import {
  type ExecFn,
  findSelfContainerId,
  qualifyImage,
} from "./containers.js";
import { execRuntime, isContainerized, userMappingFlags } from "./runtime.js";

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

/**
 * Probe-injection bag for `selfDeployment`. Production omits the arg
 * and the real helpers are used; tests pass fakes so no real podman /
 * docker / filesystem access happens.
 */
export interface SelfDeploymentProbes {
  isContainerized?: () => boolean;
  /** Resolve a binary in `$PATH` to its absolute path, or null. */
  findBinary?: (name: RuntimeName) => Promise<string | null>;
  /**
   * Extract a version string from a binary (without going through the
   * runtime-info exec wrapper, which doesn't yet have a populated info
   * struct at this stage). Receives the absolute path returned by
   * `findBinary` plus the binary's logical name.
   */
  readBinaryVersion?: (
    name: RuntimeName,
    path: string,
  ) => Promise<string | null>;
  /** Read an env var, returning undefined when unset. */
  readEnv?: (key: string) => string | undefined;
}

/**
 * Diagnose whether this Signal K deployment can drive `podman`/`docker`
 * at all, and (when SK is itself containerized) whether the prereqs for
 * the in-container deployment path are met.
 *
 * Algorithm:
 *   1. Note `isContainerized()` (advisory — checks run regardless).
 *   2. Discover the runtime CLI binary honouring `preference`.
 *   3. Probe the daemon with `<binary> info` and classify stderr on
 *      failure (no-runtime / socket-unreachable / permission-denied).
 *   4. When both 2 and 3 succeed AND we're containerized, run the
 *      `findSelfContainerId` cascade.
 *
 * Each failure short-circuits and produces a copy-pasteable
 * `remediation`. Never throws.
 */
export async function selfDeployment(
  preference: RuntimePreference,
  exec: ExecFn = execRuntime,
  probes: SelfDeploymentProbes = {},
): Promise<SelfDeploymentResult> {
  const probeIsContainerized = probes.isContainerized ?? isContainerized;
  const probeFindBinary = probes.findBinary ?? defaultFindBinary;
  const probeReadBinaryVersion =
    probes.readBinaryVersion ?? defaultReadBinaryVersion;
  const probeReadEnv = probes.readEnv ?? ((k) => process.env[k]);

  const containerized = probeIsContainerized();
  const env = {
    DOCKER_HOST: probeReadEnv("DOCKER_HOST") ?? null,
    CONTAINER_HOST: probeReadEnv("CONTAINER_HOST") ?? null,
    XDG_RUNTIME_DIR: probeReadEnv("XDG_RUNTIME_DIR") ?? null,
  };

  // 1. Binary discovery — honour preference; auto tries podman first.
  const candidates: RuntimeName[] =
    preference === "auto" ? ["podman", "docker"] : [preference];

  let binaryName: RuntimeName | null = null;
  let binaryPath: string | null = null;
  let binaryVersion: string | null = null;

  for (const name of candidates) {
    const path = await probeFindBinary(name);
    if (!path) continue;
    const version = await probeReadBinaryVersion(name, path);
    binaryName = name;
    binaryPath = path;
    binaryVersion = version;
    break;
  }

  if (!binaryName) {
    return {
      isContainerized: containerized,
      binary: { name: null, path: null, version: null },
      daemon: {
        reachable: false,
        rootless: null,
        socketPath: null,
        error: "no runtime binary in $PATH",
      },
      env,
      selfId: { value: null, source: null },
      status: "no-runtime",
      remediation: containerized
        ? REMEDIATION_NO_RUNTIME_CONTAINERIZED
        : REMEDIATION_NO_RUNTIME_BARE_METAL,
    };
  }

  // 2. Daemon reachability — call `<binary> info` and classify.
  const info = await probeDaemon(binaryName, binaryVersion, exec);
  const socketPath = inferSocketPath(binaryName, env);
  const baseResult = {
    isContainerized: containerized,
    binary: { name: binaryName, path: binaryPath, version: binaryVersion },
    env,
  };

  if (!info.reachable) {
    const status = classifyDaemonFailure(info.stderr);
    return {
      ...baseResult,
      daemon: {
        reachable: false,
        rootless: null,
        socketPath,
        error: info.stderr || `${binaryName} info exited ${info.exitCode}`,
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
    selfId = await resolveSelfIdWithSource(runtimeInfo, probeReadEnv);
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
    remediation: [],
  };
}

/**
 * Resolve a binary to its absolute path using `command -v`. Returns
 * `null` if the binary is not in `$PATH`. Implemented via `execFile`
 * on `sh` so it doesn't depend on a runtime binary already existing.
 */
function defaultFindBinary(name: RuntimeName): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", `command -v ${name}`],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const path = stdout.toString().trim();
        resolve(path.length > 0 ? path : null);
      },
    );
  });
}

/**
 * Read `<name> --version` directly (separate from the daemon probe so
 * a binary-present-but-daemon-broken state still reports a version).
 * Default implementation; tests inject a synchronous fake via
 * `SelfDeploymentProbes.readBinaryVersion` to avoid spawning the real
 * binary.
 */
function defaultReadBinaryVersion(
  name: RuntimeName,
  path: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    // `path` is the absolute location returned by `findBinary`. When
    // it's empty for any reason fall back to the bare name so $PATH
    // resolution still has a chance.
    execFile(
      path || name,
      ["--version"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const text = stdout.toString().trim();
        const version = text.replace(/^.*version\s*/i, "").split(/[\s,]/)[0];
        resolve(version || null);
      },
    );
  });
}

interface DaemonProbeResult {
  reachable: boolean;
  rootless: boolean | null;
  exitCode: number;
  stderr: string;
}

/**
 * Talk to the daemon and extract the rootless flag in one round-trip.
 * Podman exposes `{{.Host.Security.Rootless}}` as `true`/`false`;
 * Docker exposes a `SecurityOptions` array whose entries include
 * `name=rootless` when the daemon is rootless.
 */
async function probeDaemon(
  binary: RuntimeName,
  version: string | null,
  exec: ExecFn,
): Promise<DaemonProbeResult> {
  const runtimeInfo: ContainerRuntimeInfo = {
    runtime: binary,
    version: version ?? "unknown",
    isPodmanDockerShim: false,
  };
  const format =
    binary === "podman"
      ? "{{.Host.Security.Rootless}}"
      : "{{range .SecurityOptions}}{{.}}\n{{end}}";
  const r = await exec(runtimeInfo, ["info", "--format", format]);
  if (r.exitCode !== 0) {
    return {
      reachable: false,
      rootless: null,
      exitCode: r.exitCode,
      stderr: r.stderr.trim(),
    };
  }

  let rootless: boolean | null = null;
  const trimmed = r.stdout.trim();
  if (binary === "podman") {
    if (trimmed === "true") rootless = true;
    else if (trimmed === "false") rootless = false;
  } else {
    rootless = /name=rootless/.test(trimmed) ? true : false;
  }
  return { reachable: true, rootless, exitCode: 0, stderr: "" };
}

/**
 * Classify daemon-probe failure stderr into one of three doctor
 * statuses. Substring matches are intentionally generous — daemon
 * error text varies across versions and translations.
 */
function classifyDaemonFailure(stderr: string): SelfDeploymentStatus {
  const lower = stderr.toLowerCase();
  if (lower.includes("permission denied")) return "permission-denied";
  // socket-not-found / can't-connect family
  if (
    lower.includes("cannot connect") ||
    lower.includes("unable to connect") ||
    lower.includes("no such file or directory") ||
    lower.includes("connection refused") ||
    lower.includes("connect: no such file")
  ) {
    return "socket-unreachable";
  }
  // Default to socket-unreachable — the binary worked, something between
  // it and the daemon didn't. The raw stderr survives in daemon.error.
  return "socket-unreachable";
}

function inferSocketPath(
  binary: RuntimeName,
  env: SelfDeploymentResult["env"],
): string | null {
  if (binary === "docker") return env.DOCKER_HOST ?? null;
  // Podman prefers CONTAINER_HOST but also honors DOCKER_HOST when in
  // docker-API compat mode, so fall through to it when CONTAINER_HOST
  // is unset.
  return env.CONTAINER_HOST ?? env.DOCKER_HOST ?? null;
}

/**
 * Run the existing `findSelfContainerId` cascade and report which
 * branch matched. We re-implement the source attribution here (the
 * underlying helper doesn't expose it) by re-checking inputs in the
 * same order it does.
 */
async function resolveSelfIdWithSource(
  runtimeInfo: ContainerRuntimeInfo,
  readEnv: (key: string) => string | undefined,
): Promise<SelfDeploymentResult["selfId"]> {
  const value = await findSelfContainerId(runtimeInfo);
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
  "No container runtime found. Install one:",
  "  Podman (recommended):  sudo apt install podman     (Debian/Ubuntu)",
  "                          sudo dnf install podman     (Fedora/RHEL)",
  "  Docker:                 https://docs.docker.com/engine/install/",
  "After install, restart Signal K.",
];

const REMEDIATION_NO_RUNTIME_CONTAINERIZED: string[] = [
  "Signal K is running inside a container, but no container runtime",
  "(podman/docker) is reachable from inside this container. You need both:",
  "",
  "1. The runtime CLI installed inside this container. Recommended:",
  "   add `podman` (or `podman-remote`) to your Signal K image:",
  "     RUN apt-get update && apt-get install -y podman    # Debian/Ubuntu",
  "     RUN dnf install -y podman-remote                    # Fedora/RHEL",
  "   (As a quick alternative, bind-mount the host binary read-only:",
  "     -v /usr/bin/podman:/usr/bin/podman:ro )",
  "",
  "2. The runtime socket bind-mounted from the host:",
  "",
  "   Rootless Podman (recommended; matches signalk-container's default):",
  "     -v /run/user/$(id -u)/podman/podman.sock:/run/user/$(id -u)/podman/podman.sock",
  "     -e CONTAINER_HOST=unix:///run/user/$(id -u)/podman/podman.sock",
  "     --user $(id -u):$(id -g)",
  "",
  "   Rootful Podman:",
  "     -v /run/podman/podman.sock:/run/podman/podman.sock",
  "     -e CONTAINER_HOST=unix:///run/podman/podman.sock",
  "",
  "   Docker:",
  "     -v /var/run/docker.sock:/var/run/docker.sock",
  "     (SK container user must be in the host's docker group, or use rootless)",
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
  "'docker' group on the host. Add to your compose:",
  "  group_add:",
  '    - "<docker-gid-from-host>"',
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
