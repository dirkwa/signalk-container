import {
  ContainerConfig,
  ContainerInfo,
  ContainerRuntimeInfo,
  ContainerState,
  HealthCheckOptions,
} from "./types";
import { execRuntime, execRuntimeLong } from "./runtime";

const CONTAINER_PREFIX = "sk-";

function prefixedName(name: string): string {
  return name.startsWith(CONTAINER_PREFIX)
    ? name
    : `${CONTAINER_PREFIX}${name}`;
}

export function qualifyImage(
  image: string,
  runtime: ContainerRuntimeInfo,
): string {
  // Podman requires fully qualified image names when unqualified-search
  // registries are not configured. Prefix docker.io/ if missing.
  if (runtime.runtime === "podman") {
    const parts = image.split("/");
    if (parts.length <= 2 && !parts[0].includes(".")) {
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
): Promise<ContainerState> {
  const fullName = prefixedName(name);
  const result = await execRuntime(runtime, [
    "inspect",
    "--format",
    "{{.State.Status}}",
    fullName,
  ]);

  if (result.exitCode !== 0) return "missing";

  const status = result.stdout.toLowerCase();
  if (status === "running") return "running";
  return "stopped";
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

  if (config.ports && !config.networkMode) {
    for (const [containerPort, hostBind] of Object.entries(config.ports)) {
      const port = containerPort.replace(/\/tcp$/, "");
      args.push("-p", `${hostBind}:${port}`);
    }
  }

  if (config.volumes) {
    for (const [containerPath, hostPath] of Object.entries(config.volumes)) {
      const suffix = runtime.runtime === "podman" ? ":Z" : "";
      args.push("-v", `${hostPath}:${containerPath}${suffix}`);
    }
  }

  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

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

export async function stopContainer(
  runtime: ContainerRuntimeInfo,
  name: string,
): Promise<void> {
  const fullName = prefixedName(name);
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
