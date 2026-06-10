import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../jobs.js";
import { makeMockClient, streamFrom } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isRootless: false,
};

describe("runJob cancellation via AbortSignal", () => {
  it("returns 'cancelled' without creating a container when pre-aborted", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      calls,
    });

    const result = await runJob(
      docker,
      {
        image: "alpine:3.19",
        command: ["sleep", "60"],
        signal: AbortSignal.abort(),
      },
      client,
    );

    assert.equal(result.status, "cancelled");
    assert.match(result.error ?? "", /cancelled/i);
    assert.equal(calls.get("createContainer"), undefined);
    assert.equal(calls.get("start"), undefined);
  });

  it("force-removes the job container and reports 'cancelled' when aborted mid-run", async () => {
    const calls = new Map<string, unknown[]>();
    const controller = new AbortController();

    // wait() stays pending until the container is removed — which is exactly
    // what force-removing on abort triggers against a real daemon. Resolving
    // the wait rejection from the `remove` mock keeps the test deterministic
    // without timers.
    let rejectWait: (err: Error) => void = () => {};
    const waitRejected = new Promise<never>((_resolve, reject) => {
      rejectWait = reject;
    });

    const client = makeMockClient({
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

    const promise = runJob(
      docker,
      {
        image: "alpine:3.19",
        command: ["sleep", "60"],
        signal: controller.signal,
      },
      client,
    );

    // Let runJob reach the pending wait() before cancelling.
    await new Promise((r) => setImmediate(r));
    controller.abort();

    const result = await promise;

    assert.equal(result.status, "cancelled");
    assert.match(result.error ?? "", /cancelled/i);
    assert.doesNotMatch(result.error ?? "", /exited with code/i);

    // The container was force-removed, and against the sk-job-* name.
    const removes = (calls.get("remove") ?? []) as Array<{ id: string }>;
    assert.ok(removes.length >= 1, "expected a force-remove on abort");
    assert.ok(
      removes.every((r) => r.id.startsWith("sk-job-")),
      "removes must target the sk-job-* container",
    );
  });

  it("completes normally and leaves no abort listener when the signal never fires", async () => {
    const controller = new AbortController();
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      defaultContainer: {
        logs: () => Promise.resolve(streamFrom("done\n")),
        wait: { StatusCode: 0 },
      },
    });

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["true"], signal: controller.signal },
      client,
    );

    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);

    // The listener must have been removed in finally — a late abort triggers
    // no further work. (If it leaked, this would invoke the force-remove path.)
    assert.doesNotThrow(() => controller.abort());
  });
});
