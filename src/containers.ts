import * as net from "net";
import {
  ContainerConfig,
  ContainerInfo,
  ContainerRuntimeInfo,
  ContainerState,
  HealthCheckOptions,
} from "./types";
import { execRuntime, execRuntimeLong, isContainerized } from "./runtime";
import { resourceFlagsForRun } from "./resources";

const CONTAINER_PREFIX = "sk-";

function prefixedName(name: string): string {
  return name.startsWith(CONTAINER_PREFIX)
    ? name
    : `${CONTAINER_PREFIX}${name}`;
}

/**
 * Build the value for a `-v <source>:<dest>[:flags]` argument with the
 * correct SELinux relabel suffix for the runtime.
 *
 * `:Z` is for SELinux relabelling of bind-mount host paths under Podman
 * on Fedora/RHEL. Named volumes (no leading '/' or '.') reject `:Z` with
 * "invalid option z for named volume", so we omit the flag for them.
 *
 * Used by both ContainerConfig.volumes (containers.ts) and JobConfig
 * inputs/outputs (jobs.ts) so the named-volume guard stays in one place.
 */
export function volumeArg(
  hostPath: string,
  containerPath: string,
  runtime: ContainerRuntimeInfo,
  readOnly: boolean = false,
): string {
  const isNamedVolume = !hostPath.startsWith("/") && !hostPath.startsWith(".");
  const flags: string[] = [];
  if (readOnly) flags.push("ro");
  if (runtime.runtime === "podman" && !isNamedVolume) flags.push("Z");
  const suffix = flags.length > 0 ? `:${flags.join(",")}` : "";
  return `${hostPath}:${containerPath}${suffix}`;
}

export function qualifyImage(
  image: string,
  runtime: ContainerRuntimeInfo,
): string {
  // Podman requires fully qualified image names when unqualified-search
  // registries are not configured. Prefix docker.io/ if missing.
  if (runtime.runtime === "podman") {
    const parts = image.split("/");
    // Treat first component as a registry only if it has a dot, a colon
    // (port), or is exactly "localhost". Otherwise, prefix docker.io/.
    const looksLikeRegistry =
      parts[0].includes(".") ||
      parts[0].includes(":") ||
      parts[0] === "localhost";
    if (parts.length <= 2 && !looksLikeRegistry) {
      return `docker.io/${image}`;
    }
  }
  return image;
}

export async function imageExists(
  runtime: ContainerRuntimeInfo,
  image: string,
): Promise<boolean> {
  const result = await execRuntime(runtime, ["image", "inspect", image]);
  return result.exitCode === 0;
}

/**
 * Return the local image ID (sha256 digest) for a given image reference,
 * or null if the image is not present locally. Used for digest-drift
 * detection of floating tags like :latest or :main.
 *
 * Pass either a repo:tag (e.g. "questdb/questdb:latest") to inspect a
 * pulled image, or a container name to inspect the image a running
 * container is using.
 */
export async function getImageDigest(
  runtime: ContainerRuntimeInfo,
  imageOrContainer: string,
): Promise<string | null> {
  // Try image inspect first; fall back to container inspect for names.
  const qualified = qualifyImage(imageOrContainer, runtime);
  const imgResult = await execRuntime(runtime, [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    qualified,
  ]);
  if (imgResult.exitCode === 0 && imgResult.stdout) {
    return imgResult.stdout.trim();
  }

  // Maybe it's a container name; .Image on a container returns the image ID.
  const ctrResult = await execRuntime(runtime, [
    "inspect",
    "--format",
    "{{.Image}}",
    imageOrContainer,
  ]);
  if (ctrResult.exitCode === 0 && ctrResult.stdout) {
    return ctrResult.stdout.trim();
  }

  return null;
}

export async function pullImage(
  runtime: ContainerRuntimeInfo,
  image: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const { exitCode, log } = await execRuntimeLong(
    runtime,
    ["pull", image],
    onProgress,
    300000,
  );
  if (exitCode !== 0) {
    throw new Error(`Failed to pull ${image}: ${log.slice(-5).join("\n")}`);
  }
}

