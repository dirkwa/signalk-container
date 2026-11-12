import { SANDBOX_MASKED_PATHS, SANDBOX_SECCOMP } from "./sandbox-policy.js";
import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { getClient, type ContainerClient } from "./client.js";
import { jobPrefix, jobMarkerLabel, jobOwnerLabel } from "./namespace.js";
import type { SandboxJobRequest } from "./types.js";

/** Internal plan; not part of the public cross-plugin API. */
export interface PreparedSandboxJob {
  id: string;
  image: string;
  stdin: Buffer;
  options: Docker.ContainerCreateOptions;
}

const KIB = 1024;
const MIB = KIB * KIB;

/** Initial workload ceilings, not measured runtime compatibility claims. */
export const SANDBOX_LIMITS = Object.freeze({
  inputBytes: MIB,
  outputBytes: 256 * KIB,
  memoryBytes: 256 * MIB,
  temporaryBytes: 16 * MIB,
  cpuPeriod: 100_000,
  cpuQuota: 50_000,
  pids: 32,
  executionMs: 15_000,
});

const PINNED_IMAGE =
  /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const OWNER = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/;
const RUNNER_PATH = /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/;
const MAX_IMAGE_LENGTH = 512;
const MAX_OWNER_LENGTH = 214;
const MAX_RUNNER_LENGTH = 256;
const REQUEST_KEYS = new Set(["ownerPluginId", "image", "runnerPath", "stdin"]);

/**
 * Prepare an inert creation plan. This never pulls, creates, starts or executes.
 * The executor must verify effective isolation before releasing stdin.
 * A create payload is not that verification.
 */
