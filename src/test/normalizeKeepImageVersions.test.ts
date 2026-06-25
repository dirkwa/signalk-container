import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeKeepImageVersions,
  keepImageVersionsSelectValue,
  keepImageVersionsFromSelectValue,
} from "../configNormalize.js";

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

describe("keepImageVersionsSelectValue (config panel load)", () => {
  it("renders the default as a string when config is absent", () => {
    assert.equal(keepImageVersionsSelectValue(undefined), "1");
  });

  it("renders an explicit 0 as '0'", () => {
    assert.equal(keepImageVersionsSelectValue(0), "0");
  });

  it("renders a valid number as its string form", () => {
    assert.equal(keepImageVersionsSelectValue(3), "3");
  });

  it("seeds a malformed saved value to the default '1', not '0'", () => {
    // The contract finding: a hand-edited bad value must not load as a
    // more-aggressive policy.
    assert.equal(keepImageVersionsSelectValue(-2), "0"); // negative clamps to 0 (valid number)
    assert.equal(keepImageVersionsSelectValue(NaN), "1");
    assert.equal(keepImageVersionsSelectValue("garbage"), "1");
  });
});

describe("keepImageVersionsFromSelectValue (config panel save)", () => {
  it("coerces a dropdown string to its integer", () => {
    assert.equal(keepImageVersionsFromSelectValue("0"), 0);
    assert.equal(keepImageVersionsFromSelectValue("1"), 1);
    assert.equal(keepImageVersionsFromSelectValue("5"), 5);
  });

  it("never saves a worse policy than the contract: a malformed string saves 1, not 0", () => {
    assert.equal(keepImageVersionsFromSelectValue(""), 1);
    assert.equal(keepImageVersionsFromSelectValue("not-a-number"), 1);
  });
});
