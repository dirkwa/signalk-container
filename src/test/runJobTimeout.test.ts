import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { runJob, startDeadline } from "../jobs.js";
import { makeMockClient, streamFrom } from "./helpers/mockClient.js";
import { PassThrough } from "node:stream";
import type { ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isRootless: false,
};

/**
 * A container whose wait() stays pending until it is removed, as against a
 * real daemon when the job is force-removed mid-run.
 */
function longRunningContainer(calls: Map<string, unknown[]>) {
  let rejectWait: (err: Error) => void = () => {};
  const waitRejected = new Promise<never>((_resolve, reject) => {
    rejectWait = reject;
  });
  return makeMockClient({
    images: { "alpine:3.19": {} },
    calls,
    defaultContainer: {
      logs: () => Promise.resolve(streamFrom("")),
      wait: () => waitRejected,
      remove: () => {
        rejectWait(new Error("container removed"));
        return Promise.resolve();
      },
    },
  });
}

describe("runJob timeout", () => {
  it("force-removes the job container and reports a timeout when the run phase overruns", async () => {
    const calls = new Map<string, unknown[]>();
    const client = longRunningContainer(calls);

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["sleep", "60"], timeout: 0.01 },
      client,
    );

    assert.equal(result.status, "failed");
    assert.equal(result.error, "Job timed out after 0.01s");
    assert.equal(result.exitCode, undefined);
    assert.ok(result.completedAt, "timed-out job should set completedAt");
    const removes = (calls.get("remove") ?? []) as Array<{ id: string }>;
    assert.ok(removes.length >= 1, "expected a force-remove on timeout");
    assert.ok(removes.every((r) => r.id.startsWith("sk-job-")));
  });

  it("still resolves as timed out when the force-remove fails", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      calls,
      defaultContainer: {
        logs: () => Promise.resolve(streamFrom("early line\n")),
        wait: () => new Promise<never>(() => {}),
        remove: () => Promise.reject(new Error("daemon unreachable")),
      },
    });

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["sleep", "60"], timeout: 0.01 },
      client,
    );

    assert.equal(result.status, "failed");
    assert.match(
      result.error ?? "",
      /^Job timed out after 0\.01s, and its container could not be removed: .*daemon unreachable/,
    );
    assert.deepEqual(result.log, ["early line"]);
  });

  it("resolves as timed out when the log request never answers", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      calls,
      defaultContainer: {
        logs: () => new Promise<never>(() => {}),
        wait: () => new Promise<never>(() => {}),
      },
    });

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["sleep", "60"], timeout: 0.01 },
      client,
    );

    assert.equal(result.status, "failed");
    assert.equal(result.error, "Job timed out after 0.01s");
  });

  it("does not mark a job that exited in time as timed out while its logs drain", async () => {
    const logs = new PassThrough();
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      defaultContainer: {
        logs: () => Promise.resolve(logs),
        wait: { StatusCode: 0 },
      },
    });

    const promise = runJob(
      docker,
      { image: "alpine:3.19", command: ["true"], timeout: 0.02 },
      client,
    );
    await new Promise((r) => setTimeout(r, 60));
    logs.end(Buffer.from("late line\n"));

    const result = await promise;
    assert.equal(result.status, "completed");
    assert.deepEqual(result.log, ["late line"]);
  });

  it("does not mark a job that exited while its logs attached as timed out", async () => {
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      defaultContainer: {
        logs: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(streamFrom("done\n")), 60),
          ),
        wait: { StatusCode: 0 },
      },
    });

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["true"], timeout: 0.02 },
      client,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
  });

  it("leaves a job that finishes in time alone", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      calls,
      defaultContainer: {
        logs: () => Promise.resolve(streamFrom("done\n")),
        wait: { StatusCode: 0 },
      },
    });

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["true"], timeout: 0.05 },
      client,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);

    // The deadline was cleared: no second force-remove after it would have
    // fired.
    const removesBefore = calls.get("remove")?.length ?? 0;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.get("remove")?.length ?? 0, removesBefore);
  });

  it("reports cancellation, not a timeout, when aborted first", async () => {
    const calls = new Map<string, unknown[]>();
    const client = longRunningContainer(calls);
    const controller = new AbortController();

    const promise = runJob(
      docker,
      {
        image: "alpine:3.19",
        command: ["sleep", "60"],
        timeout: 60,
        signal: controller.signal,
      },
      client,
    );
    await new Promise((r) => setImmediate(r));
    controller.abort();

    const result = await promise;
    assert.equal(result.status, "cancelled");
  });

  for (const timeout of [0, -5, Number.NaN]) {
    it(`sets no deadline for timeout ${timeout}`, async () => {
      const calls = new Map<string, unknown[]>();
      const client = makeMockClient({
        images: { "alpine:3.19": {} },
        calls,
        defaultContainer: {
          logs: () => Promise.resolve(streamFrom("")),
          wait: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ StatusCode: 0 }), 20),
            ),
        },
      });

      const result = await runJob(
        docker,
        { image: "alpine:3.19", command: ["true"], timeout },
        client,
      );
      assert.equal(result.status, "completed");
    });
  }
});

describe("startDeadline", () => {
  it("fires only once a deadline beyond setTimeout's maximum delay has passed", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      const day = 24 * 60 * 60 * 1000;
      let fired = false;
      startDeadline((30 * day) / 1000, () => {
        fired = true;
      });

      mock.timers.tick(25 * day);
      assert.equal(fired, false, "must not fire at the 24.8-day timer cap");
      mock.timers.tick(5 * day);
      assert.equal(fired, true);
    } finally {
      mock.timers.reset();
    }
  });

  it("does not fire once cancelled", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    try {
      let fired = false;
      const cancel = startDeadline(1, () => {
        fired = true;
      });
      cancel();
      mock.timers.tick(2000);
      assert.equal(fired, false);
    } finally {
      mock.timers.reset();
    }
  });
});
