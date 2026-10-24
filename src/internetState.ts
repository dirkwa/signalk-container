/**
 * The connectivity state published by the signalk-internet plugin. While it
 * reports a link that costs money per byte or carries no traffic, nothing
 * here should reach the network on its own; a pull or check the user starts
 * still runs. Without that plugin running, behaviour is unchanged.
 */
export const INTERNET_STATE_PATH = "network.internet.state";
export const INTERNET_PLUGIN_ID = "signalk-internet";

const RESTRICTED_STATES: ReadonlySet<string> = new Set([
  "metered",
  "offline",
  "captive",
]);

export interface InternetStateSource {
  /** Leaf node (`{ value, $source, timestamp }`) or a bare value. */
  getSelfPath?: (path: string) => unknown;
  getPluginsList?: () => Promise<Array<{ id: string; enabled?: boolean }>>;
}

/**
 * The plugin's last value outlives the plugin: once it is disabled the
 * server keeps serving it until restart, so the value only counts while the
 * plugin is enabled. An enabled plugin that has not published yet is still
 * working out the link after startup, which reads as restricted so a boot
 * on a metered link does not pull before the first state arrives.
 */
export async function isInternetRestricted(
  app: InternetStateSource,
): Promise<boolean> {
  if (!app.getSelfPath || !app.getPluginsList) return false;
  let enabled: boolean;
  try {
    enabled = (await app.getPluginsList()).some(
      (plugin) => plugin.id === INTERNET_PLUGIN_ID && plugin.enabled === true,
    );
  } catch {
    return false;
  }
  if (!enabled) return false;
  const node = app.getSelfPath(INTERNET_STATE_PATH);
  const value =
    node !== null && typeof node === "object"
      ? (node as { value?: unknown }).value
      : node;
  if (value === undefined || value === null) return true;
  return typeof value === "string" && RESTRICTED_STATES.has(value);
}