export async function getContainerState(
  runtime: ContainerRuntimeInfo,
  name: string,
  exec: ExecFn = execRuntime,
): Promise<ContainerState> {
  const fullName = prefixedName(name);
  // Query multiple state fields and treat the container as running if
  // ANY of them indicate running. Rationale: rootless podman on some
  // kernels briefly returns inconsistent `State.Status` values for a
  // container that's actually running (observed during heavy concurrent
  // inspect traffic from the config panel's 5-second poll). The
  // `State.Pid` field is a more authoritative signal — if there's a
  // live PID, the container process exists regardless of what Status
  // momentarily claims. Same for `State.Running` which is a boolean
  // that podman populates independently from Status.
  //
  // Order in the format string: Status | Running | Pid
  const result = await exec(runtime, [
    "inspect",
    "--format",
    "{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}",
    fullName,
  ]);

  if (result.exitCode !== 0) return "missing";

  const [rawStatus, rawRunning, rawPid] = result.stdout.split("|");
  const status = (rawStatus ?? "").toLowerCase().trim();
  const runningFlag = (rawRunning ?? "").toLowerCase().trim() === "true";
  const pid = Number((rawPid ?? "").trim());
  const hasLivePid = Number.isFinite(pid) && pid > 0;

  // Running if ANY source says so. This is the defensive OR — we'd
  // rather report "running" when the container is actually stopped
  // (worst case: ensureRunning's "already running" fast path skips
  // a start call, which would then fail the subsequent health check
  // and recover) than report "stopped" when it's running (worst
  // case: update service skips legit checks, user sees flap).
  if (status === "running" || runningFlag || hasLivePid) return "running";
  return "stopped";
}

/**
 * Type alias matching `ExecRuntimeFn` in resources.ts; declared
 * locally so containers.ts doesn't have to depend on resources.ts.
 */
