import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setNamespace,
  resetNamespace,
  getNamespace,
  containerPrefix,
  jobPrefix,
  jobMarkerLabel,
  jobOwnerLabel,
  jobNameLabel,
} from "../namespace.js";
import { prefixedName } from "../containers.js";
import { orphanFromContainer, cleanupOrphanedJobs } from "../jobs.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

// The namespace is module-global; never let one case leak into the next
// (or into another test file that assumes the default).
afterEach(() => resetNamespace());

describe("namespace token resolution", () => {
  it("defaults to sk", () => {
    assert.equal(getNamespace(), "sk");
    assert.equal(containerPrefix(), "sk-");
    assert.equal(jobPrefix(), "sk-job-");
    assert.equal(jobMarkerLabel(), "sk-charts-job");
    assert.equal(jobOwnerLabel(), "sk-job-owner");
    assert.equal(jobNameLabel(), "sk-job-label");
  });

  it("applies a valid namespace to every derived name and label", () => {
    setNamespace("devpod");
    assert.equal(getNamespace(), "devpod");
    assert.equal(containerPrefix(), "devpod-");
    assert.equal(jobPrefix(), "devpod-job-");
    assert.equal(jobMarkerLabel(), "devpod-charts-job");
    assert.equal(jobOwnerLabel(), "devpod-job-owner");
    assert.equal(jobNameLabel(), "devpod-job-label");
  });

  it("treats undefined as the default without reporting it", () => {
    setNamespace("devpod");
    let called = false;
    setNamespace(undefined, () => (called = true));
    assert.equal(getNamespace(), "sk");
    assert.equal(called, false);
  });

  it("treats an explicit empty string as reported-invalid", () => {
    setNamespace("devpod");
    let reported: string | undefined = "unset";
    setNamespace("", (v) => (reported = v));
    assert.equal(getNamespace(), "sk");
    assert.equal(reported, "");
  });

  it("resetNamespace restores the default", () => {
    setNamespace("devpod");
    resetNamespace();
    assert.equal(getNamespace(), "sk");
  });

  it("rejects invalid values, reports them, and falls back to the default", () => {
    for (const bad of [
      "Dev",
      "dev pod",
      "dev_pod",
      "dev-pod",
      "a".repeat(33),
    ]) {
      let reported: string | undefined;
      setNamespace(bad, (v) => (reported = v));
      assert.equal(getNamespace(), "sk", `expected fallback for ${bad}`);
      assert.equal(reported, bad, `expected onInvalid for ${bad}`);
    }
  });

  it("does not invoke onInvalid for accepted values", () => {
    let called = false;
    setNamespace("devpod", () => (called = true));
    assert.equal(called, false);
  });
});

describe("prefixedName honours the active namespace", () => {
  it("prefixes bare names and is idempotent", () => {
    assert.equal(prefixedName("questdb"), "sk-questdb");
    assert.equal(prefixedName("sk-questdb"), "sk-questdb");
    setNamespace("devpod");
    assert.equal(prefixedName("questdb"), "devpod-questdb");
    assert.equal(prefixedName("devpod-questdb"), "devpod-questdb");
  });
});

describe("reaping is isolated across namespaces", () => {
  it("a dev instance never claims a production sk-job-* helper", () => {
    setNamespace("devpod");
    const prodJob = {
      Names: ["/sk-job-7d4839a9"],
      Image: "ghcr.io/dirkwa/tippecanoe:latest",
      Labels: {
        "sk-charts-job": "1",
        "sk-job-owner": "signalk-charts-provider-simple",
        "sk-job-label": "tippecanoe",
      },
    };
    assert.equal(
      orphanFromContainer(prodJob, "signalk-charts-provider-simple"),
      null,
    );
  });

  it("a dev instance claims its own devpod-job-* helper", () => {
    setNamespace("devpod");
    const devJob = {
      Names: ["/devpod-job-7d4839a9"],
      Image: "ghcr.io/dirkwa/tippecanoe:latest",
      Labels: {
        "devpod-charts-job": "1",
        "devpod-job-owner": "signalk-charts-provider-simple",
        "devpod-job-label": "tippecanoe",
      },
    };
    assert.deepEqual(
      orphanFromContainer(devJob, "signalk-charts-provider-simple"),
      {
        name: "devpod-job-7d4839a9",
        image: "ghcr.io/dirkwa/tippecanoe:latest",
        ownerPluginId: "signalk-charts-provider-simple",
        label: "tippecanoe",
      },
    );
  });

  it("cleanupOrphanedJobs filters the list by the namespaced labels", async () => {
    setNamespace("devpod");
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({ listContainers: [], calls });
    await cleanupOrphanedJobs(dummyRuntime, "plugin-x", client);
    const opts = calls.get("listContainers")?.[0] as {
      filters?: { label?: string[] };
    };
    assert.deepEqual(opts.filters?.label, [
      "devpod-charts-job=1",
      "devpod-job-owner=plugin-x",
    ]);
  });
});
