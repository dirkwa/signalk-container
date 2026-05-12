import { tailContainerLogs } from "./containers";
import { ContainerRuntimeInfo } from "./types";

/**
 * Base delay between an underlying tail exiting and the broker
 * trying to respawn it, when subscribers are still attached.  Long
 * enough that the wrapper's `containers.remove(name)` → `close()`
 * race can win on the explicit-remove path; short enough that an
 * auto-recreate gap stays imperceptible.  Successive exits without
 * any line being delivered apply exponential backoff (×2 per try)
 * capped at `MAX_RESPAWN_DELAY_MS`, so a permanently-broken tail
 * doesn't churn the daemon at 1 spawn/sec indefinitely.  A single
 * delivered line resets the budget — that's our signal the new
 * tail is healthy.
 */
const RESPAWN_DELAY_MS = 1000;
const MAX_RESPAWN_DELAY_MS = 30_000;

/**
 * Why this exists / when the user is at risk
 *
 * Every place that wants to consume a managed container's log stream
 * — the plugin's `onContainerLog` callback, an SSE client, a future
 * health-watcher — would otherwise spawn its own `podman logs -f`
 * child.  Two end-users opening the Logs modal on the same container
 * doubles the number of `logs -f` processes the runtime daemon has
 * to serve; combined with `onContainerLog` it triples.
 *
 * The broker fans out a single underlying tail across N subscribers.
 * First subscribe spawns the child; last unsubscribe stops it.
 * Subscribers add themselves with a per-line callback and an
 * optional `onClose` (used by SSE handlers to flush a final
 * `event: end` frame before closing the response).
 *
 * Lifecycle interaction with the wrapper
 *
 *   Auto-recreate inside `ensureRunning` removes the live
 *   container and recursively re-enters.  The broker's underlying
 *   tail child sees its target disappear and exits naturally.  If
 *   subscribers are still attached, the broker auto-respawns after
 *   a 1s delay so SSE-only consumers (no plugin re-subscribe event
 *   to ride on) recover transparently.  Subscribers see a brief
 *   gap; no zombie children.
 *
 *   `containers.remove(name)` closes the broker explicitly
 *   (`close('container-removed')`), notifying every subscriber.
 *
 *   `plugin.stop()` closes every broker (`'plugin-stopped'`).
 *
 * Closed brokers refuse further subscriptions (return a no-op
 * unsubscribe); callers must allocate a fresh broker via the
 * wrapper's `getOrCreateBroker` after delete-from-Map.  This
 * matches the "broker is throw-away after close" model.
 */
export interface LogSubscriber {
  /** Per-line callback.  Errors caught by the broker; never crash
   *  the fan-out for other subscribers. */
  onLine: (line: string) => void;
  /** Called once when the broker is force-closed.  SSE handlers
   *  flush their `event: end` frame and `end()` the response. */
  onClose?: (reason: "container-removed" | "plugin-stopped") => void;
}

export interface LogStreamBroker {
  /** Returns an unsubscribe function.  First subscribe lazily
   *  spawns the underlying tail; the unsubscribe that drops the
   *  count to zero stops it.  After a `close()`, returns a no-op
   *  unsubscribe (caller should allocate a fresh broker). */
  subscribe(sub: LogSubscriber): () => void;
  /** Current subscriber count.  Used by the wrapper to decide
   *  whether to delete the broker from its Map after an SSE
   *  client disconnects. */
  subscriberCount(): number;
  /** Force-close: stops the tail, notifies every subscriber via
   *  `onClose`, drops the subscriber set.  Idempotent. */
  close(reason: "container-removed" | "plugin-stopped"): void;
  isClosed(): boolean;
}

/**
 * Factory for a per-container `LogStreamBroker`.  `runtime` and
 * `name` are captured for the eventual `tailContainerLogs` call.
 * `spawnTail` is injectable for tests.
 *
 * `onSubscriberError` is invoked when a subscriber's `onLine`
 * throws — kept out of the fan-out so one buggy subscriber can't
 * silence the others.  Defaults to swallowing the error (the
 * broker has no logger; the wrapper provides one).
 */
