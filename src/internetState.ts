/**
 * The connectivity state published by the signalk-internet plugin. While it
 * reports a link that costs money per byte or carries no traffic, nothing
 * here should reach the network on its own; a pull or check the user starts
 * still runs. Without that plugin running, behaviour is unchanged.
 *
 * The state comes from one subscription, from start to stop. The server
 * sends the last value when the subscription starts, and signalk-internet
 * publishes null when it stops, so a disabled plugin leaves nothing behind.
 */
export const INTERNET_STATE_PATH = "network.internet.state";
export const INTERNET_PLUGIN_ID = "signalk-internet";

const RESTRICTED_STATES: ReadonlySet<string> = new Set([
  "metered",
  "offline",
  "captive",
]);

interface StateDelta {
  updates?: Array<{ values?: Array<{ path?: string; value?: unknown }> }>;
}

export interface InternetStateApp {
  error: (msg: string) => void;
  subscriptionmanager?: {
    subscribe: (
      subscription: {
        context: string;
        subscribe: Array<{ path: string; policy: string }>;
      },
      unsubscribes: Array<() => void>,
      onError: (err: unknown) => void,
      onDelta: (delta: StateDelta) => void,
    ) => void;
  };
  getPluginsList?: () => Promise<Array<{ id: string; enabled?: boolean }>>;
}

export class InternetState {
  private value: unknown = undefined;
  private unsubscribes: Array<() => void> = [];

  constructor(private readonly app: InternetStateApp) {}

  start(): void {
    this.stop();
    this.app.subscriptionmanager?.subscribe(
      {
        context: "vessels.self",
        subscribe: [{ path: INTERNET_STATE_PATH, policy: "instant" }],
      },
      this.unsubscribes,
      (err) => this.app.error(`signalk-internet state subscription: ${err}`),
      (delta) => {
        for (const update of delta.updates ?? []) {
          for (const v of update.values ?? []) {
            if (v.path === INTERNET_STATE_PATH) this.value = v.value;
          }
        }
      },
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.value = undefined;
  }

  /**
   * Without a state (none published since this started, or the null
   * signalk-internet publishes when it stops), an enabled plugin is still
   * working out the link after a boot or a restart of its own. That reads
   * as restricted, so a start on a metered link does not pull before the
   * first state arrives. The plugin list is asked only then, at the time of
   * the check: the server adds a plugin to that list after starting it, so
   * a list read at this plugin's own start can still lack signalk-internet.
   */
  async isRestricted(): Promise<boolean> {
    if (typeof this.value !== "string") {
      const publisherEnabled = await this.publisherEnabled();
      if (typeof this.value !== "string") return publisherEnabled;
    }
    return RESTRICTED_STATES.has(this.value);
  }

  private async publisherEnabled(): Promise<boolean> {
    if (!this.app.getPluginsList) return false;
    try {
      return (await this.app.getPluginsList()).some(
        (plugin) => plugin.id === INTERNET_PLUGIN_ID && plugin.enabled === true,
      );
    } catch {
      return false;
    }
  }
}
