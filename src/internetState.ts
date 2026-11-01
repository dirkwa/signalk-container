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
import type { InternetCheckOptions } from "./types.js";

export const INTERNET_STATE_PATH = "network.internet.state";
export const INTERNET_PLUGIN_ID = "signalk-internet";

/** setTimeout's largest delay; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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

/** What ended a wait for a state. */
type WakeReason = "change" | "timeout" | "abort" | "stop";

export class InternetState {
  private value: unknown = undefined;
  private unsubscribes: Array<() => void> = [];
  private waiters = new Set<(reason: WakeReason) => void>();
  // Bumped by every stop(), so a check that awaited across one stops waiting.
  private generation = 0;
  // Nothing wakes a wait while stopped, so a check then does not wait.
  private started = false;

  constructor(private readonly app: InternetStateApp) {}

  start(): void {
    this.stop();
    this.started = true;
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
            if (v.path !== INTERNET_STATE_PATH) continue;
            this.value = v.value;
            this.wakeWaiters("change");
          }
        }
      },
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.value = undefined;
    this.started = false;
    this.generation++;
    this.wakeWaiters("stop");
  }

  /**
   * Without a state (none published since this started, or the null
   * signalk-internet publishes when it stops), an enabled plugin is still
   * working out the link after a boot or a restart of its own. That reads
   * as restricted, so a start on a metered link does not pull before the
   * first state arrives. The plugin list is asked only then, at the time of
   * the check: the server adds a plugin to that list after starting it, so
   * a list read at this plugin's own start can still lack signalk-internet.
   *
   * With `waitMs`, a check made in that window waits for the first state
   * instead, up to `waitMs` from the call, until `signal` aborts, or until
   * this stops. The null signalk-internet publishes when it stops or
   * restarts does not end the wait: the list is asked again, and a
   * disabled plugin then means unrestricted.
   */
  async isRestricted({
    waitMs = 0,
    signal,
  }: InternetCheckOptions = {}): Promise<boolean> {
    const deadline = performance.now() + waitMs;
    const generation = this.generation;
    for (;;) {
      const known = this.restricted();
      if (known !== null) return known;
      const publisherEnabled = await this.publisherEnabled();
      // A state that came in while the list was read is the answer.
      const arrived = this.restricted();
      if (arrived !== null) return arrived;
      if (!publisherEnabled) return false;
      if (generation !== this.generation || !this.started) return true;
      const remaining = deadline - performance.now();
      const woke = await this.waitForState(remaining, signal);
      // A wait longer than one timer allows runs on past that timer.
      const clamped = woke === "timeout" && remaining > MAX_TIMER_MS;
      if (woke !== "change" && !clamped) return this.restricted() ?? true;
    }
  }

  /** Whether the published state restricts traffic; null without one. */
  private restricted(): boolean | null {
    return typeof this.value === "string"
      ? RESTRICTED_STATES.has(this.value)
      : null;
  }

  private waitForState(ms: number, signal?: AbortSignal): Promise<WakeReason> {
    if (signal?.aborted) return Promise.resolve("abort");
    if (ms <= 0) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      const done = (reason: WakeReason) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(done);
        resolve(reason);
      };
      const onAbort = () => done("abort");
      const timer = setTimeout(
        () => done("timeout"),
        Math.min(ms, MAX_TIMER_MS),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(done);
    });
  }

  private wakeWaiters(reason: WakeReason): void {
    for (const wake of [...this.waiters]) wake(reason);
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