export function createLogStreamBroker(
  runtime: ContainerRuntimeInfo,
  name: string,
  options?: {
    startTail?: number;
    /** Test injection: defaults to `tailContainerLogs`. */
    spawnTail?: typeof tailContainerLogs;
    /** Surfaces `podman logs` stderr and process-spawn failures. */
    onTailError?: (msg: string) => void;
    /** Surfaces per-subscriber `onLine` throws. */
    onSubscriberError?: (err: unknown, subscriberIndex: number) => void;
    /** Test injection: shorter delay before auto-respawning the tail
     *  after onExit.  Defaults to `RESPAWN_DELAY_MS` (1s) in prod. */
    respawnDelayMs?: number;
  },
): LogStreamBroker {
  const spawnTail = options?.spawnTail ?? tailContainerLogs;
  const startTail = options?.startTail ?? 0;
  const onTailError = options?.onTailError;
  const onSubscriberError = options?.onSubscriberError;
  const respawnDelayMs = options?.respawnDelayMs ?? RESPAWN_DELAY_MS;

  const subscribers = new Set<LogSubscriber>();
  let tail: { stop: () => void } | null = null;
  let closed = false;
  // Pending auto-respawn timer.  Tracked so `close()` and `stopTail()`
  // can cancel it cleanly.
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive respawns since the last delivered line; drives
  // exponential backoff so a permanently-broken tail doesn't churn.
  let consecutiveRespawns = 0;

  const fanOut = (line: string) => {
    // A line delivered means the new tail is healthy — reset the
    // backoff so the *next* exit gets the fast 1s recovery again.
    consecutiveRespawns = 0;
    let i = 0;
    for (const sub of subscribers) {
      try {
        sub.onLine(line);
      } catch (err) {
        onSubscriberError?.(err, i);
      }
      i++;
    }
  };

  const scheduleRespawn = () => {
    if (respawnTimer !== null || closed) return;
    if (subscribers.size === 0) return;
    // Exponential backoff capped at MAX_RESPAWN_DELAY_MS in
    // production.  Tests inject a tiny `respawnDelayMs`; we cap at
    // `respawnDelayMs * 30` for that case so test backoff stays
    // bounded without forcing the test to wait 30s.
    const cap =
      respawnDelayMs >= RESPAWN_DELAY_MS
        ? MAX_RESPAWN_DELAY_MS
        : respawnDelayMs * 30;
    const delay = Math.min(respawnDelayMs * 2 ** consecutiveRespawns, cap);
    consecutiveRespawns++;
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      // Re-check at fire time: a subscriber may have unsubscribed
      // (dropping count to 0) or the broker may have been closed
      // during the delay window.  spawnIfNeeded() guards against
      // closed; the subscriber-count guard is here.
      if (subscribers.size === 0) return;
      spawnIfNeeded();
    }, delay);
    // Don't pin the event loop open during shutdown.
    respawnTimer.unref();
  };

  const cancelRespawn = () => {
    if (respawnTimer !== null) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
  };

  const spawnIfNeeded = () => {
    if (tail !== null || closed) return;
    // Capture the handle in a closure-local so a late onExit from
    // *this* tail can't clobber a newer one.  Scenario this guards
    // against: unsub-to-zero stops the tail (SIGTERM the child) and
    // sets `tail = null`; a fresh subscribe spawns tail #2 BEFORE
    // tail #1's `close` event has fired; tail #1's onExit then
    // arrives and would otherwise null `tail` (clobbering handle
    // #2) and schedule a respawn (eventually spawning a stale
    // tail #3).
    let thisTail: { stop: () => void } | null = null;
    thisTail = spawnTail(runtime, name, fanOut, {
      startTail,
      onError: onTailError,
      onExit: () => {
        if (tail !== thisTail) return;
        tail = null;
        scheduleRespawn();
      },
    });
    tail = thisTail;
  };

  const stopTail = () => {
    cancelRespawn();
    if (tail) {
      tail.stop();
      tail = null;
    }
  };

  return {
    subscribe(sub: LogSubscriber): () => void {
      if (closed) {
        // Refuse further subscriptions.  Caller (the wrapper)
        // should allocate a fresh broker.
        return () => {};
      }
      subscribers.add(sub);
      spawnIfNeeded();
      return () => {
        if (!subscribers.has(sub)) return;
        subscribers.delete(sub);
        if (subscribers.size === 0) stopTail();
      };
    },

    subscriberCount(): number {
      return subscribers.size;
    },

    close(reason: "container-removed" | "plugin-stopped"): void {
      if (closed) return;
      closed = true;
      // Snapshot before clearing — subscribers may resubscribe
      // synchronously inside onClose (though we discourage it).
      const snapshot = Array.from(subscribers);
      subscribers.clear();
      stopTail();
      for (const sub of snapshot) {
        try {
          sub.onClose?.(reason);
        } catch (err) {
          onSubscriberError?.(err, -1);
        }
      }
    },

    isClosed(): boolean {
      return closed;
    },
  };
}
