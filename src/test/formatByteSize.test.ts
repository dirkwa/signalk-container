import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatByteSize } from "../containers.js";

describe("formatByteSize", () => {
  it("shows a prune's reclaimed bytes in MB", () => {
    // The panel showed this one as "reclaimed 64816171b".
    assert.equal(formatByteSize(64_816_171), "64.8 MB");
  });

  it("uses decimal units with at most one decimal", () => {
    assert.equal(formatByteSize(0), "0 B");
    assert.equal(formatByteSize(999), "999 B");
    assert.equal(formatByteSize(1000), "1 kB");
    assert.equal(formatByteSize(2048), "2 kB");
    assert.equal(formatByteSize(1_250_000_000), "1.3 GB");
    assert.equal(formatByteSize(3_000_000_000_000), "3 TB");
  });

  it("moves up a unit instead of showing 1000 of the one below", () => {
    assert.equal(formatByteSize(999_960), "1 MB");
    assert.equal(formatByteSize(999_940), "999.9 kB");
  });

  it("stays in TB above it", () => {
    assert.equal(formatByteSize(4_500_000_000_000_000), "4500 TB");
  });
});
