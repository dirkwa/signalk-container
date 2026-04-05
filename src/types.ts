export type RuntimeName = "podman" | "docker";
export type RuntimePreference = "auto" | RuntimeName;

export interface ContainerRuntimeInfo {
  runtime: RuntimeName;
  version: string;
  isPodmanDockerShim: boolean;
}

export type ContainerState = "running" | "stopped" | "missing" | "no-runtime";

export interface ContainerConfig {
  image: string;
  tag: string;
  ports?: Record<string, string>;
  volumes?: Record<string, string>;
  env?: Record<string, string>;
  restart?: "no" | "unless-stopped" | "always";
  command?: string[];
  networkMode?: string;
}

export interface ContainerInfo {
  name: string;
  image: string;
  state: ContainerState;
  created: string;
  ports: string[];
  managedBy: string;
}

export interface ContainerJobConfig {
  image: string;
  command: string[];
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  timeout?: number;
  onProgress?: (msg: string) => void;
  label?: string;
}

export type ContainerJobStatus =
  | "pending"
  | "pulling"
  | "running"
  | "completed"
  | "failed";

export interface ContainerJobResult {
  id: string;
  status: ContainerJobStatus;
  image: string;
  command: string[];
  label?: string;
  exitCode?: number;
  log: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  runtime?: RuntimeName;
}

export interface PruneResult {
  imagesRemoved: number;
  spaceReclaimed: string;
}

export interface HealthCheckOptions {
  healthCheck?: () => Promise<boolean>;
  onUnhealthy?: (name: string, error: string) => void;
}

export interface ContainerManagerApi {
  getRuntime(): ContainerRuntimeInfo | null;
  pullImage(image: string, onProgress?: (msg: string) => void): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  ensureRunning(
    name: string,
    config: ContainerConfig,
    options?: HealthCheckOptions,
  ): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  getState(name: string): Promise<ContainerState>;
  runJob(config: ContainerJobConfig): Promise<ContainerJobResult>;
  prune(): Promise<PruneResult>;
  listContainers(): Promise<ContainerInfo[]>;
}

export interface PluginConfig {
  runtime: RuntimePreference;
  pruneSchedule: "off" | "weekly" | "monthly";
  maxConcurrentJobs: number;
}
