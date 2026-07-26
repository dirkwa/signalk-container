/**
 * Degradation notifications for managed containers
 * (`notifications.container.*`).
 *
 * A single emitter for the four managed-container degradation conditions
 * (unhealthy container, host-rejected device, missing required volume,
 * degraded runtime deployment). It is ADDITIVE — a parallel channel next
 * to the existing log / plugin-status / consumer-callback surfacing, never
 * a replacement.
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

export type DegradationCondition =
  "unhealthy" | "deviceUnresolved" | "volumeAborted" | "deploymentDegraded";

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
    setEnabled: (enabled: boolean) => {
      emit = enabled;
    },
    forgetContainer: (name: string) => {
      healthEpoch.set(name, (healthEpoch.get(name) ?? 0) + 1);
      health.delete(name);
      unresolvedSig.delete(name);
      unhealthyReason.delete(name);
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
    },
  };
}
