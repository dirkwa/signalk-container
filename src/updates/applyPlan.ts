import type { ContainerConfig } from "../types.js";
import type { UpdateCheckResult } from "./types.js";
import { classifyTag } from "./tagClassifier.js";

// Everything that decides whether an update can be applied, separated from
// the pulling and recreating so the refusals can be tested without a runtime.
export interface ApplyPlan {
  containerName: string;
  imageRef: string;
  config: ContainerConfig;
  version: string | null;
}

export function planUpdateApply(
  pluginId: string,
  last: UpdateCheckResult | null,
  getConfig: (name: string) => ContainerConfig | undefined,
): ApplyPlan {
  if (!last) throw new Error(`No registration for plugin ${pluginId}`);

  // Recreating restarts the container, so a caller asking to apply nothing
  // gets told rather than a pointless outage.
  if (!last.updateAvailable) {
    throw new Error(
      `No update available for ${last.containerName} — run a check first`,
    );
  }

  const config = getConfig(last.containerName);
  // The config cache is in-process, so it is empty for a container whose
  // plugin has not called ensureRunning since the server started.
  if (!config) {
    throw new Error(
      `No container config for ${last.containerName} — restart the plugin that owns it, then retry`,
    );
  }

  // Only a floating tag resolves to a different image when pulled again. A
  // pinned one names the version it runs, so recreating it would reinstall
  // what is already there while reporting the newer version as installed.
  if (classifyTag(config.tag) !== "floating") {
    throw new Error(
      `${last.containerName} is pinned to ${config.tag} — set its image tag to ${last.latestVersion ?? "the new version"} in the owning plugin's settings`,
    );
  }

  return {
    containerName: last.containerName,
    imageRef: `${config.image}:${config.tag}`,
    config,
    version: last.latestVersion,
  };
}
