import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePositiveIntQuery } from "../containers";

/**
 * Validator used by the `/api/containers/:name/logs` route for the
 * `tail` and `since` query params.  Boundary-tested here so the
 * route handler can stay thin.
 */
describe("parsePositiveIntQuery", () => {
  it("returns undefined for missing input", () => {
    const r = parsePositiveIntQuery(undefined, "tail");
    assert.equal(r.value, undefined);
    assert.equal(r.error, undefined);
  });

  it("returns undefined for empty string", () => {
    const r = parsePositiveIntQuery("", "tail");
    assert.equal(r.value, undefined);
    assert.equal(r.error, undefined);
  });

  it("accepts a positive integer", () => {
    const r = parsePositiveIntQuery("200", "tail");
    assert.equal(r.value, 200);
    assert.equal(r.error, undefined);
  });

  it("accepts zero", () => {
    const r = parsePositiveIntQuery("0", "tail");
    assert.equal(r.value, 0);
    assert.equal(r.error, undefined);
  });

  it("rejects a negative integer", () => {
    const r = parsePositiveIntQuery("-50", "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /non-negative integer/);
    assert.match(r.error ?? "", /tail/);
  });

  it("rejects a float", () => {
    const r = parsePositiveIntQuery("3.5", "since");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /since/);
  });

  it("rejects NaN", () => {
    const r = parsePositiveIntQuery("not-a-number", "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /tail/);
  });

  it("rejects Infinity", () => {
    const r = parsePositiveIntQuery("Infinity", "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /tail/);
  });

  it("rejects an array (express might pass repeated params as array)", () => {
    const r = parsePositiveIntQuery(["200", "300"], "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /tail must be a string/);
  });

  it("rejects an object", () => {
    const r = parsePositiveIntQuery({ x: 1 }, "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /tail must be a string/);
  });

  it("error message includes the offending raw value", () => {
    const r = parsePositiveIntQuery("-1", "tail");
    assert.match(r.error ?? "", /"-1"/);
  });

  it("rejects hex notation (0x10)", () => {
    const r = parsePositiveIntQuery("0x10", "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /tail/);
  });

  it("rejects scientific notation (1e3)", () => {
    const r = parsePositiveIntQuery("1e3", "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /tail/);
  });

  it("rejects leading plus sign (+5)", () => {
    const r = parsePositiveIntQuery("+5", "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /tail/);
  });

  it("rejects whitespace (' 5 ')", () => {
    const r = parsePositiveIntQuery(" 5 ", "tail");
    assert.equal(r.value, undefined);
    assert.match(r.error ?? "", /tail/);
  });
});
