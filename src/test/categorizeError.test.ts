import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeError, isStorageCorruptError } from "../errors.js";
import { httpError } from "./helpers/mockClient.js";

// The exact daemon text from issue #219, as docker-modem delivers it —
// including the trailing space.
const GRAPH_DRIVER_BODY =
  '(HTTP code 500) server error - getting graph driver info "abc123": ' +
  "readlink /home/u/.local/share/containers/storage/overlay: invalid argument ";

describe("categorizeError — storage corruption (issue #219)", () => {
  it("classifies the graph-driver readlink 500 as storage-corrupt", () => {
    const result = categorizeError(httpError(GRAPH_DRIVER_BODY, 500));
    assert.equal(result.kind, "storage-corrupt");
    assert.match(result.userMessage, /podman system check --repair --force/);
    assert.equal(result.raw, GRAPH_DRIVER_BODY);
  });

  it("classifies 'layer not known' 500 as storage-corrupt, not not-found", () => {
    const result = categorizeError(
      httpError("(HTTP code 500) server error - layer not known ", 500),
    );
    assert.equal(result.kind, "storage-corrupt");
  });

  it("a 404 wins over the body patterns (absent, not corrupt)", () => {
    const result = categorizeError(httpError(GRAPH_DRIVER_BODY, 404));
    assert.equal(result.kind, "not-found");
  });

  it("a generic 500 stays unknown", () => {
    const result = categorizeError(
      httpError("(HTTP code 500) server error - something else ", 500),
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
