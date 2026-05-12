import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogStreamBroker } from "../log-stream-broker";
import type { ContainerRuntimeInfo } from "../types";

const runtime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "test",
  isPodmanDockerShim: false,
};

/**
 * Make a fake tail factory that can be driven by the test:
 *
 *   const { spawnTail, emit, stop, stopCount } = makeFakeTail();
 *   emit("line1");          // feeds the broker's fanOut
 *   stop();                 // simulates the underlying child dying
 *                           //   (triggers the broker's onExit which
 *                           //   nulls its tail handle)
 *
 * `spawnCalls` counts how many times the broker spawned a fresh
 * tail.  Each spawn re-binds the active emit/stop so a re-spawn
 * after the previous tail "died" is observable.
 */
function makeFakeTail() {
  type Active = {
    onLine: (line: string) => void;
    onExit?: (code: number | null) => void;
    stopped: boolean;
  };
  const actives: Active[] = [];
  const stopCounts: number[] = [];

  const spawnTail: typeof import("../containers").tailContainerLogs = (
    _runtime,
    _name,
    onLine,
    options,
  ) => {
    const active: Active = { onLine, onExit: options?.onExit, stopped: false };
    actives.push(active);
    const idx = actives.length - 1;
    stopCounts[idx] = 0;
    return {
      stop: () => {
        active.stopped = true;
        stopCounts[idx]++;
      },
      pid: 1000 + idx,
    };
  };

  return {
    spawnTail,
    /** Send a line to the most recent active tail. */
    emit: (line: string) => {
      const a = actives[actives.length - 1];
      if (!a || a.stopped) return;
      a.onLine(line);
    },
    /** Simulate the underlying child exiting (e.g. container was
     *  removed).  Calls onExit, which the broker uses to null its
     *  cached handle. */
    killCurrentTail: () => {
      const a = actives[actives.length - 1];
      if (!a) return;
      a.stopped = true;
      a.onExit?.(0);
    },
    /** Fire onExit for a specific (possibly stale) spawn index,
     *  simulating a late `close` event from an older child after a
     *  newer one has already started. */
    fireOnExitFor: (idx: number) => {
      const a = actives[idx];
      if (!a) return;
      a.stopped = true;
      a.onExit?.(0);
    },
    spawnCount: () => actives.length,
    stopCount: (idx?: number) =>
      idx === undefined
        ? stopCounts.reduce((a, b) => a + b, 0)
        : (stopCounts[idx] ?? 0),
  };
}

describe("LogStreamBroker — single subscriber", () => {
  it("first subscribe spawns the tail; emit delivers to onLine", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    assert.equal(fake.spawnCount(), 0);
    const lines: string[] = [];
    broker.subscribe({ onLine: (l) => lines.push(l) });
    assert.equal(fake.spawnCount(), 1);
    fake.emit("hello");
    assert.deepEqual(lines, ["hello"]);
  });

  it("unsubscribe of the last subscriber stops the tail", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    const unsub = broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 1);
    unsub();
    assert.equal(fake.stopCount(), 1);
    assert.equal(broker.subscriberCount(), 0);
  });

  it("subscribe after the tail stopped re-spawns it (self-healing)", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    const unsub = broker.subscribe({ onLine: () => {} });
    unsub();
    assert.equal(fake.spawnCount(), 1);
    broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 2);
  });
});

describe("LogStreamBroker — multiple subscribers (fan-out)", () => {
  it("second subscribe does NOT spawn a second tail", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    broker.subscribe({ onLine: () => {} });
    broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 1);
    assert.equal(broker.subscriberCount(), 2);
  });

  it("both subscribers receive each emitted line", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    const a: string[] = [];
    const b: string[] = [];
    broker.subscribe({ onLine: (l) => a.push(l) });
    broker.subscribe({ onLine: (l) => b.push(l) });
    fake.emit("x");
    fake.emit("y");
    assert.deepEqual(a, ["x", "y"]);
    assert.deepEqual(b, ["x", "y"]);
  });

  it("one subscriber's onLine throwing does not break the fan-out for others", () => {
    const errors: unknown[] = [];
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
      onSubscriberError: (err) => errors.push(err),
    });
    const good: string[] = [];
    broker.subscribe({
      onLine: () => {
        throw new Error("oops");
      },
    });
    broker.subscribe({ onLine: (l) => good.push(l) });
    fake.emit("x");
    assert.deepEqual(good, ["x"]);
    assert.equal(errors.length, 1);
  });

  it("unsubscribing one of two keeps the tail alive", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    const unsubA = broker.subscribe({ onLine: () => {} });
    broker.subscribe({ onLine: () => {} });
    unsubA();
    assert.equal(fake.stopCount(), 0);
    assert.equal(broker.subscriberCount(), 1);
  });
});

