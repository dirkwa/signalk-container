import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../updates/semver.js";

describe("compareVersions", () => {
  const cases: Array<[string, string, -1 | 0 | 1, string]> = [
    ["1.2.3", "1.2.3", 0, "exact equal"],
    ["v1.2.3", "1.2.3", 0, "v prefix is stripped"],
    ["1.2.3", "v1.2.3", 0, "v prefix on b"],
    ["1.2.3", "1.2.4", -1, "patch lower"],
    ["1.2.4", "1.2.3", 1, "patch higher"],
    ["1.5", "1.5.0", 0, "missing patch equals .0"],
    ["1.2", "1.2.1", -1, "missing patch < explicit"],
    ["2.0.0-beta1", "2.0.0", -1, "prerelease < release"],
    ["2.0.0", "2.0.0-beta1", 1, "release > prerelease"],
    ["2.0.0-beta1", "2.0.0-beta2", -1, "prerelease lex compare"],
    ["9.2.0", "10.0.0", -1, "double-digit major"],
    ["10.0.0", "9.2.0", 1, "double-digit major reversed"],
    // questdb/grafana cases that previously diverged
    ["8.1.0", "9.2.0", -1, "questdb older < latest"],
    ["12.0.0", "11.5.0", 1, "grafana newer > latest"],
    // unparseable falls back to lex
    ["foo", "foo", 0, "garbage equal"],
    ["foo", "bar", 1, "garbage lex"],
  ];

  for (const [a, b, expected, label] of cases) {
    it(`${label}: ${a} vs ${b} → ${expected}`, () => {
      assert.equal(compareVersions(a, b), expected);
    });
  }
});
