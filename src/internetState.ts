/**
 * The connectivity state published by the signalk-internet plugin. While it
 * reports a link that costs money per byte or carries no traffic, nothing
 * here should reach the network on its own; a pull or check the user starts
 * still runs.
 */
export const INTERNET_STATE_PATH = "network.internet.state";

const RESTRICTED_STATES: ReadonlySet<string> = new Set([
  "metered",
  "offline",
  "captive",
]);

/**
 * `getSelfPath` returns the leaf node (`{ value, $source, timestamp }`) on
 * the Signal K server; a bare value is accepted too so a stub can return one.
 */
export function isInternetRestricted(
  getSelfPath: ((path: string) => unknown) | undefined,
): boolean {
  if (!getSelfPath) return false;
  const node = getSelfPath(INTERNET_STATE_PATH);
  const value =
    node !== null && typeof node === "object"
      ? (node as { value?: unknown }).value
      : node;
  return typeof value === "string" && RESTRICTED_STATES.has(value);
}
