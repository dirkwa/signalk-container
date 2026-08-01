import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureRunning, getRequestedResources } from "../containers.js";
import { requestedResourcesLabel } from "../namespace.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

// Durable requested-resources provenance (#216): buildCreateOptions stamps
// the consumer's requested limits into a label at create time, and
// getRequestedResources reads it back when a fresh server process has no
// in-memory provenance. Without this, the oom_score_adj rootless podman
// clamps onto every child of a non-zero-oom_score_adj server was misread
// as a user unset on every startup.

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

describe("ensureRunning — requested-resources provenance label", () => {
  it("stamps the requested limits at create time", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      { ...baseConfig, resources: { memory: "512m", cpus: 1.5 } },
      () => {},
      undefined,
      client,
    );
    const labels = labelsFrom(calls);
    assert.deepEqual(JSON.parse(labels[requestedResourcesLabel()]), {
      memory: "512m",
      cpus: 1.5,
    });
  });

  it("stamps '{}' when no resources are requested — definite, not unknown", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      baseConfig,
      () => {},
      undefined,
      client,
    );
    assert.equal(labelsFrom(calls)[requestedResourcesLabel()], "{}");
  });

  it("keeps consumer labels and wins over a shadowing key", async () => {
    const { client, calls } = makeClient();
    await ensureRunning(
      docker,
      "questdb",
      {
        ...baseConfig,
        labels: { theirs: "kept", [requestedResourcesLabel()]: "spoofed" },
        resources: { memory: "1g" },
      },
      () => {},
      undefined,
      client,
    );
    const labels = labelsFrom(calls);
    assert.equal(labels["theirs"], "kept");
    assert.deepEqual(JSON.parse(labels[requestedResourcesLabel()]), {
      memory: "1g",
    });
  });
});

describe("getRequestedResources", () => {
  it("reads the stamped limits back from a live container", async () => {
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: {
            Config: {
              Labels: {
                [requestedResourcesLabel()]: JSON.stringify({ memory: "512m" }),
              },
            },
          },
        },
      },
    });
    assert.deepEqual(await getRequestedResources("questdb", client), {
      memory: "512m",
    });
  });

  it("returns {} for a container created with no limits", async () => {
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: {
            Config: { Labels: { [requestedResourcesLabel()]: "{}" } },
          },
        },
      },
    });
    assert.deepEqual(await getRequestedResources("questdb", client), {});
  });

  it("returns undefined when the container predates the label", async () => {
    const client = makeMockClient({
      containers: {
        "sk-questdb": { inspect: { Config: { Labels: { other: "x" } } } },
      },
    });
    assert.equal(await getRequestedResources("questdb", client), undefined);
  });

  it("returns undefined when the container is missing", async () => {
    const client = makeMockClient({});
    assert.equal(await getRequestedResources("questdb", client), undefined);
  });

  it("returns undefined when the label does not parse", async () => {
    const client = makeMockClient({
      containers: {
        "sk-questdb": {
          inspect: {
            Config: { Labels: { [requestedResourcesLabel()]: "{nope" } },
          },
        },
      },
    });
    assert.equal(await getRequestedResources("questdb", client), undefined);
  });
});
