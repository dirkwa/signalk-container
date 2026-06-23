import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../jobs.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isRootless: false,
};

function createOpts(calls: Map<string, unknown[]>): {
  Cmd?: string[];
  Entrypoint?: string[];
} {
  const created = calls.get("createContainer");
  if (!created || created.length === 0) {
    throw new Error("no createContainer call captured");
  }
  return created[0] as { Cmd?: string[]; Entrypoint?: string[] };
}

describe("runJob entrypoint override", () => {
  it("sets HostConfig Entrypoint when entrypoint is provided", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({ images: { "questdb/questdb": {} }, calls });

    await runJob(
      docker,
      {
        image: "questdb/questdb",
        entrypoint: ["sh", "-c"],
        command: ["rm -rf /data/*"],
      },
      client,
    );

    const opts = createOpts(calls);
    // Without this override, an image with its own ENTRYPOINT (e.g. questdb's
    // /docker-entrypoint.sh) would receive the command as args instead of
    // running it as a shell command — silently breaking a reuse-as-helper job.
    assert.deepEqual(opts.Entrypoint, ["sh", "-c"]);
    assert.deepEqual(opts.Cmd, ["rm -rf /data/*"]);
  });

  it("leaves Entrypoint unset when not provided (image default applies)", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({ images: { "alpine:3.19": {} }, calls });

    await runJob(
      docker,
      { image: "alpine:3.19", command: ["echo", "hi"] },
      client,
    );

    const opts = createOpts(calls);
    assert.equal(opts.Entrypoint, undefined);
    assert.deepEqual(opts.Cmd, ["echo", "hi"]);
  });
});
