/**
 * Degradation notifications for managed containers
 * (`notifications.container.*`).
 *
 * A single emitter for the five managed-container degradation conditions
 * (unhealthy container, host-rejected device, missing required volume,
 * degraded runtime deployment, crash-looping container). It is ADDITIVE —
 * a parallel channel next to the existing log / plugin-status /
 * consumer-callback surfacing, never a replacement.
 *
 * Two things gate emission:
 *  - the config toggle (`emitDegradationNotifications`, default on), and
 *  - the server actually exposing the managed-notification API
 *    (`app.notifications`, SignalK ≥ 2.30.0). Absent → silent no-op, so an
 *    older server degrades to the existing surfacing without breaking.
 *
 * Deliberately NO `method` field on `raise`: the emitter states severity
 * only; the server's NotificationManager owns presentation (RFC
 * notification-handling §6.1). Path convention: a stable, addressable
 * `notifications.container.<name>.<condition>` (or
 * `notifications.container.deployment` for the host-level deployment
 * condition) with `idInPath: false`, so the same container+condition
 * updates one path instead of accumulating UUID-suffixed duplicates, and
 * the tracked NotificationId lets us `clear` on recovery.
 */
import type { DeviceIssue } from "./types.js";

/**
 * Restarts within one `CRASH_LOOP_WINDOW_MS` that mark a container as
 * crash-looping. A container under `--restart=unless-stopped` that dies
 * on startup cycles far faster than this; three restarts inside five
 * minutes is well clear of the one-off crash a healthy service may
 * suffer and recover from.
 */
const CRASH_LOOP_RESTARTS = 3;

/** Sliding window the restart delta is measured over. */
const CRASH_LOOP_WINDOW_MS = 5 * 60_000;

export type DegradationCondition =
  | "unhealthy"
  | "deviceUnresolved"
  | "volumeAborted"
  | "deploymentDegraded"
  | "crashLooping";

/** Minimal slice of the host `app` the emitter needs. */
export interface NotificationApp {
  error: (...args: unknown[]) => void;
  notifications?: {
    raise(options: {
      state: "normal" | "nominal" | "alert" | "warn" | "alarm" | "emergency";
      message: string;
      path: string;
      idInPath?: boolean;
      data?: unknown;
    }): string;
    clear(id: string): void;
  };
}

export interface DegradationEmitter {
  /** Raise (idempotently) a degradation notification for a container. */
  raise(
    condition: DegradationCondition,
    name: string,
    state: "warn" | "alert",
    message: string,
    data?: unknown,
  ): void;
  /** Clear a previously-raised notification; no-op if none is tracked. */
  clear(condition: DegradationCondition, name: string): void;
  /**
   * One health-check poll: `surface` fires on failure (log + consumer
   * handler); the unhealthy notification is raised on failure and cleared
   * on the unhealthy → healthy edge.
   */
  pollHealth(
    name: string,
    healthCheck: () => Promise<boolean>,
    surface: (reason: string) => void,
  ): Promise<void>;
  /**
   * Raise/clear the `deviceUnresolved` notification off a device-issue
   * set. Callers hold the authoritative `lastDeviceIssues` map; this only
   * mirrors the `unresolved` subset onto the notification bus so the two
   * can't diverge.
   */
  syncDeviceIssues(name: string, issues: DeviceIssue[]): void;
  /**
   * Feed one observation of a container's cumulative restart count and
   * raise/clear `crashLooping` from the RATE of change across
   * observations.
   *
   * The runtime reports only a lifetime total, which is legitimately
   * non-zero on a healthy container that has survived a host reboot
   * under `--restart=unless-stopped`. A threshold on the raw value would
   * therefore alert on uptime rather than on failure. The rate is
   * derived here instead, from the delta between consecutive samples and
   * the wall-clock gap between them, so only restarts that happen while
   * we are watching can raise the notification.
   *
   * `now` is injected so tests drive the clock directly rather than
   * sleeping through the window.
   */
  observeRestarts(
    name: string,
    restartCount: number | undefined,
    now?: number,
  ): void;
  /** Enable/disable emission (config toggle). Clears nothing. */
  setEnabled(enabled: boolean): void;
  /** Drop one container's health-tracking state (on container removal). */
  forgetContainer(name: string): void;
  /** Clear every outstanding notification and drop all tracking state. */
  reset(): void;
}

