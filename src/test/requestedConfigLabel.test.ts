import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning, parseRequestedConfigLabel } from "../containers.js";
import { requestedConfigLabel } from "../namespace.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

// Durable unset-drift provenance: buildCreateOptions stamps the env KEY
// NAMES, `command` and `devices` the consumer requested into a label at
// create time, so a fresh server process can still tell that a key was
// dropped while Signal K was down. Env values are deliberately absent —
// the unset check reads only key presence, and a value can be a secret.

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

const baseConfig: ContainerConfig = {
  image: "questdb/questdb",
  tag: "latest",
};

function makeClient(): {
  client: ReturnType<typeof makeMockClient>;
  calls: Map<string, unknown[]>;
} {
  const calls = new Map<string, unknown[]>();
  const client = makeMockClient({
    images: { "questdb/questdb:latest": { Id: "sha256:abc", Config: {} } },
    calls,
  });
  return { client, calls };
}

function labelsFrom(calls: Map<string, unknown[]>): Record<string, string> {
  const created = calls.get("createContainer");
  if (!created || created.length === 0) {
    throw new Error("no `createContainer` call captured");
  }
  return (created[0] as { Labels?: Record<string, string> }).Labels ?? {};
}

describe("ensureRunning — requested-config provenance label", () => {
  it("stamps env key names, sorted, without their values", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, env: { ZULU: "1", ALPHA: "2" } },
      () => {},
      undefined,
      client,
    );
    const parsed = parseRequestedConfigLabel(
      labelsFrom(calls)[requestedConfigLabel()],
    );
    assert.deepEqual(parsed?.envKeys, ["ALPHA", "ZULU"]);
  });

  it("never writes an env value into the label", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, env: { SIGNALK_TOKEN: "s3cr3t-do-not-persist" } },
      () => {},
      undefined,
      client,
    );
    const serialized = JSON.stringify(labelsFrom(calls));
    assert.ok(
      !serialized.includes("s3cr3t-do-not-persist"),
      "env value leaked into a container label",
    );
    assert.ok(serialized.includes("SIGNALK_TOKEN"), "env key was not recorded");
  });

  it("stamps command and devices when requested", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, command: ["serve", "--fast"], devices: ["/dev/snd"] },
      () => {},
      undefined,
      client,
    );
    const parsed = parseRequestedConfigLabel(
      labelsFrom(calls)[requestedConfigLabel()],
    );
    assert.deepEqual(parsed?.command, ["serve", "--fast"]);
    assert.deepEqual(parsed?.devices, ["/dev/snd"]);
  });

  it("omits keys entirely when the source fields are unset", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      () => {},
      undefined,
      client,
    );
    const raw = labelsFrom(calls)[requestedConfigLabel()];
    assert.equal(raw, "{}");
    assert.deepEqual(parseRequestedConfigLabel(raw), {});
  });

  it("cannot be shadowed by a consumer label of the same key", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      {
        ...baseConfig,
        env: { REAL: "1" },
        labels: { [requestedConfigLabel()]: '{"envKeys":["SPOOFED"]}' },
      },
      () => {},
      undefined,
      client,
    );
    const parsed = parseRequestedConfigLabel(
      labelsFrom(calls)[requestedConfigLabel()],
    );
    assert.deepEqual(parsed?.envKeys, ["REAL"]);
  });
});

describe("parseRequestedConfigLabel", () => {
  it("returns undefined for an absent label, never an empty object", () => {
    // `{}` would read as "created with no env at all", masking a genuine
    // unset. Absent provenance must stay indistinguishable from unknown.
    assert.equal(parseRequestedConfigLabel(undefined), undefined);
  });

  it("returns undefined rather than throwing on malformed JSON", () => {
    assert.equal(parseRequestedConfigLabel("{nope"), undefined);
  });

  it("returns undefined for a non-object payload", () => {
    assert.equal(parseRequestedConfigLabel('"a string"'), undefined);
    assert.equal(parseRequestedConfigLabel("[1,2]"), undefined);
  });

  it("drops fields that are not arrays of strings", () => {
    const parsed = parseRequestedConfigLabel(
      '{"envKeys":"notanarray","command":[1,2],"devices":["/dev/snd"]}',
    );
    assert.equal(parsed?.envKeys, undefined);
    assert.equal(parsed?.command, undefined);
    assert.deepEqual(parsed?.devices, ["/dev/snd"]);
  });
});