export async function prepareSandboxJob(
  request: SandboxJobRequest,
  client: ContainerClient = getClient(),
  signal?: AbortSignal,
): Promise<PreparedSandboxJob> {
  validateRequest(request);
  // Copy before the first await so callers cannot swap the authorized input
  // or image while the daemon lookup is pending.
  const { image, ownerPluginId, runnerPath } = request;
  const stdin = Buffer.from(request.stdin);
  const inspected = await client
    .getImage(image)
    .inspect({ manifests: false, ...{ abortSignal: signal } })
    .catch((error) => {
      stdin.fill(0);
      throw error;
    });
  if (
    !IMAGE_ID.test(inspected.Id) ||
    !Array.isArray(inspected.RepoDigests) ||
    !inspected.RepoDigests.some(
      (digest: string) => qualifyDockerDigest(digest) === image,
    )
  ) {
    throw new Error("Sandbox image digest could not be verified locally");
  }
  if (
    !inspected.Config ||
    typeof inspected.Config !== "object" ||
    Array.isArray(inspected.Config)
  ) {
    throw new Error("Sandbox image configuration is unavailable");
  }
  const volumes = inspected.Config.Volumes;
  if (
    volumes != null &&
    (typeof volumes !== "object" ||
      Array.isArray(volumes) ||
      Object.keys(volumes).length !== 0)
  ) {
    throw new Error("Sandbox images must not declare volumes");
  }

  const id = randomUUID();
  const options: Docker.ContainerCreateOptions = {
    name: `${jobPrefix()}sandbox-${id}`,
    Image: inspected.Id,
    Entrypoint: ["/usr/bin/timeout"],
    Cmd: ["--signal=KILL", "15s", runnerPath],
    User: "65534:65534",
    WorkingDir: "/tmp",
    Env: [
      ...(inspected.Config.Env ?? [])
        .map((entry: string) => `${entry.split("=")[0]}=`)
        .filter((entry: string) => !/^(HOME|TMPDIR|PATH)=/.test(entry)),
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    NetworkDisabled: true,
    Healthcheck: { Test: ["NONE"] },
    Labels: {
      [jobMarkerLabel()]: "true",
      [jobOwnerLabel()]: ownerPluginId,
    },
    HostConfig: {
      NetworkMode: "none",
      Init: false,
      OomKillDisable: false,
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges", `seccomp=${SANDBOX_SECCOMP}`],
      MaskedPaths: [...SANDBOX_MASKED_PATHS],
      ReadonlyPaths: [
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger",
      ],
      Ulimits: [{ Name: "core", Soft: 0, Hard: 0 }],
      PidMode: "",
      IpcMode: "private",
      Binds: [],
      Mounts: [],
      Devices: [],
      DeviceRequests: [],
      PortBindings: {},
      PublishAllPorts: false,
      ExtraHosts: [],
      RestartPolicy: { Name: "no" },
      // Keep the container until exit/OOM evidence has been collected.
      AutoRemove: false,
      LogConfig: { Type: "none", Config: {} },
      Memory: SANDBOX_LIMITS.memoryBytes,
      MemorySwap: SANDBOX_LIMITS.memoryBytes,
      CpuPeriod: SANDBOX_LIMITS.cpuPeriod,
      CpuQuota: SANDBOX_LIMITS.cpuQuota,
      PidsLimit: SANDBOX_LIMITS.pids,
      ShmSize: SANDBOX_LIMITS.temporaryBytes,
      Tmpfs: {
        "/tmp": `rw,noexec,nosuid,nodev,size=${SANDBOX_LIMITS.temporaryBytes},mode=1777`,
      },
    },
  };
  return { id, image, stdin, options };
}

function isQualifiedImage(image: string): boolean {
  const registry = image.split("/")[0];
  return (
    registry === "localhost" || registry.includes(".") || registry.includes(":")
  );
}

function validateRequest(request: SandboxJobRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Sandbox request must be an object");
  }
  if (Object.keys(request).some((key) => !REQUEST_KEYS.has(key))) {
    throw new Error("Unsupported sandbox request field");
  }
  if (
    typeof request.ownerPluginId !== "string" ||
    request.ownerPluginId.length > MAX_OWNER_LENGTH ||
    !OWNER.test(request.ownerPluginId)
  ) {
    throw new Error("Sandbox ownerPluginId must be a plugin package name");
  }
  if (
    typeof request.image !== "string" ||
    request.image.length > MAX_IMAGE_LENGTH ||
    !PINNED_IMAGE.test(request.image) ||
    !isQualifiedImage(request.image)
  ) {
    throw new Error("Sandbox image must be fully qualified and digest-pinned");
  }
  if (
    typeof request.runnerPath !== "string" ||
    request.runnerPath.length > MAX_RUNNER_LENGTH ||
    !RUNNER_PATH.test(request.runnerPath) ||
    request.runnerPath.endsWith("/.") ||
    request.runnerPath.endsWith("/..")
  ) {
    throw new Error("Sandbox runnerPath must be an absolute executable path");
  }
  if (
    !(request.stdin instanceof Uint8Array) ||
    request.stdin.buffer instanceof SharedArrayBuffer ||
    request.stdin.byteLength > SANDBOX_LIMITS.inputBytes
  ) {
    throw new Error(
      "Sandbox stdin must be private bytes within the input limit",
    );
  }
}

/**
 * A shared byte budget for already-demultiplexed stdout/stderr. No line
 * buffering, decoding or callbacks can retain an unbounded worker write.
 * The executor must terminate a job when append returns false.
 */
export class SandboxOutput {
  private readonly bytes: Buffer;
  private used = 0;
  private overflow = false;
  private closed = false;

  constructor(limit = SANDBOX_LIMITS.outputBytes) {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > SANDBOX_LIMITS.outputBytes
    ) {
      throw new Error("Invalid sandbox output limit");
    }
    this.bytes = Buffer.alloc(limit);
  }

  append(chunk: Uint8Array): boolean {
    if (this.overflow || this.closed) return false;
    const remaining = this.bytes.length - this.used;
    const count = Math.min(remaining, chunk.byteLength);
    this.bytes.set(chunk.subarray(0, count), this.used);
    this.used += count;
    this.overflow = chunk.byteLength > remaining;
    return !this.overflow;
  }

  get exceeded(): boolean {
    return this.overflow;
  }

  snapshot(): Buffer {
    return Buffer.from(this.bytes.subarray(0, this.used));
  }

  /** Release retained output contents once the caller has handled the result. */
  clear(): void {
    this.closed = true;
    this.bytes.fill(0);
    this.used = 0;
    // Overflow remains terminal: clearing must not grant another output budget.
  }
}

function qualifyDockerDigest(digest: string): string {
  const repository = digest.split("@")[0];
  if (!repository.includes("/")) return `docker.io/library/${digest}`;
  if (!isQualifiedImage(digest)) return `docker.io/${digest}`;
  return digest;
}
