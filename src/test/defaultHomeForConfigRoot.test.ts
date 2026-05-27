import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultHomeForConfigRoot } from "../containers.js";

describe("defaultHomeForConfigRoot", () => {
  it("returns env unchanged when no configRootMount", () => {
    const env = { PORT: "3010" };
    assert.equal(defaultHomeForConfigRoot(env, undefined), env);
  });

  it("returns undefined unchanged when no configRootMount and env is undefined", () => {
    assert.equal(defaultHomeForConfigRoot(undefined, undefined), undefined);
  });

  it("returns env unchanged when HOME is already set", () => {
    const env = { PORT: "3010", HOME: "/custom" };
    assert.equal(
      defaultHomeForConfigRoot(env, "/signalk-data"),
      env,
      "should not allocate a new object when HOME is already present",
    );
  });

  it("injects HOME from configRootMount when HOME is absent", () => {
    const result = defaultHomeForConfigRoot({ PORT: "3010" }, "/signalk-data");
    assert.deepEqual(result, { PORT: "3010", HOME: "/signalk-data" });
  });

  it("injects HOME when env is undefined and configRootMount is set", () => {
    assert.deepEqual(defaultHomeForConfigRoot(undefined, "/signalk-data"), {
      HOME: "/signalk-data",
    });
  });

  it("respects an empty-string HOME (consumer opt-out)", () => {
    const env = { HOME: "" };
    // Defined-but-empty HOME is a deliberate consumer choice — never
    // overwrite it. Tools like kopia behave differently with HOME="" than
    // unset, and the consumer may want exactly that.
    assert.equal(defaultHomeForConfigRoot(env, "/signalk-data"), env);
  });
});
