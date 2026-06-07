import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orphanFromContainer, cleanupOrphanedJobs } from "../jobs.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

describe("orphanFromContainer", () => {
  it("builds an orphan from a well-formed container summary with all our labels", () => {
    const parsed = orphanFromContainer(
      {
        Names: ["/sk-job-7d4839a9"],
        Image: "ghcr.io/dirkwa/.../tippecanoe:latest",
        Labels: {
          "sk-charts-job": "1",
          "sk-job-owner": "signalk-charts-provider-simple",
          "sk-job-label": "tippecanoe",
        },
      },
      "signalk-charts-provider-simple",
    );
    assert.deepEqual(parsed, {
      name: "sk-job-7d4839a9",
      image: "ghcr.io/dirkwa/.../tippecanoe:latest",
      ownerPluginId: "signalk-charts-provider-simple",
      label: "tippecanoe",
    });
  });

  it("strips the leading slash the runtime adds to Names", () => {
    const parsed = orphanFromContainer(
      {
        Names: ["/sk-job-abc12345"],
        Image: "docker.io/library/alpine:latest",
        Labels: { "sk-job-owner": "plugin-x" },
      },
      "plugin-x",
    );
    assert.equal(parsed?.name, "sk-job-abc12345");
  });

  it("tolerates a missing user-supplied label", () => {
    const parsed = orphanFromContainer(
      {
        Names: ["/sk-job-abc12345"],
        Image: "docker.io/library/alpine:latest",
        Labels: {
          "sk-charts-job": "1",
          "sk-job-owner": "signalk-charts-provider-simple",
        },
      },
      "signalk-charts-provider-simple",
    );
    assert.equal(parsed?.label, undefined);
    assert.equal(parsed?.name, "sk-job-abc12345");
  });

  it("does not depend on label ordering (structured object, not a delimited string)", () => {
    // The structured Labels object is order-independent; assert that
    // extraction works regardless of key order.
    const parsed = orphanFromContainer(
      {
        Names: ["/sk-job-abc"],
        Image: "img:latest",
        Labels: {
          "sk-job-owner": "plugin-x",
          "sk-charts-job": "1",
          "sk-job-label": "lbl",
        },
      },
      "plugin-x",
    );
    assert.equal(parsed?.label, "lbl");
  });

  it("returns null when name or image is missing", () => {
    // A summary with no usable name or image means the list emitter shifted
    // shape — refuse to invent data.
    assert.equal(
      orphanFromContainer(
        { Names: [], Image: "img", Labels: { "sk-job-owner": "x" } },
        "x",
      ),
      null,
    );
    assert.equal(
      orphanFromContainer(
        { Names: ["/sk-job-x"], Image: "", Labels: { "sk-job-owner": "x" } },
        "x",
      ),
      null,
    );
    assert.equal(
      orphanFromContainer({ Labels: { "sk-job-owner": "x" } }, "x"),
      null,
    );
  });

  it("returns null when the owner label does not match ownerPluginId", () => {
    // The `label=sk-job-owner=...` list filter should restrict results to the
    // caller's plugin, but defense in depth — if a mismatched row ever
    // appears, refuse to claim it rather than reap someone else's container.
    const parsed = orphanFromContainer(
      {
        Names: ["/sk-job-x"],
        Image: "img:latest",
        Labels: {
          "sk-charts-job": "1",
          "sk-job-owner": "plugin-a",
          "sk-job-label": "lbl",
        },
      },
      "plugin-b",
    );
    assert.equal(parsed, null);
  });

  it("returns null when there is no sk-job-owner label", () => {
    // Without a positive `sk-job-owner` match the parser refuses to claim the
    // row — `remove --force` requires positive ownership proof.
    const parsed = orphanFromContainer(
      {
        Names: ["/sk-job-x"],
        Image: "img:latest",
        Labels: { "sk-charts-job": "1" },
      },
      "owner-x",
    );
    assert.equal(parsed, null);
  });

  it("returns null when the Labels object is absent entirely", () => {
    const parsed = orphanFromContainer(
      { Names: ["/sk-job-x"], Image: "img:latest" },
      "owner-x",
    );
    assert.equal(parsed, null);
  });

  it("round-trips a label containing commas and percent signs RAW (no decode)", () => {
    // The structured Labels object preserves values byte-for-byte, including
    // characters like commas and percent signs that need no escaping.
    const raw = "tippecanoe,with,commas 100% done";
    const parsed = orphanFromContainer(
      {
        Names: ["/sk-job-x"],
        Image: "img:latest",
        Labels: {
          "sk-charts-job": "1",
          "sk-job-owner": "plugin",
          "sk-job-label": raw,
        },
      },
      "plugin",
    );
    assert.equal(parsed?.label, raw);
  });
});

