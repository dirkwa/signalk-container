import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectManagedImageRefs } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient, httpError } from "./helpers/mockClient.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

function corrupt500(): Error {
  return httpError(
    '(HTTP code 500) server error - getting graph driver info "abc123": ' +
      "readlink /home/u/.local/share/containers/storage/overlay: invalid argument ",
    500,
  );
}

const manifests: Array<{ containers: Record<string, { image: string }> }> = [
  { containers: { questdb: { image: "questdb/questdb" } } },
  { containers: { grafana: { image: "grafana/grafana" } } },
];

describe("collectManagedImageRefs", () => {
  it("returns the running image id for every healthy container", async () => {
    const client = makeMockClient({
      containers: {
        "sk-questdb": { inspect: { Image: "sha256:live-questdb" } },
        "sk-grafana": { inspect: { Image: "sha256:live-grafana" } },
      },
    });
    const refs = await collectManagedImageRefs(
      docker,
      manifests,
      () => {},
      client,
    );
    assert.deepEqual(refs, [
      { image: "questdb/questdb", runningImageId: "sha256:live-questdb" },
      { image: "grafana/grafana", runningImageId: "sha256:live-grafana" },
    ]);
  });

  it("reads the container's image even when an image shares the container's name", async () => {
    // A local image tagged "sk-questdb" must not shadow the container:
    // the ref anchors what the container actually runs, not a lookalike.
    const client = makeMockClient({
      containers: {
        "sk-questdb": { inspect: { Image: "sha256:live-questdb" } },
        "sk-grafana": { inspect: { Image: "sha256:live-grafana" } },
      },
      images: { "sk-questdb": { Id: "sha256:decoy-image" } },
    });
    const refs = await collectManagedImageRefs(
      docker,
      manifests,
      () => {},
      client,
    );
    assert.equal(refs[0].runningImageId, "sha256:live-questdb");
  });

  it("degrades a corrupt container to runningImageId null instead of aborting (issue #219)", async () => {
    // One container's storage is corrupt — its inspect 500s. The whole
    // refs list must still be produced; the corrupt entry becomes
    // unanchored (null), which the reaper treats as "keep every version".
    const client = makeMockClient({
      containers: {
        "sk-questdb": { inspect: { Image: "sha256:live-questdb" } },
        "sk-grafana": { inspect: () => Promise.reject(corrupt500()) },
      },
    });
    const debugLines: string[] = [];
    const refs = await collectManagedImageRefs(
      docker,
      manifests,
      (m) => debugLines.push(m),
      client,
    );
    assert.deepEqual(refs, [
      { image: "questdb/questdb", runningImageId: "sha256:live-questdb" },
      { image: "grafana/grafana", runningImageId: null },
    ]);
    assert.ok(
      debugLines.some((l) => l.includes("keeping all versions")),
      `expected a keep-all debug line, got: ${debugLines.join(" | ")}`,
    );
  });
});
