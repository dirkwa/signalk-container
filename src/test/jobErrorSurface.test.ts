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

  it("carries the raw registry text when the image pull fails", async () => {
    // Image absent locally, pull rejects with a kind-unknown daemon text:
    // the consumer-facing JobResult.error must carry the categorized
    // message AND the raw snippet — "Pull failed: Unexpected error." alone
    // is undiagnosable in a consumer plugin's UI.
    const client = makeMockClient({
      pull: new Error(
        "(HTTP code 500) server error - blob unknown to registry",
      ),
    });

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["true"] },
      client,
    );

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /^Pull failed: /);
    assert.match(
      result.error ?? "",
      /Unexpected error\. See logs for details\./,
    );
    assert.match(result.error ?? "", /blob unknown to registry/);
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

describe("categorizeError — EACCES on the socket is permission, not unreachable", () => {
  it("classifies a connect EACCES on the runtime socket as permission", () => {
    // dockerode surfaces a refused socket ACL as
    // `connect EACCES /var/run/docker.sock` (verified live). The socket
    // exists and is bind-mounted; the container user just isn't in the host
    // `docker` group. That's a permission problem the operator fixes with
    // group_add — not an unreachable/absent socket — so the doctor must reach
    // its `permission-denied` remediation.
    const c = categorizeError(new Error("connect EACCES /var/run/docker.sock"));
    assert.equal(c.kind, "permission");
    assert.match(c.userMessage, /permission/i);
  });

  it("classifies a bare EACCES as permission", () => {
    assert.equal(categorizeError(new Error("EACCES")).kind, "permission");
  });

  it("still classifies an absent socket (ENOENT) as socket-unreachable", () => {
    // The not-bind-mounted case must stay unreachable → no-runtime, distinct
    // from the permission case.
    assert.equal(
      categorizeError(new Error("connect ENOENT /var/run/docker.sock")).kind,
      "socket-unreachable",
    );
  });
});

describe("categorizeError — invalid container config (issue #183)", () => {
  // Verbatim from Docker 29.6.1 over the socket: creating a container that
  // shares another container's netns while also publishing a port. Docker
  // returns HTTP 400 with this exact daemon message.
  const CONFLICTING_OPTIONS =
    "conflicting options: port publishing and the container type network mode";

  it("classifies a 'conflicting options' create rejection as invalid-config, not unknown", () => {
    const c = categorizeError(new Error(CONFLICTING_OPTIONS));
    assert.equal(c.kind, "invalid-config");
  });

  it("preserves the raw daemon text and surfaces it in userMessage", () => {
    const c = categorizeError(new Error(CONFLICTING_OPTIONS));
    assert.equal(c.raw, CONFLICTING_OPTIONS);
    // The raw string is the actionable part — it must reach the consumer, not
    // be swallowed behind a generic "Unexpected error" message.
    assert.ok(
      c.userMessage.includes(CONFLICTING_OPTIONS),
      `userMessage should carry the daemon text, got: ${c.userMessage}`,
    );
    assert.notEqual(c.userMessage, "Unexpected error. See logs for details.");
  });

  it("also classifies an 'invalid HostConfig' rejection as invalid-config", () => {
    assert.equal(
      categorizeError(new Error("invalid HostConfig: bad ulimit")).kind,
      "invalid-config",
    );
  });
});
