import { IRouter } from "express";
import {
  ContainerConfig,
  ContainerInfo,
  ContainerJobConfig,
  ContainerJobResult,
  ContainerManagerApi,
  ContainerRuntimeInfo,
  ContainerState,
  HealthCheckOptions,
  PluginConfig,
  PruneResult,
} from "./types";
import { detectRuntime } from "./runtime";
import {
  ensureRunning,
  getContainerState,
  imageExists,
  listContainers,
  pruneImages,
  pullImage,
  qualifyImage as qualifyImageForRuntime,
  removeContainer,
  startContainer,
  stopContainer,
} from "./containers";
import { runJob } from "./jobs";

interface App {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
  [key: string]: unknown;
}

module.exports = (app: App) => {
  let runtimeInfo: ContainerRuntimeInfo | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;
  const healthTimers = new Map<string, NodeJS.Timeout>();

  const api: ContainerManagerApi = {
    getRuntime() {
      return runtimeInfo;
    },

    async pullImage(image: string, onProgress?: (msg: string) => void) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await pullImage(runtimeInfo, qualifyImageForRuntime(image, runtimeInfo), onProgress);
    },

    async imageExists(image: string) {
      if (!runtimeInfo) return false;
      return imageExists(runtimeInfo, qualifyImageForRuntime(image, runtimeInfo));
    },

    async ensureRunning(
      name: string,
      config: ContainerConfig,
      options?: HealthCheckOptions,
    ) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await ensureRunning(
        runtimeInfo,
        name,
        config,
        (msg) => app.debug(msg),
        options,
      );

      if (options?.healthCheck) {
        const existing = healthTimers.get(name);
        if (existing) clearInterval(existing);

        const timer = setInterval(async () => {
          try {
            const ok = await options.healthCheck!();
            if (!ok) {
              options.onUnhealthy?.(name, "Health check returned false");
            }
          } catch (err) {
            options.onUnhealthy?.(
              name,
              err instanceof Error ? err.message : String(err),
            );
          }
        }, 60000);
        healthTimers.set(name, timer);
      }
    },

    async start(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await startContainer(runtimeInfo, name);
    },

    async stop(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await stopContainer(runtimeInfo, name);
    },

    async remove(name: string) {
      if (!runtimeInfo) throw new Error("No container runtime available");
      await removeContainer(runtimeInfo, name);
    },

    async getState(name: string): Promise<ContainerState> {
      if (!runtimeInfo) return "no-runtime";
      return getContainerState(runtimeInfo, name);
    },

    async runJob(config: ContainerJobConfig): Promise<ContainerJobResult> {
      if (!runtimeInfo) throw new Error("No container runtime available");
      return runJob(runtimeInfo, config);
    },

    async prune(): Promise<PruneResult> {
      if (!runtimeInfo) throw new Error("No container runtime available");
      return pruneImages(runtimeInfo);
    },

    async listContainers(): Promise<ContainerInfo[]> {
      if (!runtimeInfo) return [];
      return listContainers(runtimeInfo);
    },
  };

  const plugin = {
    id: "signalk-container",
    name: "Container Manager",

    schema: {
      type: "object" as const,
      properties: {
        runtime: {
          type: "string",
          enum: ["auto", "podman", "docker"],
          default: "auto",
          title: "Container runtime",
          description:
            "Auto-detect (Podman preferred), or force a specific runtime",
        },
        pruneSchedule: {
          type: "string",
          enum: ["off", "weekly", "monthly"],
          default: "weekly",
          title: "Auto-prune dangling images",
        },
        maxConcurrentJobs: {
          type: "number",
          default: 2,
          title: "Max concurrent one-shot jobs",
          description: "Limit parallel container job executions",
        },
      },
    },

    start(config: PluginConfig) {
      // Expose API on global so other plugins can find it.
      // Each plugin gets a shallow copy of app (_.assign({}, app)),
      // so setting on app doesn't propagate. Global is the shared bus.
      (globalThis as any).__signalk_containerManager = api;

      // Async init — server does not await start()
      (async () => {
        const preference = config.runtime ?? "auto";
        app.debug("detecting runtime, preference=%s", preference);
        runtimeInfo = await detectRuntime(preference);
        app.debug("detectRuntime result: %o", runtimeInfo);

        if (!runtimeInfo) {
          app.setPluginError(
            "No container runtime found. Install Podman: sudo apt install podman",
          );
          return;
        }

        app.setPluginStatus(
          `${runtimeInfo.runtime} ${runtimeInfo.version}${runtimeInfo.isPodmanDockerShim ? " (podman shim)" : ""}`,
        );

      if (config.pruneSchedule && config.pruneSchedule !== "off") {
        const intervalMs =
          config.pruneSchedule === "weekly"
            ? 7 * 24 * 60 * 60 * 1000
            : 30 * 24 * 60 * 60 * 1000;
        pruneTimer = setInterval(async () => {
          try {
            const result = await pruneImages(runtimeInfo!);
            app.debug(
              `Pruned ${result.imagesRemoved} images, reclaimed ${result.spaceReclaimed}`,
            );
          } catch (err) {
            app.error("Auto-prune failed:", err);
          }
        }, intervalMs);
      }

        app.debug("Container manager started");
      })().catch((err) => {
        app.setPluginError(
          `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },

    stop() {
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
      for (const timer of healthTimers.values()) {
        clearInterval(timer);
      }
      healthTimers.clear();
      delete (globalThis as any).__signalk_containerManager;
    },

    registerWithRouter(router: IRouter) {
      router.get("/api/runtime", (_req, res) => {
        if (!runtimeInfo) {
          res.status(503).json({ error: "No container runtime available" });
          return;
        }
        res.json(runtimeInfo);
      });

      router.get("/api/containers", async (_req, res) => {
        try {
          const containers = await api.listContainers();
          res.json(containers);
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.get("/api/containers/:name/state", async (req, res) => {
        try {
          const state = await api.getState(req.params.name);
          res.json({ name: req.params.name, state });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.post("/api/containers/:name/stop", async (req, res) => {
        try {
          await api.stop(req.params.name);
          res.json({ status: "stopped" });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.post("/api/containers/:name/start", async (req, res) => {
        try {
          await api.start(req.params.name);
          res.json({ status: "started" });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.post("/api/containers/:name/remove", async (req, res) => {
        try {
          await api.remove(req.params.name);
          res.json({ status: "removed" });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.post("/api/prune", async (_req, res) => {
        try {
          const result = await api.prune();
          res.json(result);
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });
    },
  };

  return plugin;
};