type ExecFn = (
  runtime: ContainerRuntimeInfo,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Read the live resource limits applied to a managed container,
 * straight from `podman inspect` (i.e. the actual cgroup state).
 * Returns an empty object if the container is missing or no
 * limits are applied. Used by:
 *
 *   - the `updateResources` rollback path, to capture pre-update
 *     state so a failed recreate can be reverted
 *   - `ensureRunning`'s diff detection, to decide whether a running
 *     container needs a live resources update
 *
 * The shape conversion is the inverse of `resourceFlagsForRun`:
 *   NanoCpus       (nanoseconds/sec) → cpus (cores)
 *   Memory         (bytes)           → memory ("123m")
 *   MemorySwap     (bytes)           → memorySwap ("123m")
 *   ...etc.
 *
 * Memory values are emitted as bytes-with-suffix to round-trip
 * cleanly with what consumer plugins typically pass in (`"512m"`).
 *
 * `exec` defaults to the production execRuntime; tests pass a stub.
 */
export async function getLiveResources(
  runtime: ContainerRuntimeInfo,
  name: string,
  exec: ExecFn = execRuntime,
): Promise<import("./types").ContainerResourceLimits> {
  const fullName = prefixedName(name);
  // Use Go-template format for reliable parsing across podman/docker.
  // Each line is one numeric or string value; empty/zero means "unset".
  const fmt =
    "{{.HostConfig.NanoCpus}}|" +
    "{{.HostConfig.CpuShares}}|" +
    "{{.HostConfig.CpusetCpus}}|" +
    "{{.HostConfig.Memory}}|" +
    "{{.HostConfig.MemorySwap}}|" +
    "{{.HostConfig.MemoryReservation}}|" +
    "{{.HostConfig.PidsLimit}}|" +
    "{{.HostConfig.OomScoreAdj}}";
  const result = await exec(runtime, ["inspect", "--format", fmt, fullName]);
  if (result.exitCode !== 0) return {};

  const parts = result.stdout.split("|");
  if (parts.length !== 8) return {};

  const [
    nanoCpus,
    cpuShares,
    cpusetCpus,
    memory,
    memorySwap,
    memoryReservation,
    pidsLimit,
    oomScoreAdj,
  ] = parts;

  const out: import("./types").ContainerResourceLimits = {};

  const nano = Number(nanoCpus);
  if (Number.isFinite(nano) && nano > 0) {
    // Round to 3 decimals to avoid float noise like 1.4999999999.
    out.cpus = Math.round((nano / 1_000_000_000) * 1000) / 1000;
  }
  const shares = Number(cpuShares);
  // 0 and 1024 are both "default" — only emit if explicitly set to
  // something else, since 1024 is the kernel default and we'd add
  // noise to comparisons.
  if (Number.isFinite(shares) && shares > 0 && shares !== 1024) {
    out.cpuShares = shares;
  }
  if (cpusetCpus && cpusetCpus.trim() !== "") {
    out.cpusetCpus = cpusetCpus.trim();
  }
  const mem = Number(memory);
  if (Number.isFinite(mem) && mem > 0) {
    out.memory = bytesToString(mem);
  }
  const memSwap = Number(memorySwap);
  // memorySwap is reported as -1 when unlimited; we only care about
  // explicit caps.
  if (Number.isFinite(memSwap) && memSwap > 0) {
    out.memorySwap = bytesToString(memSwap);
  }
  const memReserve = Number(memoryReservation);
  if (Number.isFinite(memReserve) && memReserve > 0) {
    out.memoryReservation = bytesToString(memReserve);
  }
  const pids = Number(pidsLimit);
  // PidsLimit is reported as 2048 by podman default — that's not
  // actually a "set" value, it's the default. Only emit if very
  // different. Detecting "this is the kernel default" precisely is
  // hard; treat 0 and 2048 as unset.
  if (Number.isFinite(pids) && pids > 0 && pids !== 2048) {
    out.pidsLimit = pids;
  }
  const oom = Number(oomScoreAdj);
  if (Number.isFinite(oom) && oom !== 0) {
    out.oomScoreAdj = oom;
  }

  return out;
}

/**
 * Convert a byte count back into the human form consumer plugins
 * use ("512m", "2g"). Picks the largest unit that produces an
 * integer result, falling back to bytes ("536870912b") if no clean
 * unit fits — though this should not happen for typical container
 * memory values which are always whole MiB.
 */
function bytesToString(bytes: number): string {
  const G = 1024 * 1024 * 1024;
  const M = 1024 * 1024;
  const K = 1024;
  if (bytes >= G && bytes % G === 0) return `${bytes / G}g`;
  if (bytes >= M && bytes % M === 0) return `${bytes / M}m`;
  if (bytes >= K && bytes % K === 0) return `${bytes / K}k`;
  return `${bytes}b`;
}

function buildRunArgs(
  name: string,
  config: ContainerConfig,
  runtime: ContainerRuntimeInfo,
): string[] {
  const fullName = prefixedName(name);
  const imageRef = qualifyImage(`${config.image}:${config.tag}`, runtime);
  const args = ["run", "-d", "--name", fullName];

  if (config.restart && config.restart !== "no") {
    args.push("--restart", config.restart);
  }

  if (config.networkMode) {
    args.push("--network", config.networkMode);
  }

  if (config.ports) {
    for (const [containerPort, hostBind] of Object.entries(config.ports)) {
      const port = containerPort.replace(/\/tcp$/, "");
      args.push("-p", `${hostBind}:${port}`);
    }
  }

  if (config.volumes) {
    for (const [containerPath, hostPath] of Object.entries(config.volumes)) {
      args.push("-v", volumeArg(hostPath, containerPath, runtime));
    }
  }

  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // Resource limits (--cpus, --memory, --pids-limit, etc.)
  // Fields whose backing cgroup controller is unavailable on this
  // runtime are silently dropped.
  args.push(...resourceFlagsForRun(config.resources, runtime));

  args.push(imageRef);

  if (config.command) {
    args.push(...config.command);
  }

  return args;
}

export async function ensureRunning(
  runtime: ContainerRuntimeInfo,
  name: string,
  config: ContainerConfig,
  debug: (msg: string) => void,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  options?: HealthCheckOptions,
): Promise<void> {
  const state = await getContainerState(runtime, name);
  const fullName = prefixedName(name);
  const imageRef = qualifyImage(`${config.image}:${config.tag}`, runtime);

  switch (state) {
    case "running":
      debug(`Container ${fullName} already running`);
      return;

    case "stopped": {
      debug(`Starting stopped container ${fullName}`);
      const startResult = await execRuntime(runtime, ["start", fullName]);
      if (startResult.exitCode !== 0) {
        throw new Error(`Failed to start ${fullName}: ${startResult.stderr}`);
      }
      return;
    }

    case "missing": {
      const hasImage = await imageExists(runtime, imageRef);
      if (!hasImage) {
        debug(`Pulling ${imageRef}...`);
        await pullImage(runtime, imageRef, debug);
      }

      debug(`Creating container ${fullName}`);
      const runArgs = buildRunArgs(name, config, runtime);
      const runResult = await execRuntime(runtime, runArgs);
      if (runResult.exitCode !== 0) {
        throw new Error(`Failed to create ${fullName}: ${runResult.stderr}`);
      }
      return;
    }
  }
}

export async function startContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
): Promise<void> {
  const fullName = prefixedName(name);
  const result = await execRuntime(runtime, ["start", fullName]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to start ${fullName}: ${result.stderr}`);
  }
}

async function fixVolumePermissions(
  runtime: ContainerRuntimeInfo,
  name: string,
): Promise<void> {
  const fullName = prefixedName(name);
  const state = await getContainerState(runtime, name);
  if (state !== "running") return;

  // Get bind-mounted volume destinations inside the container
  const inspect = await execRuntime(runtime, [
    "inspect",
    "--format",
    '{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}} {{end}}{{end}}',
    fullName,
  ]);
  const mounts = inspect.stdout.trim().split(/\s+/).filter(Boolean);
  if (mounts.length === 0) return;

  // Grant "others" read/write/execute on bind mounts so the host user
  // (which is "others" relative to the container's user namespace mapped
  // UID) can delete the files. Owner permissions stay unchanged. Falls
  // back silently if chmod isn't available in the image (distroless etc.).
  await execRuntime(runtime, [
    "exec",
    fullName,
    "chmod",
    "-R",
    "o+rwX",
    ...mounts,
  ]);
}

export async function stopContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
): Promise<void> {
  const fullName = prefixedName(name);
  await fixVolumePermissions(runtime, name).catch(() => {});
  const result = await execRuntime(runtime, ["stop", fullName]);
  if (result.exitCode !== 0) {
    const state = await getContainerState(runtime, name);
    if (state !== "stopped" && state !== "missing") {
      throw new Error(`Failed to stop ${fullName}: ${result.stderr}`);
    }
  }
}

export async function removeContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
): Promise<void> {
  const fullName = prefixedName(name);
  await fixVolumePermissions(runtime, name).catch(() => {});
  await execRuntime(runtime, ["stop", fullName]);
  const result = await execRuntime(runtime, ["rm", "-f", fullName]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to remove ${fullName}: ${result.stderr}`);
  }
}

