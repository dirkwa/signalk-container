import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeKeepImageVersions } from "../index.js";

describe("normalizeKeepImageVersions", () => {
  it("defaults to 1 when the value is undefined (legacy/API config)", () => {
    assert.equal(normalizeKeepImageVersions(undefined), 1);
  });

  it("preserves an explicit 0 (keep only the running image)", () => {
    assert.equal(normalizeKeepImageVersions(0), 0);
  });

  it("passes through a positive integer", () => {
    assert.equal(normalizeKeepImageVersions(3), 3);
  });

  it("floors a decimal to an integer", () => {
    assert.equal(normalizeKeepImageVersions(2.9), 2);
  });

  it("clamps a negative to 0", () => {
    assert.equal(normalizeKeepImageVersions(-5), 0);
  });

  it("falls back to the default for NaN", () => {
    assert.equal(normalizeKeepImageVersions(NaN), 1);
  });

  it("falls back to the default for Infinity", () => {
    assert.equal(normalizeKeepImageVersions(Infinity), 1);
  });

  it("falls back to the default for a non-number", () => {
    assert.equal(normalizeKeepImageVersions("2"), 1);
    assert.equal(normalizeKeepImageVersions(null), 1);
  });
});
