import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeError, describeError } from "../errors.js";
import { runJob } from "../jobs.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isRootless: false,
};

describe("describeError", () => {
  it("recovers the raw text from a CategorizedError cause", () => {
    // The shape safe()/safeInspect() rethrow: a generic message with the real
    // runtime text tucked into cause.raw.
    const err = new Error("Unexpected error. See logs for details.", {
      cause: {
        kind: "unknown",
        userMessage: "Unexpected error.",
        raw: "(HTTP code 500) server error - inspect failed",
      },
    });
    assert.equal(
      describeError(err),
      "(HTTP code 500) server error - inspect failed",
    );
  });

  it("falls back to the message for a directly-thrown error", () => {
    assert.equal(describeError(new Error("boom")), "boom");
  });

  it("handles a non-Error throw", () => {
    assert.equal(describeError("plain string"), "plain string");
  });

  it("ignores a cause that is not a CategorizedError", () => {
    assert.equal(
      describeError(new Error("outer", { cause: new Error("inner") })),
      "outer",
    );
  });
});

describe("runJob error surfacing", () => {
  it("surfaces the real runtime error when the image inspect fails (not the generic message)", async () => {
    // A non-404 inspect failure that matches none of the known categorize
    // patterns → kind 'unknown' → safeInspect rethrows the generic userMessage
    // with the real error in cause.raw. The job result must carry the real text.
    const realError = new Error(
      "(HTTP code 500) server error - readlink /var/lib/containers: no such file",
    );
    const client = makeMockClient({
      images: { "alpine:3.19": realError },
    });

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["true"] },
      client,
    );

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /HTTP code 500.*no such file/);
    assert.doesNotMatch(result.error ?? "", /See logs for details/);
  });
});

describe("categorizeError — socket reset (EPIPE/ECONNRESET)", () => {
  it("classifies a write EPIPE as socket-unreachable, not unknown", () => {
    const c = categorizeError(new Error("write EPIPE"));
    assert.equal(c.kind, "socket-unreachable");
    assert.match(c.userMessage, /reset/i);
    assert.equal(c.raw, "write EPIPE");
  });

  it("classifies an ECONNRESET as socket-unreachable", () => {
    const c = categorizeError(new Error("read ECONNRESET"));
    assert.equal(c.kind, "socket-unreachable");
    assert.match(c.userMessage, /reset/i);
    assert.equal(c.raw, "read ECONNRESET");
  });

  it("matches the bare token, not just the read/write-prefixed form", () => {
    // The patterns are anchorless substrings, so "EPIPE" with no operation
    // prefix classifies the same as "write EPIPE".
    assert.equal(
      categorizeError(new Error("EPIPE")).kind,
      "socket-unreachable",
    );
  });
});
