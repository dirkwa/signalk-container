import type { IRouter, Request, Response } from "express";
import type { UpdateService } from "./service.js";

/**
 * Express sub-router exposing the update service over HTTP. Mounted
 * by signalk-container's registerWithRouter at /api/updates/*.
 *
 * Critical UX: offline never produces a 5xx. Cached results come back
 * with HTTP 200 and reason: "offline" so the UI can render
 * "Last checked 3 days ago: up to date" rather than an error banner.
 */
export interface ApplyUpdateResult {
  status: "updated";
  containerName: string;
  version: string | null;
}

export function registerUpdateRoutes(
  router: IRouter,
  service: UpdateService,
  hasRuntime: () => boolean,
  // Defaulted so a caller that only wants detection — the tests, and any
  // embedder not wiring the container API — keeps working.
  applyUpdate: (pluginId: string) => Promise<ApplyUpdateResult> = async () => {
    throw new Error("Applying updates is not available");
  },
): void {
  router.get("/api/updates", (_req: Request, res: Response) => {
    if (!hasRuntime()) {
      res.status(503).json({ error: "No container runtime available" });
      return;
    }
    // Return last results for everything currently registered.
    // We use cached state via getLastResult — no live network call.
    const results = service
      .listRegistrations()
      .map((id) => service.getLastResult(id))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    res.json(results);
  });

  router.get("/api/updates/:pluginId", (req: Request, res: Response) => {
    if (!hasRuntime()) {
      res.status(503).json({ error: "No container runtime available" });
      return;
    }
    const pluginId = String(req.params.pluginId);
    const result = service.getLastResult(pluginId);
    if (!result) {
      res.status(404).json({ error: `No registration for ${pluginId}` });
      return;
    }
    res.json(result);
  });

  router.post(
    "/api/updates/:pluginId/check",
    async (req: Request, res: Response) => {
      if (!hasRuntime()) {
        res.status(503).json({ error: "No container runtime available" });
        return;
      }
      const pluginId = String(req.params.pluginId);
      try {
        const result = await service.checkOne(pluginId);
        // Always 200, even when offline. The body's `reason` field
        // tells the UI what happened.
        res.json(result);
      } catch (err) {
        // The only way checkOne throws is "no registration".
        res.status(404).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // Pull the newer image and recreate the container on it. The check route
  // only reports; without this the operator has to remove the container by
  // hand to act on what the UI just told them.
  router.post(
    "/api/updates/:pluginId/apply",
    async (req: Request, res: Response) => {
      if (!hasRuntime()) {
        res.status(503).json({ error: "No container runtime available" });
        return;
      }
      const pluginId = String(req.params.pluginId);
      try {
        res.json(await applyUpdate(pluginId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A caller naming something we do not manage is a 404; anything
        // else went wrong while pulling or recreating.
        const notFound = /no registration|no container config/i.test(message);
        res.status(notFound ? 404 : 500).json({ error: message });
      }
    },
  );
}