/** `notifications.container.<name>.<condition>` (or `.deployment`). */
export function notificationPath(
  condition: DegradationCondition,
  name: string,
): string {
  return condition === "deploymentDegraded"
    ? "notifications.container.deployment"
    : `notifications.container.${name}.${condition}`;
}

export function makeDegradationEmitter(
  app: NotificationApp,
  enabled = true,
): DegradationEmitter {
  // key `${condition}:${name}` → NotificationId (deployment uses name "").
  const raised = new Map<string, string>();
  // current health per container, for edge-triggered unhealthy raise/clear.
  const health = new Map<string, boolean>();
  // per-container signature of the currently-raised unresolved-device set,
  // so a changed set (e.g. /dev/a → /dev/b) re-raises with a fresh message
  // instead of the idempotent raise() no-op leaving the stale one live.
  const unresolvedSig = new Map<string, string>();
  // Last restart count we saw per container and when we saw it. The
  // baseline for the rate calculation in observeRestarts; a lifetime
  // total is meaningless without one.
  const restartBaseline = new Map<string, { count: number; at: number }>();
  // current health-check message, so a changed reason re-raises rather than
  // leaving the idempotent stale one live.
  const unhealthyReason = new Map<string, string>();
  // Generation guards so an in-flight pollHealth whose healthCheck resolves
  // AFTER forgetContainer()/reset() cannot re-raise a stale unhealthy
  // notification with no timer left to clear it. Bumped on each.
  const healthEpoch = new Map<string, number>();
  let resetEpoch = 0;
  let emit = enabled;

  const raise: DegradationEmitter["raise"] = (
    condition,
    name,
    state,
    message,
    data,
  ) => {
    if (!emit || !app.notifications?.raise) return;
    const key = `${condition}:${name}`;
    if (raised.has(key)) return; // idempotent; the stable path updates in place
    try {
      const id = app.notifications.raise({
        state,
        message,
        path: notificationPath(condition, name),
        idInPath: false,
        data,
      });
      raised.set(key, id);
    } catch (err) {
      app.error(
        `raiseDegradation(${key}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const clear: DegradationEmitter["clear"] = (condition, name) => {
    const key = `${condition}:${name}`;
    const id = raised.get(key);
    if (id === undefined) return;
    raised.delete(key);
    try {
      app.notifications?.clear(id);
    } catch (err) {
      app.error(
        `clearDegradation(${key}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const pollHealth: DegradationEmitter["pollHealth"] = async (
    name,
    healthCheck,
    surface,
  ) => {
    const startEpoch = healthEpoch.get(name) ?? 0;
    const startReset = resetEpoch;
    let healthy: boolean;
    let reason = "";
    try {
      healthy = await healthCheck();
      if (!healthy) reason = "Health check returned false";
    } catch (err) {
      healthy = false;
      reason = err instanceof Error ? err.message : String(err);
    }
    // If the container was forgotten or the emitter was reset while the
    // check was in flight, drop this result — otherwise we'd re-raise a
    // notification no surviving timer would ever clear.
    if (
      startReset !== resetEpoch ||
      startEpoch !== (healthEpoch.get(name) ?? 0)
    )
      return;
    if (!healthy) {
      surface(reason);
      // Re-raise on a changed reason (raise() is idempotent per key, so a
      // stale message would otherwise persist until recovery).
      if (unhealthyReason.get(name) !== reason) {
        clear("unhealthy", name);
        unhealthyReason.set(name, reason);
      }
      raise("unhealthy", name, "warn", `${name}: ${reason}`);
      health.set(name, false);
    } else {
      if (health.get(name) === false) clear("unhealthy", name);
      unhealthyReason.delete(name);
      health.set(name, true);
    }
  };

  const observeRestarts: DegradationEmitter["observeRestarts"] = (
    name,
    restartCount,
    now = Date.now(),
  ) => {
    // A runtime that does not report the field tells us nothing; keep the
    // previous baseline so an intermittently-absent value does not read as
    // a counter reset and discard a loop already in progress.
    if (
      typeof restartCount !== "number" ||
      !Number.isFinite(restartCount) ||
      restartCount < 0
    ) {
      return;
    }

    const prior = restartBaseline.get(name);

    // First sight of this container — in this process, or after a
    // recreate. Whatever the counter reads now is history we did not
    // witness (a host reboot may have restarted it many times), so it
    // becomes the baseline and raises nothing.
    if (prior === undefined) {
      restartBaseline.set(name, { count: restartCount, at: now });
      return;
    }

    // The counter went backwards: the container was recreated underneath
    // us and its lifetime count restarted. Re-baseline rather than
    // computing a negative delta.
    if (restartCount < prior.count) {
      restartBaseline.set(name, { count: restartCount, at: now });
      clear("crashLooping", name);
      return;
    }

    const elapsed = now - prior.at;

    // Window expired with the container below the threshold: it is not
    // looping now, whatever it did earlier. Slide the window forward and
    // drop any alert the previous window raised.
    if (elapsed >= CRASH_LOOP_WINDOW_MS) {
      restartBaseline.set(name, { count: restartCount, at: now });
      clear("crashLooping", name);
      return;
    }

    const restarts = restartCount - prior.count;
    if (restarts < CRASH_LOOP_RESTARTS) return;

    raise(
      "crashLooping",
      name,
      "alert",
      `${name}: restarted ${restarts} times in the last ${
        Math.round(elapsed / 60_000) || 1
      } min`,
      { restartCount, windowMs: elapsed },
    );
    // Start a fresh window from the restart that tripped the threshold.
    // Without this the baseline stays pinned to the original sample, so
    // the delta can never fall back below the threshold and the alert
    // would outlive the loop that caused it.
    restartBaseline.set(name, { count: restartCount, at: now });
  };

  const syncDeviceIssues: DegradationEmitter["syncDeviceIssues"] = (
    name,
    issues,
  ) => {
    const unresolved = issues.filter((e) => e.action === "unresolved");
    if (unresolved.length === 0) {
      unresolvedSig.delete(name);
      clear("deviceUnresolved", name);
      return;
    }
    const paths = unresolved.map((e) => e.hostPath).sort();
    const sig = paths.join(",");
    if (unresolvedSig.get(name) === sig) return; // same set already live
    // The set changed (or is new): drop the stale notification (raise() is
    // idempotent on a live key, so we must clear first) and re-raise with
    // the current paths.
    clear("deviceUnresolved", name);
    unresolvedSig.set(name, sig);
    raise(
      "deviceUnresolved",
      name,
      "warn",
      `${name}: device(s) missing on host: ${paths.join(", ")}`,
      { unresolved },
    );
  };

  return {
    raise,
    clear,
    pollHealth,
    syncDeviceIssues,
    observeRestarts,
    setEnabled: (enabled: boolean) => {
      emit = enabled;
    },
    forgetContainer: (name: string) => {
      healthEpoch.set(name, (healthEpoch.get(name) ?? 0) + 1);
      health.delete(name);
      unresolvedSig.delete(name);
      unhealthyReason.delete(name);
      restartBaseline.delete(name);
    },
    reset: () => {
      resetEpoch += 1;
      for (const id of raised.values()) {
        try {
          app.notifications?.clear(id);
        } catch {
          /* never throw from reset (called in stop()) */
        }
      }
      raised.clear();
      health.clear();
      unresolvedSig.clear();
      unhealthyReason.clear();
      restartBaseline.clear();
      // Disable emission until the next start() re-enables via setEnabled().
      // Without this, a raise() from an async startup step (e.g. the
      // deployment doctor) that resolves AFTER stop()+reset() would strand a
      // notification on the bus with no live plugin to ever clear it — the
      // raise/clear path has no per-call epoch guard the way pollHealth does.
      emit = false;
    },
  };
}
