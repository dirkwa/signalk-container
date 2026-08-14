import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categorizeError,
  isStorageCorruptError,
  isUlimitRejectionText,
  messageWithRaw,
  RAW_SNIPPET_MAX_LENGTH,
} from "../errors.js";
import {
  httpError,
  HTTP_NOT_FOUND,
  HTTP_INTERNAL_SERVER_ERROR,
} from "./helpers/mockClient.js";

// The exact daemon text from issue #219, as docker-modem delivers it —
// including the trailing space.
const GRAPH_DRIVER_BODY =
  '(HTTP code 500) server error - getting graph driver info "abc123": ' +
  "readlink /home/u/.local/share/containers/storage/overlay: invalid argument ";

describe("categorizeError — storage corruption (issue #219)", () => {
  it("classifies the graph-driver readlink 500 as storage-corrupt", () => {
    const result = categorizeError(
      httpError(GRAPH_DRIVER_BODY, HTTP_INTERNAL_SERVER_ERROR),
    );
    assert.equal(result.kind, "storage-corrupt");
    assert.match(result.userMessage, /podman system check --repair --force/);
    assert.equal(result.raw, GRAPH_DRIVER_BODY);
  });

  it("classifies 'layer not known' 500 as storage-corrupt, not not-found", () => {
    const result = categorizeError(
      httpError(
        "(HTTP code 500) server error - layer not known ",
        HTTP_INTERNAL_SERVER_ERROR,
      ),
    );
    assert.equal(result.kind, "storage-corrupt");
  });

  it("a 404 wins over the body patterns (absent, not corrupt)", () => {
    const result = categorizeError(
      httpError(GRAPH_DRIVER_BODY, HTTP_NOT_FOUND),
    );
    assert.equal(result.kind, "not-found");
  });

  it("a generic 500 stays unknown", () => {
    const result = categorizeError(
      httpError(
        "(HTTP code 500) server error - something else ",
        HTTP_INTERNAL_SERVER_ERROR,
      ),
    );
    assert.equal(result.kind, "unknown");
  });

  it("a graph-driver 500 without the readlink evidence stays unknown", () => {
    // The graph-driver wrapper can carry unrelated storage errors; on its
    // own it is not enough evidence for the destructive remove + recreate.
    const result = categorizeError(
      httpError(
        '(HTTP code 500) server error - getting graph driver info "abc": something else ',
        500,
      ),
    );
    assert.equal(result.kind, "unknown");
  });

  it("the corruption body without a statusCode stays unknown (strict gate)", () => {
    const result = categorizeError(new Error(GRAPH_DRIVER_BODY));
    assert.equal(result.kind, "unknown");
  });
});

describe("messageWithRaw", () => {
  it("appends the raw runtime text to the user message", () => {
    assert.equal(
      messageWithRaw(
        "Unexpected error. See logs for details.",
        "crun: setrlimit `RLIMIT_NOFILE`: Invalid argument",
      ),
      "Unexpected error. See logs for details. (crun: setrlimit `RLIMIT_NOFILE`: Invalid argument)",
    );
  });

  it("returns the user message alone when raw is empty or whitespace", () => {
    assert.equal(messageWithRaw("Disk full.", ""), "Disk full.");
    assert.equal(messageWithRaw("Disk full.", "  \n\t "), "Disk full.");
  });

  it("skips the suffix when the user message already embeds raw (invalid-config)", () => {
    const raw = "conflicting options: port publishing and the container type";
    const c = categorizeError(new Error(raw));
    assert.equal(c.kind, "invalid-config");
    assert.equal(messageWithRaw(c.userMessage, c.raw), c.userMessage);
  });

  it("skips the suffix when raw contains the user message", () => {
    assert.equal(
      messageWithRaw("no space left", "server error - no space left on device"),
      "no space left",
    );
  });

  it("collapses newlines and whitespace runs in the appended snippet", () => {
    assert.equal(
      messageWithRaw("Unexpected error.", "line one\n  line two\t\tline three"),
      "Unexpected error. (line one line two line three)",
    );
  });

  it("truncates the snippet at the boundary, not below it", () => {
    const atLimit = "x".repeat(RAW_SNIPPET_MAX_LENGTH);
    assert.equal(messageWithRaw("Oops.", atLimit), `Oops. (${atLimit})`);

    const overLimit = "x".repeat(RAW_SNIPPET_MAX_LENGTH + 1);
    assert.equal(messageWithRaw("Oops.", overLimit), `Oops. (${atLimit}…)`);
  });
});

// The two OCI-runtime phrasings for a rejected rlimit request. Both carry
// "operation not permitted", so without the dedicated kind they land in the
// `permission` bucket, whose socket/mount remediation is a red herring for
// a limits problem.
const CRUN_RLIMIT_TEXT =
  "crun: setrlimit `RLIMIT_NOFILE`: Operation not permitted: OCI permission denied";
const RUNC_RLIMIT_TEXT =
  "error setting rlimits for ready process: setting rlimit type 7: operation not permitted";

describe("categorizeError — ulimit rejection", () => {
  it("classifies the crun setrlimit rejection as ulimit-rejected", () => {
    const result = categorizeError(new Error(CRUN_RLIMIT_TEXT));
    assert.equal(result.kind, "ulimit-rejected");
    assert.match(result.userMessage, /per-process limit \(ulimit/);
    assert.match(result.userMessage, /podman machine on macOS/);
    assert.equal(result.raw, CRUN_RLIMIT_TEXT);
  });

  it("classifies the runc rlimit rejection as ulimit-rejected", () => {
    assert.equal(
      categorizeError(new Error(RUNC_RLIMIT_TEXT)).kind,
      "ulimit-rejected",
    );
  });

  it("takes precedence over the permission bucket", () => {
    for (const text of [CRUN_RLIMIT_TEXT, RUNC_RLIMIT_TEXT]) {
      assert.equal(categorizeError(new Error(text)).kind, "ulimit-rejected");
    }
  });

  it("leaves a plain 'operation not permitted' in the permission bucket", () => {
    assert.equal(
      categorizeError(new Error("mount /x: operation not permitted")).kind,
      "permission",
    );
  });
});

describe("isUlimitRejectionText", () => {
  it("matches each pattern independently (any-match)", () => {
    assert.ok(isUlimitRejectionText("setrlimit failed"));
    assert.ok(isUlimitRejectionText("RLIMIT_NPROC: cannot apply"));
    assert.ok(isUlimitRejectionText("error setting rlimits for ready process"));
    assert.ok(isUlimitRejectionText("setting rlimit type 7: denied"));
  });

  it("rejects unrelated permission texts", () => {
    assert.equal(
      isUlimitRejectionText(
        "cannot stop container: sending SIGKILL: operation not permitted",
      ),
      false,
    );
    assert.equal(isUlimitRejectionText("permission denied"), false);
  });
});

describe("isStorageCorruptError", () => {
  it("matches the safe()/safeInspect() rethrow shape", () => {
    const err = new Error("Container storage is corrupt", {
      cause: { kind: "storage-corrupt", userMessage: "x", raw: "y" },
    });
    assert.equal(isStorageCorruptError(err), true);
  });

  it("rejects plain errors and other kinds", () => {
    assert.equal(isStorageCorruptError(new Error("boom")), false);
    assert.equal(
      isStorageCorruptError(
        new Error("x", {
          cause: { kind: "permission", userMessage: "x", raw: "y" },
        }),
      ),
      false,
    );
    assert.equal(isStorageCorruptError("not an error"), false);
  });
});