export async function listContainers(
  runtime: ContainerRuntimeInfo,
): Promise<ContainerInfo[]> {
  const result = await execRuntime(runtime, [
    "ps",
    "-a",
    "--filter",
    `name=${CONTAINER_PREFIX}`,
    "--format",
    "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Ports}}",
  ]);

  if (result.exitCode !== 0 || !result.stdout) return [];

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, image, status, created, ports] = line.split("\t");
      const state: ContainerState = status.toLowerCase().startsWith("up")
        ? "running"
        : "stopped";
      return {
        name,
        image,
        state,
        created: created || "",
        ports: ports ? ports.split(",").map((p) => p.trim()) : [],
        managedBy: "",
      };
    });
}

export async function pruneImages(
  runtime: ContainerRuntimeInfo,
): Promise<{ imagesRemoved: number; spaceReclaimed: string }> {
  const result = await execRuntime(runtime, ["image", "prune", "-f"]);
  if (result.exitCode !== 0) {
    throw new Error(`Prune failed: ${result.stderr}`);
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const reclaimedMatch = result.stdout.match(/reclaimed\s+([\d.]+\s*\w+)/i);
  return {
    imagesRemoved: lines.filter((l) => l.match(/^[a-f0-9]{12,}/i)).length,
    spaceReclaimed: reclaimedMatch?.[1] ?? "0 B",
  };
}

export async function execInContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const fullName = prefixedName(name);
  return execRuntime(runtime, ["exec", fullName, ...command]);
}

export async function ensureNetwork(
  runtime: ContainerRuntimeInfo,
  name: string,
): Promise<void> {
  const inspect = await execRuntime(runtime, ["network", "inspect", name]);
  if (inspect.exitCode !== 0) {
    const create = await execRuntime(runtime, ["network", "create", name]);
    if (create.exitCode !== 0 && !create.stderr.includes("already exists")) {
      throw new Error(`Failed to create network ${name}: ${create.stderr}`);
    }
  }
}