describe("cleanupOrphanedJobs", () => {
  it("force-removes every owned orphan from listContainers and returns them", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      calls,
      listContainers: [
        {
          Names: ["/sk-job-aaa"],
          Image: "img:latest",
          Labels: {
            "sk-charts-job": "1",
            "sk-job-owner": "plugin-x",
            "sk-job-label": "first",
          },
        },
        {
          Names: ["/sk-job-bbb"],
          Image: "img:latest",
          Labels: {
            "sk-charts-job": "1",
            "sk-job-owner": "plugin-x",
          },
        },
      ],
    });

    const result = await cleanupOrphanedJobs(dummyRuntime, "plugin-x", client);

    assert.deepEqual(result.reaped, [
      {
        name: "sk-job-aaa",
        image: "img:latest",
        ownerPluginId: "plugin-x",
        label: "first",
      },
      {
        name: "sk-job-bbb",
        image: "img:latest",
        ownerPluginId: "plugin-x",
        label: undefined,
      },
    ]);

    const removes = calls.get("remove") ?? [];
    assert.equal(removes.length, 2);
    assert.deepEqual(removes[0], { id: "sk-job-aaa", opts: { force: true } });
    assert.deepEqual(removes[1], { id: "sk-job-bbb", opts: { force: true } });
  });

  it("skips rows whose owner label does not match and never removes them", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      calls,
      // Defense in depth: the list filter should already exclude these, but a
      // mismatched row must not be reaped.
      listContainers: [
        {
          Names: ["/sk-job-mine"],
          Image: "img:latest",
          Labels: { "sk-charts-job": "1", "sk-job-owner": "plugin-x" },
        },
        {
          Names: ["/sk-job-theirs"],
          Image: "img:latest",
          Labels: { "sk-charts-job": "1", "sk-job-owner": "plugin-y" },
        },
      ],
    });

    const result = await cleanupOrphanedJobs(dummyRuntime, "plugin-x", client);

    assert.deepEqual(
      result.reaped.map((o) => o.name),
      ["sk-job-mine"],
    );
    const removes = calls.get("remove") ?? [];
    assert.equal(removes.length, 1);
    assert.deepEqual(removes[0], { id: "sk-job-mine", opts: { force: true } });
  });

  it("treats a 404 on remove as success (TOCTOU: container exited between list and remove)", async () => {
    const calls = new Map<string, unknown[]>();
    const gone = new Error("no such container") as Error & {
      statusCode?: number;
    };
    gone.statusCode = 404;
    const client = makeMockClient({
      calls,
      listContainers: [
        {
          Names: ["/sk-job-aaa"],
          Image: "img:latest",
          Labels: { "sk-charts-job": "1", "sk-job-owner": "plugin-x" },
        },
      ],
      defaultContainer: {
        remove: () => Promise.reject(gone),
      },
    });

    const result = await cleanupOrphanedJobs(dummyRuntime, "plugin-x", client);

    // Gone-already is the rollback-correct case: still counted as reaped.
    assert.deepEqual(
      result.reaped.map((o) => o.name),
      ["sk-job-aaa"],
    );
  });

  it("returns an empty reaped list when nothing is listed", async () => {
    const client = makeMockClient({ listContainers: [] });
    const result = await cleanupOrphanedJobs(dummyRuntime, "plugin-x", client);
    assert.deepEqual(result.reaped, []);
  });
});
