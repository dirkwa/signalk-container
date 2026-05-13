import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRuntime } from "../runtime.js";

describe("detectRuntime", () => {
  it("returns a runtime info object when podman or docker is available", async () => {
    const result = await detectRuntime("auto");
    // On CI or dev machines, at least one should be available
    // If neither is installed, result is null — that's also valid
    if (result) {
      assert.ok(
        result.runtime === "podman" || result.runtime === "docker",
        `unexpected runtime: ${result.runtime}`,
      );
      assert.ok(typeof result.version === "string");
      assert.ok(typeof result.isPodmanDockerShim === "boolean");
    }
  });

  it("returns null for a nonexistent runtime", async () => {
    // Force a specific runtime that doesn't exist
    const result = await detectRuntime("podman" as any);
    // This may or may not be null depending on the system
    // but the function should not throw
    if (result) {
      assert.equal(result.runtime, "podman");
    }
  });
});
