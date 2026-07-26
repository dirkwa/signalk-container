import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  makeDegradationEmitter,
  notificationPath,
  type NotificationApp,
} from "../notifications.js";
import type { DeviceIssue } from "../types.js";

interface RaiseCall {
  state: string;
  message: string;
  path: string;
  idInPath?: boolean;
  data?: unknown;
}

function makeApp(withNotifications = true) {
  const raises: RaiseCall[] = [];
  const cleared: string[] = [];
  const errors: unknown[] = [];
  let idSeq = 0;
  const app: NotificationApp = {
    error: (...args) => errors.push(args.join(" ")),
    notifications: withNotifications
      ? {
          raise: (o) => {
            raises.push(o);
            return `id-${idSeq++}`;
          },
          clear: (id) => cleared.push(id),
        }
      : undefined,
  };
  return { app, raises, cleared, errors };
}

describe("notificationPath", () => {
  it("builds a per-container path", () => {
    assert.equal(
      notificationPath("unhealthy", "questdb"),
      "notifications.container.questdb.unhealthy",
    );
  });
  it("uses the stable deployment path (no name)", () => {
    assert.equal(
      notificationPath("deploymentDegraded", ""),
      "notifications.container.deployment",
    );
  });
});

describe("degradation emitter — capability fallback", () => {
  it("no-ops (no throw) when the server has no notifications API", () => {
    const { app, errors } = makeApp(false);
    const e = makeDegradationEmitter(app);
    e.raise("unhealthy", "q", "warn", "msg");
    e.clear("unhealthy", "q");
    assert.equal(errors.length, 0);
  });
});

describe("degradation emitter — raise/clear lifecycle", () => {
  it("raises with the right path/state and NEVER sets method", () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    e.raise("volumeAborted", "grafana", "alert", "missing cert", { x: 1 });
    assert.equal(raises.length, 1);
    assert.equal(
      raises[0].path,
      "notifications.container.grafana.volumeAborted",
    );
    assert.equal(raises[0].state, "alert");
    assert.equal(raises[0].idInPath, false);
    assert.deepEqual(raises[0].data, { x: 1 });
    assert.ok(
      !("method" in (raises[0] as unknown as Record<string, unknown>)),
      "emitter must not set method (RFC P1)",
    );
  });

  it("is idempotent — a second raise for the same key does not re-raise", () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    e.raise("unhealthy", "q", "warn", "a");
    e.raise("unhealthy", "q", "warn", "a");
    assert.equal(raises.length, 1);
  });

  it("clear removes the tracked id; a second clear is a no-op", () => {
    const { app, cleared } = makeApp();
    const e = makeDegradationEmitter(app);
    e.raise("unhealthy", "q", "warn", "a");
    e.clear("unhealthy", "q");
    e.clear("unhealthy", "q");
    assert.deepEqual(cleared, ["id-0"]);
  });

  it("clear before any raise is a safe no-op", () => {
    const { app, cleared, errors } = makeApp();
    const e = makeDegradationEmitter(app);
    e.clear("volumeAborted", "q");
    assert.equal(cleared.length, 0);
    assert.equal(errors.length, 0);
  });
});

describe("degradation emitter — toggle", () => {
  it("does not raise when disabled", () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app, false);
    e.raise("unhealthy", "q", "warn", "a");
    assert.equal(raises.length, 0);
  });
  it("setEnabled(true) re-enables", () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app, false);
    e.setEnabled(true);
    e.raise("unhealthy", "q", "warn", "a");
    assert.equal(raises.length, 1);
  });
});

describe("degradation emitter — pollHealth edge semantics", () => {
  it("false health → surface + raise unhealthy warn", async () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    const surfaced: string[] = [];
    await e.pollHealth(
      "q",
      async () => false,
      (r) => surfaced.push(r),
    );
    assert.deepEqual(surfaced, ["Health check returned false"]);
    assert.equal(raises.length, 1);
    assert.equal(raises[0].state, "warn");
    assert.equal(raises[0].path, "notifications.container.q.unhealthy");
  });

  it("thrown health check → surface with the error message + raise", async () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    const surfaced: string[] = [];
    await e.pollHealth(
      "q",
      async () => {
        throw new Error("probe boom");
      },
      (r) => surfaced.push(r),
    );
    assert.deepEqual(surfaced, ["probe boom"]);
    assert.equal(raises.length, 1);
  });

  it("clears on the unhealthy → healthy edge only", async () => {
    const { app, raises, cleared } = makeApp();
    const e = makeDegradationEmitter(app);
    const noop = () => {};
    // healthy first: no raise, no clear (never was unhealthy)
    await e.pollHealth("q", async () => true, noop);
    assert.equal(raises.length, 0);
    assert.equal(cleared.length, 0);
    // unhealthy: raise
    await e.pollHealth("q", async () => false, noop);
    assert.equal(raises.length, 1);
    // healthy again: clear the edge
    await e.pollHealth("q", async () => true, noop);
    assert.deepEqual(cleared, ["id-0"]);
    // stays healthy: no extra clear
    await e.pollHealth("q", async () => true, noop);
    assert.equal(cleared.length, 1);
  });

  it("does not raise repeatedly while staying unhealthy (idempotent)", async () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    const noop = () => {};
    await e.pollHealth("q", async () => false, noop);
    await e.pollHealth("q", async () => false, noop);
    assert.equal(raises.length, 1);
  });
});

describe("degradation emitter — syncDeviceIssues", () => {
  const unresolved: DeviceIssue = {
    entry: "/dev/snd",
    hostPath: "/dev/snd",
    action: "unresolved",
    reason: "missing",
  };
  const skipped: DeviceIssue = {
    entry: "/dev/x",
    hostPath: "/dev/x",
    action: "skipped",
    reason: "gone",
  };

  it("raises deviceUnresolved when an unresolved entry is present", () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    e.syncDeviceIssues("q", [unresolved, skipped]);
    assert.equal(raises.length, 1);
    assert.equal(raises[0].path, "notifications.container.q.deviceUnresolved");
    assert.equal(raises[0].state, "warn");
  });

  it("clears deviceUnresolved when no unresolved entries remain", () => {
    const { app, cleared } = makeApp();
    const e = makeDegradationEmitter(app);
    e.syncDeviceIssues("q", [unresolved]);
    e.syncDeviceIssues("q", [skipped]); // resolved now
    assert.deepEqual(cleared, ["id-0"]);
  });
});

describe("degradation emitter — reset", () => {
  it("clears all outstanding notifications and forgets state", async () => {
    const { app, cleared } = makeApp();
    const e = makeDegradationEmitter(app);
    e.raise("unhealthy", "a", "warn", "x");
    e.raise("volumeAborted", "b", "alert", "y");
    e.reset();
    assert.equal(cleared.length, 2);
    // after reset, a raise for the same key works again (not still tracked)
    e.raise("unhealthy", "a", "warn", "x");
    e.clear("unhealthy", "a");
    assert.equal(cleared.length, 3);
  });
});