describe("LogStreamBroker — tail self-healing on exit", () => {
  it("if the tail's onExit fires, broker.tail is nulled and next subscribe respawns", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 1);
    // Simulate the child dying (container removed).
    fake.killCurrentTail();
    // New subscribe should respawn — the existing subscriber is
    // still there, but the broker's internal tail handle is null,
    // so the next subscribe goes through the spawnIfNeeded path.
    broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 2);
  });
});

describe("LogStreamBroker — close()", () => {
  it("notifies every subscriber via onClose with the reason", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    const closes: string[] = [];
    broker.subscribe({
      onLine: () => {},
      onClose: (reason) => closes.push(`a:${reason}`),
    });
    broker.subscribe({
      onLine: () => {},
      onClose: (reason) => closes.push(`b:${reason}`),
    });
    broker.close("container-removed");
    assert.deepEqual(closes, ["a:container-removed", "b:container-removed"]);
  });

  it("stops the tail when called", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    broker.subscribe({ onLine: () => {} });
    broker.close("plugin-stopped");
    assert.equal(fake.stopCount(), 1);
  });

  it("is idempotent", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    broker.subscribe({ onLine: () => {} });
    broker.close("plugin-stopped");
    broker.close("plugin-stopped");
    broker.close("container-removed");
    assert.equal(fake.stopCount(), 1);
  });

  it("refuses further subscriptions after close", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    broker.subscribe({ onLine: () => {} });
    broker.close("container-removed");
    // subscribe-after-close returns a no-op unsub; the new
    // subscription is silently dropped.
    const unsub = broker.subscribe({ onLine: () => {} });
    assert.equal(broker.subscriberCount(), 0);
    // Calling the no-op unsub is harmless.
    unsub();
    assert.equal(fake.spawnCount(), 1, "must not spawn a second tail");
  });

  it("isClosed() reflects state", () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
    });
    assert.equal(broker.isClosed(), false);
    broker.close("plugin-stopped");
    assert.equal(broker.isClosed(), true);
  });

  it("onClose handler errors are caught", () => {
    const errors: unknown[] = [];
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
      onSubscriberError: (err) => errors.push(err),
    });
    broker.subscribe({
      onLine: () => {},
      onClose: () => {
        throw new Error("close boom");
      },
    });
    broker.subscribe({
      onLine: () => {},
      onClose: () => {},
    });
    // Should not throw out of close().
    broker.close("container-removed");
    assert.equal(errors.length, 1);
  });
});

describe("LogStreamBroker — startTail propagation", () => {
  it("passes startTail through to tailContainerLogs on first subscribe", () => {
    let observedStartTail: number | undefined;
    const capturingSpawn: typeof import("../containers").tailContainerLogs = (
      _runtime,
      _name,
      _onLine,
      options,
    ) => {
      observedStartTail = options?.startTail;
      return { stop: () => {}, pid: 1 };
    };
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: capturingSpawn,
      startTail: 100,
    });
    broker.subscribe({ onLine: () => {} });
    assert.equal(observedStartTail, 100);
  });
});

/**
 * Poll `check` every `stepMs` until it returns true or the deadline
 * passes.  Throws a clear error if it times out — flaky CI builds
 * fail fast instead of giving cryptic "expected 2 got 1" assertions
 * far away from the cause.
 */
