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

  it("logs via app.error and does not throw when raise() throws", () => {
    const { app, errors } = makeApp();
    app.notifications!.raise = () => {
      throw new Error("boom");
    };
    const e = makeDegradationEmitter(app);
    assert.doesNotThrow(() => e.raise("unhealthy", "q", "warn", "a"));
    assert.equal(errors.length, 1);
  });

  it("logs via app.error and does not throw when clear() throws", () => {
    const { app, errors } = makeApp();
    const e = makeDegradationEmitter(app);
    e.raise("unhealthy", "q", "warn", "a");
    app.notifications!.clear = () => {
      throw new Error("boom");
    };
    assert.doesNotThrow(() => e.clear("unhealthy", "q"));
    assert.equal(errors.length, 1);
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
    await e.pollHealth("q", async () => true, noop);
    assert.equal(raises.length, 0);
    assert.equal(cleared.length, 0);
    await e.pollHealth("q", async () => false, noop);
    assert.equal(raises.length, 1);
    await e.pollHealth("q", async () => true, noop);
    assert.deepEqual(cleared, ["id-0"]);
    // A second healthy poll must NOT clear again — only the edge clears.
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

  it("re-raises with a fresh message when the unhealthy reason changes", async () => {
    const { app, raises, cleared } = makeApp();
    const e = makeDegradationEmitter(app);
    const noop = () => {};
    await e.pollHealth(
      "q",
      async () => {
        throw new Error("reason A");
      },
      noop,
    );
    await e.pollHealth(
      "q",
      async () => {
        throw new Error("reason B");
      },
      noop,
    );
    assert.equal(cleared.length, 1, "the stale reason-A notification clears");
    assert.equal(raises.length, 2);
    assert.match(raises[1].message, /reason B/);
  });

  it("drops an in-flight poll whose result lands after reset() (no stale raise)", async () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    let release!: (v: boolean) => void;
    const gate = new Promise<boolean>((r) => {
      release = r;
    });
    const poll = e.pollHealth(
      "q",
      () => gate,
      () => {},
    );
    e.reset(); // reset while the check is in flight
    release(false); // now the (would-be unhealthy) check resolves
    await poll;
    assert.equal(
      raises.length,
      0,
      "a poll resolving after reset must not raise a stale notification",
    );
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

  it("re-raises with a fresh message when the unresolved set changes ([a] -> [b])", () => {
    const { app, raises, cleared } = makeApp();
    const e = makeDegradationEmitter(app);
    const devA: DeviceIssue = {
      entry: "/dev/a",
      hostPath: "/dev/a",
      action: "unresolved",
      reason: "missing",
    };
    const devB: DeviceIssue = {
      entry: "/dev/b",
      hostPath: "/dev/b",
      action: "unresolved",
      reason: "missing",
    };
    e.syncDeviceIssues("q", [devA]);
    e.syncDeviceIssues("q", [devB]);
    // The stale /dev/a notification is cleared and a fresh one raised for
    // /dev/b — not left showing /dev/a.
    assert.equal(cleared.length, 1);
    assert.equal(raises.length, 2);
    assert.match(raises[1].message, /\/dev\/b/);
    assert.doesNotMatch(raises[1].message, /\/dev\/a/);
  });

  it("does not re-raise when the same unresolved set repeats (order-insensitive)", () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    const a: DeviceIssue = {
      entry: "/dev/a",
      hostPath: "/dev/a",
      action: "unresolved",
      reason: "m",
    };
    const b: DeviceIssue = {
      entry: "/dev/b",
      hostPath: "/dev/b",
      action: "unresolved",
      reason: "m",
    };
    e.syncDeviceIssues("q", [a, b]);
    e.syncDeviceIssues("q", [b, a]); // same set, different order
    assert.equal(raises.length, 1);
  });
});

describe("degradation emitter — forgetContainer", () => {
  it("drops health tracking so the next unhealthy poll re-raises cleanly", async () => {
    const { app, raises, cleared } = makeApp();
    const e = makeDegradationEmitter(app);
    const noop = () => {};
    await e.pollHealth("q", async () => false, noop); // raise id-0
    assert.equal(raises.length, 1);
    e.forgetContainer("q"); // drops health state (but the raised id is still tracked)
    // Next unhealthy poll: raised map still holds the key, so idempotent —
    // no duplicate. The point is forgetContainer doesn't crash and the
    // health edge is reset (a later healthy poll won't spuriously clear,
    // since we never observed an unhealthy→healthy edge post-forget).
    await e.pollHealth("q", async () => true, noop);
    // No unhealthy→healthy edge was tracked after forget, so nothing clears.
    assert.equal(cleared.length, 0);
  });
});

describe("degradation emitter — reset", () => {
  it("clears all outstanding notifications and drops tracking state", () => {
    const { app, cleared } = makeApp();
    const e = makeDegradationEmitter(app);
    e.raise("unhealthy", "a", "warn", "x");
    e.raise("volumeAborted", "b", "alert", "y");
    e.reset();
    assert.equal(cleared.length, 2);
  });

  it("disables emission after reset (a late raise must not strand)", () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    e.reset();
    // A raise arriving after reset() — e.g. from an async startup step that
    // resolved after stop() — must NOT publish, or it would strand a
    // notification with no live plugin to clear it.
    e.raise("deploymentDegraded", "", "warn", "late");
    assert.equal(raises.length, 0);
  });

  it("setEnabled(true) after reset re-enables emission (the next start())", () => {
    const { app, raises } = makeApp();
    const e = makeDegradationEmitter(app);
    e.reset();
    e.setEnabled(true);
    e.raise("unhealthy", "a", "warn", "x");
    assert.equal(raises.length, 1);
  });
});
