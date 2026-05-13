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
export function registerUpdateRoutes(
  router: IRouter,
  service: UpdateService,
  hasRuntime: () => boolean,
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
}