async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 1000,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out (${timeoutMs}ms): ${label}`);
}

/**
 * Assert that a condition stays false for `durationMs`.  Use for
 * negative claims (e.g. "no respawn should happen").  Shorter than
 * `waitFor` because we only need long enough to cover the would-be
 * trigger window plus a small margin.
 */
async function assertStays(
  check: () => boolean,
  label: string,
  durationMs: number,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (check())
      throw new Error(`assertStays violated (${durationMs}ms): ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("LogStreamBroker — auto-respawn after tail exit", () => {
  // Use a tiny respawn delay so the test suite stays fast.  The
  // production constant is 1000ms.
  const TEST_RESPAWN_DELAY_MS = 5;
  // Margin for the negative "no respawn happened" assertions.
  // Production base × ~6 keeps backoff bounded in tests without
  // exceeding the parent test timeout.
  const NEGATIVE_WAIT_MS = TEST_RESPAWN_DELAY_MS * 6;

  it("respawns the tail when onExit fires with subscribers still attached", async () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
      respawnDelayMs: TEST_RESPAWN_DELAY_MS,
    });
    broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 1);
    // Underlying child dies (auto-recreate, daemon glitch).  The
    // subscriber stays attached — no new subscribe() call fires.
    fake.killCurrentTail();
    await waitFor(() => fake.spawnCount() === 2, "respawn after onExit");
    broker.close("container-removed");
  });

  it("does not respawn if all subscribers unsubscribed during the delay", async () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
      respawnDelayMs: TEST_RESPAWN_DELAY_MS,
    });
    const unsub = broker.subscribe({ onLine: () => {} });
    fake.killCurrentTail();
    // Unsubscribe before the respawn timer fires.
    unsub();
    await assertStays(
      () => fake.spawnCount() > 1,
      "no respawn after last unsubscribe",
      NEGATIVE_WAIT_MS,
    );
  });

  it("does not respawn after close()", async () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
      respawnDelayMs: TEST_RESPAWN_DELAY_MS,
    });
    broker.subscribe({ onLine: () => {} });
    fake.killCurrentTail();
    broker.close("container-removed");
    await assertStays(
      () => fake.spawnCount() > 1,
      "no respawn after close()",
      NEGATIVE_WAIT_MS,
    );
  });

  it("applies exponential backoff on repeated exits; a delivered line resets it", async () => {
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
      respawnDelayMs: TEST_RESPAWN_DELAY_MS,
    });
    broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 1);
    // Three back-to-back exits without delivering a line — each
    // respawn doubles the delay.  Total finishes well under 1s so
    // a single waitFor would also work, but staggering keeps the
    // intent of "this is a backoff sequence" visible.
    fake.killCurrentTail();
    await waitFor(() => fake.spawnCount() === 2, "respawn #1");
    fake.killCurrentTail();
    await waitFor(() => fake.spawnCount() === 3, "respawn #2 (delayed)");
    fake.killCurrentTail();
    await waitFor(
      () => fake.spawnCount() === 4,
      "respawn #3 (further delayed)",
    );
    // A delivered line marks the tail healthy and resets the
    // counter — the next exit goes back to the fast base delay.
    // We don't assert timing here (Windows timer-scheduler jitter
    // makes "must be <Nms" flaky); the count proves the reset
    // worked (without it, four backoffs in a row would compound
    // past the default waitFor budget on slow runners anyway).
    fake.emit("hello");
    fake.killCurrentTail();
    await waitFor(
      () => fake.spawnCount() === 5,
      "respawn #4 after backoff reset",
    );
    broker.close("container-removed");
  });

  it("ignores a stale onExit from an older tail instance", async () => {
    // Regression for the "late-exit from a previous child clobbers
    // the live handle" race.  The scenario: unsub-to-0 stops the
    // tail and clears `tail`; a fresh subscribe spawns tail #2
    // before tail #1's `close` event fires; if onExit didn't check
    // its own identity, tail #1's late exit would null `tail` again
    // and trigger a spurious respawn into tail #3.
    const fake = makeFakeTail();
    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail: fake.spawnTail,
      respawnDelayMs: TEST_RESPAWN_DELAY_MS,
    });
    const unsub = broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 1);
    // Drop to zero → broker stops the tail (synchronously sets
    // `tail = null`); the underlying child hasn't actually emitted
    // its close event yet.
    unsub();
    // New subscriber arrives — broker spawns tail #2.
    broker.subscribe({ onLine: () => {} });
    assert.equal(fake.spawnCount(), 2);
    // Tail #1's `close` event finally arrives.  Without the
    // identity guard this would null the live handle and schedule
    // another respawn.
    fake.fireOnExitFor(0);
    await assertStays(
      () => fake.spawnCount() > 2,
      "stale onExit triggered a spurious respawn",
      NEGATIVE_WAIT_MS,
    );
    broker.close("container-removed");
  });

  it("treats pid:undefined as a failed spawn — schedules respawn instead of wedging", async () => {
    // Regression for: spawnRuntimeStreaming returns a no-op handle
    // with pid===undefined on synchronous spawn failures (bad
    // binary, ENOENT).  No child process exists so `onExit` never
    // fires.  Without the guard, the broker would cache that dead
    // handle, leaving subscribers attached but the broker silent
    // forever.  With the guard: treat as a failed spawn and let
    // the backoff retry — second attempt succeeds and lines flow.
    let attempt = 0;
    type Handle = {
      stop: () => void;
      pid: number | undefined;
      onExit?: () => void;
      onLine?: (l: string) => void;
    };
    const handles: Handle[] = [];
    const spawnTail: typeof import("../containers").tailContainerLogs = (
      _runtime,
      _name,
      onLine,
      options,
    ) => {
      attempt++;
      if (attempt === 1) {
        // Simulate synchronous spawn failure path.
        return { stop: () => {}, pid: undefined };
      }
      const handle: Handle = {
        stop: () => {},
        pid: 1234,
        onExit: options?.onExit ? () => options.onExit?.(0) : undefined,
        onLine,
      };
      handles.push(handle);
      return { stop: handle.stop, pid: handle.pid };
    };

    const broker = createLogStreamBroker(runtime, "foo", {
      spawnTail,
      respawnDelayMs: TEST_RESPAWN_DELAY_MS,
    });
    const lines: string[] = [];
    broker.subscribe({ onLine: (l) => lines.push(l) });
    // First spawn attempt failed (pid:undefined).  The broker
    // should have scheduled a backoff respawn rather than caching
    // the dead handle.
    assert.equal(attempt, 1);
    // After backoff, the second attempt succeeds.
    await waitFor(() => attempt === 2, "broker retries after pid:undefined");
    // Feed a line into the new tail and verify the subscriber gets it.
    handles[0].onLine?.("hello");
    assert.deepEqual(lines, ["hello"]);
    broker.close("container-removed");
  });
});