export async function removeNetwork(
  runtime: ContainerRuntimeInfo,
  name: string,
): Promise<void> {
  const result = await execRuntime(runtime, ["network", "rm", name]);
  if (result.exitCode !== 0 && !result.stderr.includes("not found")) {
    throw new Error(`Failed to remove network ${name}: ${result.stderr}`);
  }
}

export async function connectToNetwork(
  runtime: ContainerRuntimeInfo,
  containerName: string,
  networkName: string,
): Promise<void> {
  const fullName = prefixedName(containerName);
  const result = await execRuntime(runtime, [
    "network",
    "connect",
    networkName,
    fullName,
  ]);
  if (
    result.exitCode !== 0 &&
    // Podman: "is already connected to network"
    !result.stderr.includes("already connected") &&
    // Docker: "endpoint with name ... already exists in network"
    !result.stderr.includes("already exists in network")
  ) {
    throw new Error(
      `Failed to connect ${fullName} to ${networkName}: ${result.stderr}`,
    );
  }
}

export async function disconnectFromNetwork(
  runtime: ContainerRuntimeInfo,
  containerName: string,
  networkName: string,
): Promise<void> {
  const fullName = prefixedName(containerName);
  const result = await execRuntime(runtime, [
    "network",
    "disconnect",
    networkName,
    fullName,
  ]);
  if (result.exitCode !== 0 && !result.stderr.includes("not connected")) {
    throw new Error(
      `Failed to disconnect ${fullName} from ${networkName}: ${result.stderr}`,
    );
  }
}

/**
 * Resolve what to mount in a managed container to give it access to
 * the SignalK data directory, regardless of how SignalK itself is deployed.
 *
 * Returns the string to use as the LEFT side of a `-v <source>:<dest>` flag:
 *   - Bare-metal SignalK: returns dataDir directly (it is already a host path).
 *   - SignalK in Docker, volume-backed dataDir: returns the named volume.
 *   - SignalK in Docker, bind-backed dataDir: returns the exact host path
 *     (computing the subpath when a parent directory is bind-mounted).
 *   - Fallback (mount not found): returns dataDir — the caller's `-v` will
 *     fail gracefully at container-create time with a clear Docker error.
 *
 * The result can be used directly as `volumes: { [mountPoint]: source }` in
 * a ContainerConfig.  The content visible at mountPoint inside the managed
 * container will always correspond to the root of dataDir.
 */
export async function resolveSignalkDataSource(
  dataDir: string,
  runtime: ContainerRuntimeInfo,
  debug: (msg: string) => void = () => {},
): Promise<string> {
  if (!isContainerized()) {
    // Running bare-metal: dataDir is already a host filesystem path.
    return dataDir;
  }

  // Running inside a container. Docker/Podman set HOSTNAME to the
  // (short) container ID, which is enough for `inspect`.
  const selfId = process.env.HOSTNAME ?? "";
  if (!selfId) {
    debug(
      `resolveSignalkDataSource: HOSTNAME unset, falling back to dataDir=${dataDir}`,
    );
    return dataDir;
  }

  const result = await execRuntime(runtime, [
    "inspect",
    "--format",
    "{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}\n{{end}}",
    selfId,
  ]);
  if (result.exitCode !== 0) {
    debug(
      `resolveSignalkDataSource: inspect ${selfId} failed (exit=${result.exitCode}): ${result.stderr.trim()}; falling back to dataDir=${dataDir}`,
    );
    return dataDir;
  }

  const mounts = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [type, name, source, dest] = line.split("|");
      return { type, name, source, dest };
    });

  // Find the mount whose Destination is the longest prefix of dataDir
  // (handles both exact matches and parent-directory bind mounts).
  let best: {
    type: string;
    name: string;
    source: string;
    dest: string;
  } | null = null;
  for (const m of mounts) {
    if (dataDir === m.dest || dataDir.startsWith(m.dest + "/")) {
      if (!best || m.dest.length > best.dest.length) {
        best = m;
      }
    }
  }

  if (!best) {
    debug(
      `resolveSignalkDataSource: no mount covers dataDir=${dataDir}; mounts=${JSON.stringify(mounts)}; falling back to dataDir`,
    );
    return dataDir;
  }

  if (best.type === "volume") {
    // Named volume. Docker doesn't support subpath mounts on volumes,
    // so we return the volume name as-is. The consumer's mount point
    // will correspond to best.dest; if that equals dataDir (the common
    // case) the consumer can use mountPoint directly. If best.dest is a
    // parent of dataDir, the consumer must append the relative suffix —
    // signalk-container surfaces this via ContainerManagerApi if needed.
    return best.name;
  }

  // Bind mount. Compute the exact host path that corresponds to dataDir,
  // even when the bind covers a parent directory.
  return best.source + dataDir.slice(best.dest.length);
}

