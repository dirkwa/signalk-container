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
   * derived here instead, from timestamped samples held over a SLIDING
   * window, so only restarts that happen while we are watching can raise
   * the notification.
   *
   * The window slides rather than tumbles because a fixed baseline that
   * resets on expiry splits a burst that straddles the boundary: one
   * restart before the reset and two after it are three restarts inside
   * two minutes, and must alert.
   *
   * A gap between observations longer than the window re-anchors instead
   * of alerting. The restarts are real but undatable, and charging them
   * to the last five minutes would report a rate that was never
   * observed.
   *
   * `now` is injected so tests drive the clock directly rather than
   * sleeping through the window.
   */
  observeRestarts(
    name: string,
    restartCount: number | undefined,
    now?: number,
    epoch?: number,
  ): void;
  /**
   * The container's current restart-tracking epoch, bumped whenever its
   * history is dropped (removal, or `forgetRestarts`). A poller reads it
   * before inspecting and passes it back to `observeRestarts`, so a
   * result that arrives after the container was removed is discarded
   * rather than re-seeding history for whatever now holds the name.
   */
  restartEpoch(name: string): number;
  /**
   * Drop a container's restart history and clear any crash-loop alert,
   * without touching the health or device-issue tracking that
   * `forgetContainer` also resets. For the poll to use when a container
   * has vanished from the runtime: its history says nothing about the
   * next container to take the name, but an `ensureRunning` may still be
   * managing it, so the rest of its state must survive.
   */
  forgetRestarts(name: string): void;
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
  // Timestamped restart-count samples per container, oldest first, pruned
  // to the crash-loop window. A lifetime total is meaningless on its own,
  // and a single baseline cannot answer "three restarts in the last five
  // minutes" across a window boundary — see observeRestarts.
  const restartSamples = new Map<string, { count: number; at: number }[]>();
  // Per-container restart-tracking epoch, bumped whenever the history is
  // dropped. Lets a poller discard an inspect that resolved after the
  // container it described was removed — a replacement taking the same
  // name is a different container, and mixing their counts would
  // overcount restarts.
  const restartEpochs = new Map<string, number>();
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

  const bumpRestartEpoch = (name: string): void => {
    restartEpochs.set(name, (restartEpochs.get(name) ?? 0) + 1);
  };

  const observeRestarts: DegradationEmitter["observeRestarts"] = (
    name,
    restartCount,
    now = Date.now(),
    epoch,
  ) => {
    // The container this observation describes has been removed since the
    // caller read the count; whatever holds the name now is a different
    // container.
    if (epoch !== undefined && epoch !== (restartEpochs.get(name) ?? 0)) {
      return;
    }
    // A runtime that does not report the field tells us nothing; keep the
    // samples we have so an intermittently-absent value does not read as a
    // counter reset and discard a loop already in progress.
    if (
      typeof restartCount !== "number" ||
      !Number.isFinite(restartCount) ||
      restartCount < 0
    ) {
      return;
    }

    const samples = restartSamples.get(name);

    // First sight of this container — in this process, or after a
    // recreate. Whatever the counter reads now is history we did not
    // witness (a host reboot may have restarted it many times), so it
    // only seeds the window and raises nothing.
    if (samples === undefined) {
      restartSamples.set(name, [{ count: restartCount, at: now }]);
      return;
    }

    // The counter went backwards: the container was recreated underneath
    // us and its lifetime count restarted. Drop the history rather than
    // computing a negative delta against it.
    if (restartCount < samples[samples.length - 1].count) {
      restartSamples.set(name, [{ count: restartCount, at: now }]);
      clear("crashLooping", name);
      return;
    }

    samples.push({ count: restartCount, at: now });

    // Keep the newest sample that predates the window alongside those
    // inside it: it carries the count as the window opened, and without
    // it a burst straddling the boundary reads as only its tail.
    const cutoff = now - CRASH_LOOP_WINDOW_MS;
    let anchor = 0;
    while (anchor + 1 < samples.length && samples[anchor + 1].at <= cutoff) {
      anchor += 1;
    }
    if (anchor > 0) samples.splice(0, anchor);

    // The anchor is only usable while the poll is keeping up. When the
    // sample before this one also predates the window, nothing was
    // observed inside it at all: the poll stalled, and the restarts
    // since are real but undatable. Charging them to the last five
    // minutes would alert on a rate never observed — the very error
    // reading a raw lifetime count makes. Re-anchor and wait for a
    // window actually watched.
    if (samples.length >= 2 && samples[samples.length - 2].at < cutoff) {
      restartSamples.set(name, [{ count: restartCount, at: now }]);
      clear("crashLooping", name);
      return;
    }

    const oldest = samples[0];
    const restarts = restartCount - oldest.count;

    if (restarts >= CRASH_LOOP_RESTARTS) {
      const spanMs = now - oldest.at;
      raise(
        "crashLooping",
        name,
        "alert",
        `${name}: restarted ${restarts} times in the last ${
          Math.round(spanMs / 60_000) || 1
        } min`,
        { restartCount, windowMs: spanMs },
      );
      return;
    }

    // Below the threshold across the whole window: any alert the loop
    // raised has outlived the loop itself. Clearing is idempotent when
    // nothing is raised.
    clear("crashLooping", name);
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
    restartEpoch: (name: string) => restartEpochs.get(name) ?? 0,
    forgetRestarts: (name: string) => {
      bumpRestartEpoch(name);
      restartSamples.delete(name);
      clear("crashLooping", name);
    },
    setEnabled: (enabled: boolean) => {
      emit = enabled;
    },
    forgetContainer: (name: string) => {
      healthEpoch.set(name, (healthEpoch.get(name) ?? 0) + 1);
      health.delete(name);
      unresolvedSig.delete(name);
      unhealthyReason.delete(name);
      bumpRestartEpoch(name);
      restartSamples.delete(name);
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
      restartSamples.clear();
      restartEpochs.clear();
      // Disable emission until the next start() re-enables via setEnabled().
      // Without this, a raise() from an async startup step (e.g. the
      // deployment doctor) that resolves AFTER stop()+reset() would strand a
      // notification on the bus with no live plugin to ever clear it — the
      // raise/clear path has no per-call epoch guard the way pollHealth does.
      emit = false;
    },
  };
}
