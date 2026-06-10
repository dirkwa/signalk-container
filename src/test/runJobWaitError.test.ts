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

describe("runJob exit-status reporting", () => {
  it("carries the real reason when container.wait() rejects", async () => {
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      defaultContainer: {
        logs: () => Promise.resolve(streamFrom("")),
        wait: () => Promise.reject(new Error("socket hung up")),
      },
    });

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["true"] },
      client,
    );

    // wait() failing leaves the exit code a synthetic 1, so the status must
    // still be "failed" — but the error must name the actual cause rather
    // than the invented "exited with code 1".
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.match(result.error ?? "", /socket hung up/);
    assert.doesNotMatch(result.error ?? "", /exited with code 1/);
  });
});
