/**
 * Containers left behind by a plugin that was uninstalled.
 *
 * Removing a plugin removes its package, not its container: with the
 * `unless-stopped` restart policy the container outlives both the plugin
 * and server restarts. The manifest records which plugin owns a container
 * (`EnsureRunningOptions.pluginId`), so once the server has loaded its
 * plugins, a recorded owner that is not among them identifies the leftover.
 *
 * Pure decision logic; `src/index.ts` gathers the inputs and acts on the
 * result.
 */

/** How long after startup the check runs. Signal K loads plugins one after
 *  another, so a list read at this plugin's own start can still be missing
 *  owners that load later, and an owner needs time to call ensureRunning. */
export const ORPHAN_CHECK_DELAY_MS = 2 * 60_000;

export interface OrphanCheckInput {
  /** Recorded owner per unprefixed container name. Containers recorded only
   *  under the synthetic `container:<name>` id have no owner and are left
   *  out — their plugin cannot be identified. */
  owners: Map<string, string>;
  /** Unprefixed names of the managed containers on the runtime. */
  present: string[];
  /** Ids of the plugins the server has loaded, or null when it cannot say. */
  installedPluginIds: Set<string> | null;
  /** Containers a consumer brought up with ensureRunning since this plugin
   *  started: their owner is evidently running, whatever its id. */
  claimed: Set<string>;
  /** Whether a package of this name is installed. Covers a consumer that
   *  records its npm package name rather than its plugin id. */
  packageInstalled: (name: string) => boolean;
}

export interface Orphan {
  name: string;
  owner: string;
}

export function findOrphans(input: OrphanCheckInput): Orphan[] {
  // No list, or an empty one, says nothing about what is installed: acting
  // on it would flag every container.
  if (!input.installedPluginIds || input.installedPluginIds.size === 0) {
    return [];
  }
  const orphans: Orphan[] = [];
  for (const name of input.present) {
    const owner = input.owners.get(name);
    if (owner === undefined || input.claimed.has(name)) continue;
    if (input.installedPluginIds.has(owner)) continue;
    if (input.packageInstalled(owner)) continue;
    orphans.push({ name, owner });
  }
  return orphans;
}