/**
 * Process-local set of ports that are currently reserved by an in-flight
 * `findAvailablePort()` call.  Prevents two concurrent `ensureRunning()`
 * calls from probing and claiming the same host port before either
 * container has actually been created.
 *
 * Ports are added here just before `findAvailablePort()` resolves and
 * removed via `releaseReservedPort()` once the container runtime holds the
 * binding (successful create) or the attempt fails.
 */
const reservedPorts = new Set<number>();

/**
 * Release a port that was reserved by `findAvailablePort()`.
 * Must be called after the container runtime has successfully bound the port
 * (so the OS-level bind now prevents collisions), or when the container
 * creation failed (so the next attempt can re-probe freely).
 */
export function releaseReservedPort(port: number): void {
  reservedPorts.delete(port);
}

/**
 * Test whether `port` is bindable on 127.0.0.1.
 * Returns `true` if the socket can be opened and closed without error.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find the lowest available TCP port on 127.0.0.1 starting at `preferred`.
 *
 * Probes by briefly binding a server socket and also skips ports that are
 * already reserved in-process by a concurrent `findAvailablePort()` call,
 * eliminating the TOCTOU window between the probe and the container create.
 *
 * The chosen port is added to the process-local `reservedPorts` set before
 * this function resolves.  The caller is responsible for releasing it via
 * `releaseReservedPort()` once the runtime holds the binding or the attempt
 * fails.
 *
 * Used by the `signalkAccessiblePorts` bare-metal path to prefer the
 * declared port number while gracefully stepping over conflicts.
 */
export async function findAvailablePort(preferred: number): Promise<number> {
  for (let port = preferred; port <= 65535; port++) {
    if (reservedPorts.has(port)) continue;
    if (await isPortAvailable(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
  throw new Error("No available port found in range 1024–65535");
}

/**
 * Return the user-defined Docker/Podman networks that the current SignalK
 * container is connected to (i.e. networks other than the default `bridge`,
 * `host`, or `none`).
 *
 * Used by the `signalkAccessiblePorts` containerized path to attach a
 * managed container to SignalK's own network so the two can communicate
 * via DNS name without exposing any host port.
 *
 * Returns:
 *   - `null`    when running bare-metal, HOSTNAME is unset, or `docker inspect`
 *               fails (e.g. host-network mode where HOSTNAME is the machine
 *               name, not a container ID).  Callers should treat this like
 *               bare-metal and publish ports instead.
 *   - `string[]` (possibly empty) when inspect succeeds.  An empty array means
 *               SignalK is only on the default bridge — callers should fall
 *               back to `networkMode: container:<HOSTNAME>`.  A non-empty
 *               array contains the user-defined network names to attach to.
 */
export async function resolveSignalkNetworks(
  runtime: ContainerRuntimeInfo,
  debug: (msg: string) => void = () => {},
): Promise<string[] | null> {
  if (!isContainerized()) return null;

  const selfId = process.env.HOSTNAME ?? "";
  if (!selfId) {
    debug("resolveSignalkNetworks: HOSTNAME unset, returning null");
    return null;
  }

  const result = await execRuntime(runtime, [
    "inspect",
    "--format",
    "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}\n{{end}}",
    selfId,
  ]);

  if (result.exitCode !== 0) {
    debug(
      `resolveSignalkNetworks: inspect ${selfId} failed (exit=${result.exitCode}): ${result.stderr.trim()} — treating as bare-metal`,
    );
    return null;
  }

  const all = result.stdout.split("\n").filter(Boolean);
  // The default bridge network does not support container-name DNS
  // resolution, so exclude it along with the virtual modes.
  const userDefined = all.filter(
    (n) => n !== "bridge" && n !== "host" && n !== "none",
  );
  debug(
    `resolveSignalkNetworks: all=${all.join(",")} userDefined=${userDefined.join(",")}`,
  );
  return userDefined;
}

export async function waitForReady(
  url: string,
  timeoutMs: number = 30000,
  intervalMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url} to become ready`);
}
