import { it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { SandboxExecutor, attachSandbox } from "../sandbox-executor.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type Docker from "dockerode";
import type { SandboxJobRequest } from "../types.js";

const image = "ghcr.io/example/worker@sha256:" + "a".repeat(64);
const request: SandboxJobRequest = {
  ownerPluginId: "test-owner",
  image,
  runnerPath: "/usr/local/bin/node",
  stdin: Buffer.from("secret code"),
};
function mock() {
  const calls = new Map<string, unknown[]>();
  const client = makeMockClient({
    images: {
      [image]: {
        Id: "sha256:" + "b".repeat(64),
        RepoDigests: [image],
        Config: {},
      },
    },
    calls,
  });
  return { client, calls };
}
it("rejects a pre-aborted call without touching the runtime", async () => {
  const { client, calls } = mock(),
    controller = new AbortController();
  controller.abort();
  assert.equal(
    (await new SandboxExecutor(client).run(request, controller.signal)).status,
    "cancelled",
  );
  assert.equal(calls.size, 0);
});
it("serializes admission and bounds attempts without retaining a queue", async () => {
  const { client } = mock();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  client.createContainer = () => {
    entered();
    return new Promise<Docker.Container>(() => {});
  };
  const executor = new SandboxExecutor(client),
    controller = new AbortController();
  const first = executor.run(request, controller.signal);
  await started;
  assert.equal((await executor.run(request)).status, "busy");
  controller.abort();
  assert.equal((await first).status, "cancelled");
  client.createContainer = async () => {
    throw new Error("daemon included confidential data");
  };
  for (let i = 0; i < 5; i++) {
    const result = await executor.run(request);
    assert.equal(result.status, "isolation-unavailable");
    assert.ok(!JSON.stringify(result).includes("confidential"));
  }
  assert.equal((await executor.run(request)).status, "rate-limited");
});
it("removes a late-created container after cancellation without starting it", async () => {
  const { client, calls } = mock(),
    create = client.createContainer.bind(client);
  let release!: (container: Docker.Container) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  client.createContainer = () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const controller = new AbortController();
  const running = new SandboxExecutor(client).run(request, controller.signal);
  await started;
  controller.abort();
  assert.equal((await running).cleanup, "pending");
  release(await create({ Image: "test" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.get("start"), undefined);
  assert.equal(calls.get("remove")?.length, 1);
});

it("attaches with an empty HTTP body so options cannot become worker input", async () => {
  const { client } = mock(),
    stream = new PassThrough();
  client.modem.dial = (options, callback) => {
    assert.equal(options.path, "/containers/job-id/attach?");
    assert.equal(options.method, "POST");
    assert.equal(options.hijack, true);
    assert.deepEqual(options.file, Buffer.alloc(0));
    assert.equal(options.options?.stdin, true);
    callback(null, stream);
  };
  assert.equal(
    await attachSandbox(client, "job-id", new AbortController().signal),
    stream,
  );
  stream.destroy();
});
