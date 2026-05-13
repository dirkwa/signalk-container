import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOfflineError } from "../updates/offline.js";

function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`mock ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("isOfflineError", () => {
  it("returns true for ENOTFOUND", () => {
    assert.equal(isOfflineError(errnoError("ENOTFOUND")), true);
  });

  it("returns true for ECONNREFUSED", () => {
    assert.equal(isOfflineError(errnoError("ECONNREFUSED")), true);
  });

  it("returns true for ENETUNREACH (typical sat-down case)", () => {
    assert.equal(isOfflineError(errnoError("ENETUNREACH")), true);
  });

  it("returns true for EHOSTUNREACH", () => {
    assert.equal(isOfflineError(errnoError("EHOSTUNREACH")), true);
  });

  it("returns true for ETIMEDOUT", () => {
    assert.equal(isOfflineError(errnoError("ETIMEDOUT")), true);
  });

  it("returns true for ECONNRESET", () => {
    assert.equal(isOfflineError(errnoError("ECONNRESET")), true);
  });

  it("returns true for EAI_AGAIN (DNS retry)", () => {
    assert.equal(isOfflineError(errnoError("EAI_AGAIN")), true);
  });

  it("returns true for AbortError (fetch timeout)", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    assert.equal(isOfflineError(err), true);
  });

  it("returns true for 'fetch failed' message", () => {
    assert.equal(isOfflineError(new Error("fetch failed")), true);
  });

  it("returns true for 'getaddrinfo' message", () => {
    assert.equal(
      isOfflineError(new Error("getaddrinfo ENOTFOUND api.github.com")),
      true,
    );
  });

  it("unwraps cause chain (Node fetch wrapping)", () => {
    const inner = errnoError("ENETUNREACH");
    const outer = new Error("fetch failed") as Error & { cause?: unknown };
    outer.cause = inner;
    assert.equal(isOfflineError(outer), true);
  });

  it("returns false for HTTP 404 (real error)", () => {
    assert.equal(isOfflineError(new Error("HTTP 404 Not Found")), false);
  });

  it("returns false for JSON parse error", () => {
    assert.equal(
      isOfflineError(new SyntaxError("Unexpected token in JSON")),
      false,
    );
  });

  it("returns false for generic Error('boom')", () => {
    assert.equal(isOfflineError(new Error("boom")), false);
  });

  it("returns false for non-Error values", () => {
    assert.equal(isOfflineError("string"), false);
    assert.equal(isOfflineError(null), false);
    assert.equal(isOfflineError(undefined), false);
    assert.equal(isOfflineError(42), false);
  });
});
