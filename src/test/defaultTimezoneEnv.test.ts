import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultTimezoneEnv, resolveHostTimezone } from "../containers.js";

describe("resolveHostTimezone", () => {
  it("returns the resolved IANA zone", () => {
    assert.equal(
      resolveHostTimezone(() => "Pacific/Fiji"),
      "Pacific/Fiji",
    );
  });

  it("returns undefined for UTC-equivalent zones", () => {
    for (const zone of ["UTC", "Etc/UTC", "Etc/Universal", "GMT", "Zulu"]) {
      assert.equal(
        resolveHostTimezone(() => zone),
        undefined,
        zone,
      );
    }
  });

  it("resolves the environment's zone by default", () => {
    // The default call must agree with an injected resolver fed the
    // real Intl zone — whatever this test host is set to.
    const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(
      resolveHostTimezone(),
      resolveHostTimezone(() => systemZone),
    );
  });
});

describe("defaultTimezoneEnv", () => {
  it("returns env unchanged when the zone is undefined", () => {
    const env = { PORT: "3010" };
    assert.equal(defaultTimezoneEnv(env, undefined), env);
  });

  it("returns undefined unchanged when zone is undefined and env is undefined", () => {
    assert.equal(defaultTimezoneEnv(undefined, undefined), undefined);
  });

  it("returns env unchanged when TZ is already set", () => {
    const env = { PORT: "3010", TZ: "Europe/Berlin" };
    assert.equal(
      defaultTimezoneEnv(env, "Pacific/Fiji"),
      env,
      "should not allocate a new object when TZ is already present",
    );
  });

  it("injects TZ when absent", () => {
    const result = defaultTimezoneEnv({ PORT: "3010" }, "Pacific/Fiji");
    assert.deepEqual(result, { PORT: "3010", TZ: "Pacific/Fiji" });
  });

  it("injects TZ when env is undefined", () => {
    assert.deepEqual(defaultTimezoneEnv(undefined, "Pacific/Fiji"), {
      TZ: "Pacific/Fiji",
    });
  });

  it("respects an empty-string TZ (consumer opt-out)", () => {
    const env = { TZ: "" };
    // Defined-but-empty TZ is a deliberate consumer choice — never
    // overwrite it. POSIX treats TZ="" as UTC, which is a valid way to
    // pin a container to UTC on a non-UTC host.
    assert.equal(defaultTimezoneEnv(env, "Pacific/Fiji"), env);
  });
});
