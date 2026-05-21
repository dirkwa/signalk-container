import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  /**
   * Read the cgroup v2 controllers delegated to the current cgroup
   * (production: `/sys/fs/cgroup/cgroup.controllers`). Returns the list
   * of controller names, or `null` when the file is unreadable
   * (cgroup v1 host, non-Linux, unusual mount layout) — in which case
   * the doctor skips the cgroup status escalation entirely.
   */
  readCgroupControllers?: () => Promise<string[] | null>;
}

/**
 * cgroup v2 controllers that the consumer-plugin layer needs to be able
 * to enforce its resource limits. `cpu`/`cpuset` back `cpus`/`cpusetCpus`,
 * `memory` backs `memory`/`memorySwap`/`memoryReservation`, `pids` backs
 * `pidsLimit`. Missing any of these means the corresponding limit fields
 * are silently dropped by `filterUnsupportedLimits` in resources.ts.
 *
 * `io` is intentionally NOT here even though the remediation snippet
 * recommends delegating it: no `ContainerResourceLimits` field maps to
 * the io controller, so `io` missing causes no silent-drop bug. We
 * still recommend delegating it because `cpu cpuset io memory pids` is
 * the standard systemd delegate set and operators are likely to look
 * it up; deviating would just look like an unexplained omission.
 */
const EXPECTED_CGROUP_CONTROLLERS = ["cpu", "cpuset", "memory", "pids"];

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
  const probeReadCgroupControllers =
    probes.readCgroupControllers ?? defaultReadCgroupControllers;

  const containerized = probeIsContainerized();
  const env = {
    DOCKER_HOST: probeReadEnv("DOCKER_HOST") ?? null,
    CONTAINER_HOST: probeReadEnv("CONTAINER_HOST") ?? null,
    XDG_RUNTIME_DIR: probeReadEnv("XDG_RUNTIME_DIR") ?? null,
  };
  const cgroupControllers = await probeCgroupControllers(
    probeReadCgroupControllers,
  );

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
      cgroupControllers,
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
    cgroupControllers,
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
      remediation: remediationCgroupControllers(cgroupControllers.missing),
    };
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

/**
 * Best-effort guess at the socket path the binary used, based purely on
 * the relevant env vars. Reported back to the operator so they can
 * confirm whether their bind-mount matches what the CLI actually saw.
 * Returns null when no relevant env var is set.
 */
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
 * Run the cgroup-controllers probe and compute the missing set against
 * `EXPECTED_CGROUP_CONTROLLERS`. When the probe returns `null`, missing
 * is `[]` — we won't escalate status on a host we can't inspect.
 */
async function probeCgroupControllers(
  readControllers: () => Promise<string[] | null>,
): Promise<SelfDeploymentResult["cgroupControllers"]> {
  const available = await readControllers();
  if (available === null) {
    return { available: null, missing: [] };
  }
  const have = new Set(available);
  const missing = EXPECTED_CGROUP_CONTROLLERS.filter((c) => !have.has(c));
  return { available, missing };
}

/**
 * Remediation block for `cgroup-controllers-incomplete`. Names the
 * missing controllers so the operator can match the symptom in their
 * config panel ("memory limit didn't stick"); the systemd snippet is
 * the same regardless of which controllers are absent.
 */
function remediationCgroupControllers(missing: string[]): string[] {
  return [
    `Signal K is containerized and the host has not delegated these cgroup v2 controllers: ${missing.join(", ")}.`,
    "Consumer plugins requesting limits on the missing controllers will have those limits silently dropped.",
    "",
    "Enable delegation on the host (one-time, requires root):",
    "  sudo mkdir -p /etc/systemd/system/user@.service.d",
    "  sudo tee /etc/systemd/system/user@.service.d/delegate.conf <<'EOF'",
    "  [Service]",
    "  Delegate=cpu cpuset io memory pids",
    "  EOF",
    "  sudo systemctl daemon-reload",
    "",
    "Log the SK-owning user out and back in (or reboot), then restart Signal K.",
    "Verify inside the SK container (the host view can differ from what the process sees):",
    "  podman exec <sk-container> cat /sys/fs/cgroup/cgroup.controllers",
    "  # or: docker exec <sk-container> cat /sys/fs/cgroup/cgroup.controllers",
  ];
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
  const dockerfile = hostUser === null ? "" : renderDockerfile(runtime);
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
 * Minimal Dockerfile sidecar: install the runtime CLI inside the
 * Signal K image. Operators can append this to their existing Dockerfile.
 */
function renderDockerfile(runtime: RuntimeName): string {
  const pkg = runtime === "podman" ? "podman" : "docker-ce-cli";
  return [
    "# Add this to your Signal K image Dockerfile so the runtime CLI is",
    "# available inside the container at runtime:",
    `RUN apt-get update && apt-get install -y ${pkg} && rm -rf /var/lib/apt/lists/*`,
    "# Fedora/RHEL alternative:",
    runtime === "podman"
      ? "# RUN dnf install -y podman-remote"
      : "# RUN dnf install -y docker-ce-cli",
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
