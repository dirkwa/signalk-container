import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTag } from "../updates/tagClassifier.js";
import type { TagKind } from "../updates/types.js";

describe("classifyTag", () => {
  const cases: Array<[string, TagKind, string]> = [
    // semver
    ["9.2.0", "semver", "patch semver"],
    ["v1.5", "semver", "v-prefixed major.minor"],
    ["1.5", "semver", "bare major.minor"],
    ["2.0.0-beta1", "semver", "prerelease"],
    ["10.4.7", "semver", "double-digit"],
    ["v0.0.1", "semver", "zero-zero-one"],
    // floating
    ["latest", "floating", "latest"],
    ["LATEST", "floating", "uppercase latest"],
    ["main", "floating", "main"],
    ["master", "floating", "master"],
    ["edge", "floating", "edge"],
    ["nightly", "floating", "nightly"],
    ["stable", "floating", "stable"],
    ["dev", "floating", "dev"],
    ["rolling", "floating", "rolling"],
    ["v3", "floating", "bare major v"],
    ["3", "floating", "bare major number"],
    // unknown
    ["my-fork", "unknown", "custom"],
    ["sha256:abc", "unknown", "digest-shaped"],
    ["", "unknown", "empty"],
    ["custom-build-2024", "unknown", "custom dated"],
  ];

  for (const [tag, expected, label] of cases) {
    it(`${label}: '${tag}' → ${expected}`, () => {
      assert.equal(classifyTag(tag), expected);
    });
  }
});
