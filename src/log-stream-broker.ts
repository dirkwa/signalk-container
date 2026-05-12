import { tailContainerLogs } from "./containers";
import { ContainerRuntimeInfo } from "./types";

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
 *   tail child sees its target disappear and exits naturally.  The
 *   broker's `onExit` handler nulls its `tail` reference so the
 *   wrapper's *next* subscribe re-spawns against the fresh
 *   container.  Subscribers see a brief gap; no zombie children.
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
  },
): LogStreamBroker {
  const spawnTail = options?.spawnTail ?? tailContainerLogs;
  const startTail = options?.startTail ?? 0;
  const onTailError = options?.onTailError;
  const onSubscriberError = options?.onSubscriberError;

  const subscribers = new Set<LogSubscriber>();
  let tail: { stop: () => void } | null = null;
  let closed = false;

  const fanOut = (line: string) => {
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

  const spawnIfNeeded = () => {
    if (tail !== null || closed) return;
    tail = spawnTail(runtime, name, fanOut, {
      startTail,
      onError: onTailError,
      onExit: () => {
        // Underlying child died — most commonly because the
        // container was removed (auto-recreate, manual rm, host
        // restart).  Null the handle so the next subscribe
        // respawns.  Don't notify subscribers — they're typically
        // still attached and expecting the broker to come back
        // when the container does.  If they need to know, the
        // wrapper has already called `close()` explicitly via
        // the remove path.
        tail = null;
      },
    });
  };

  const stopTail = () => {
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
