import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tailContainerLogs,
  getContainerLogs,
  MAX_TAIL,
} from "../containers.js";
import { PassThrough } from "node:stream";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient, streamFrom } from "./helpers/mockClient.js";

const runtime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "test",
  isPodmanDockerShim: false,
};

/** Give the `.logs(...).then(...)` microtask chain a tick to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Build a mock client whose `containerId` streams `text` from a
 * (newly constructed each call) follow-logs stream, recording calls
 * so tests can assert on the `logs(opts)` payload.
 */
function clientStreaming(
  containerId: string,
  text: string,
  calls?: Map<string, unknown[]>,
) {
  return makeMockClient({
    containers: {
      [containerId]: { logs: () => Promise.resolve(streamFrom(text)) },
    },
    calls,
  });
}

describe("tailContainerLogs", () => {
  it("forwards demuxed lines to onLine and prefixes the container name", async () => {
    const lines: string[] = [];
    const calls = new Map<string, unknown[]>();
    const client = clientStreaming("sk-foo", "line1\nline2\n", calls);
    tailContainerLogs(runtime, "foo", (l) => lines.push(l), { client });
    await flush();
    assert.deepEqual(lines, ["line1", "line2"]);
    // The handle resolved its log stream against the prefixed name.
    const logCalls = calls.get("logs") as Array<{ id: string }>;
    assert.equal(logCalls.length, 1);
    assert.equal(logCalls[0].id, "sk-foo");
  });

  it("requests a follow stream with default tail 0", async () => {
    const calls = new Map<string, unknown[]>();
    const client = clientStreaming("sk-foo", "", calls);
    tailContainerLogs(runtime, "foo", () => {}, { client });
    await flush();
    const logCalls = calls.get("logs") as Array<{
      opts: { follow?: boolean; tail?: number };
    }>;
    assert.equal(logCalls[0].opts.follow, true);
    assert.equal(logCalls[0].opts.tail, 0);
  });

  it("honours startTail when supplied", async () => {
    const calls = new Map<string, unknown[]>();
    const client = clientStreaming("sk-foo", "", calls);
    tailContainerLogs(runtime, "foo", () => {}, { client, startTail: 100 });
    await flush();
    const logCalls = calls.get("logs") as Array<{ opts: { tail?: number } }>;
    assert.equal(logCalls[0].opts.tail, 100);
  });

  it("does not double-prefix when name already starts with sk-", async () => {
    const calls = new Map<string, unknown[]>();
    const client = clientStreaming("sk-bar", "", calls);
    tailContainerLogs(runtime, "sk-bar", () => {}, { client });
    await flush();
    const logCalls = calls.get("logs") as Array<{ id: string }>;
    assert.equal(logCalls[0].id, "sk-bar");
  });

  it("returned stop() destroys the underlying stream", async () => {
    // An open (never-ended) PassThrough so only the explicit stop()
    // calls drive destroy() — an already-ended stream would self-destroy
    // on cleanup and inflate the count.
    let destroyed = 0;
    const stream = new PassThrough();
    (stream as unknown as { destroy: () => void }).destroy = () => {
      destroyed++;
    };
    const client = makeMockClient({
      containers: { "sk-foo": { logs: () => Promise.resolve(stream) } },
    });
    const handle = tailContainerLogs(runtime, "foo", () => {}, { client });
    await flush();
    handle.stop();
    handle.stop();
    assert.equal(destroyed, 2);
  });

  it("merges container stderr into onLine via demux", async () => {
    // Regression for the bug where mayara (a Rust container that
    // logs everything to stderr) produced no SSE output.  The mock
    // demuxStream forwards the source straight to the stdout sink,
    // so any stderr the runtime multiplexes reaches onLine the same
    // as stdout — combined stdout+stderr is the documented contract.
    const lines: string[] = [];
    const client = clientStreaming("sk-foo", "stderr-line\n");
    tailContainerLogs(runtime, "foo", (l) => lines.push(l), { client });
    await flush();
    assert.deepEqual(lines, ["stderr-line"]);
  });

  it("normalizes NaN/Infinity/negative startTail to 0", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -7]) {
      const calls = new Map<string, unknown[]>();
      const client = clientStreaming("sk-foo", "", calls);
      tailContainerLogs(runtime, "foo", () => {}, { client, startTail: bad });
      await flush();
      const logCalls = calls.get("logs") as Array<{ opts: { tail?: number } }>;
      assert.equal(
        logCalls[0].opts.tail,
        0,
        `startTail=${bad} should normalize to 0`,
      );
    }
  });

  it("caps absurd startTail at MAX_TAIL", async () => {
    const calls = new Map<string, unknown[]>();
    const client = clientStreaming("sk-foo", "", calls);
    tailContainerLogs(runtime, "foo", () => {}, {
      client,
      startTail: MAX_TAIL + 1,
    });
    await flush();
    const logCalls = calls.get("logs") as Array<{ opts: { tail?: number } }>;
    assert.equal(logCalls[0].opts.tail, MAX_TAIL);
  });

  it("sets spawnFailed and fires onExit(null) when logs() rejects", async () => {
    const exits: Array<number | null> = [];
    const client = makeMockClient({
      containers: {
        "sk-foo": {
          logs: () => Promise.reject(new Error("no such container")),
        },
      },
    });
    const handle = tailContainerLogs(runtime, "foo", () => {}, {
      client,
      onExit: (code) => exits.push(code),
    });
    await flush();
    assert.equal(handle.spawnFailed, true);
    assert.deepEqual(exits, [null]);
  });

  it("handle.pid is always undefined (socket stream has no process)", async () => {
    const client = clientStreaming("sk-foo", "");
    const handle = tailContainerLogs(runtime, "foo", () => {}, { client });
    await flush();
    assert.equal(handle.pid, undefined);
  });
});

describe("getContainerLogs", () => {
  it("requests logs for the prefixed name and returns split lines", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("alpha\nbeta\ngamma") } },
      calls,
    });
    const lines = await getContainerLogs(runtime, "foo", { tail: 3 }, client);
    const logCalls = calls.get("logs") as Array<{
      id: string;
      opts: { follow?: boolean; tail?: number };
    }>;
    assert.equal(logCalls[0].id, "sk-foo");
    assert.equal(logCalls[0].opts.follow, false);
    assert.equal(logCalls[0].opts.tail, 3);
    assert.deepEqual(lines, ["alpha", "beta", "gamma"]);
  });

  it("defaults tail to 200 when not supplied", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("") } },
      calls,
    });
    await getContainerLogs(runtime, "foo", undefined, client);
    const logCalls = calls.get("logs") as Array<{ opts: { tail?: number } }>;
    assert.equal(logCalls[0].opts.tail, 200);
  });

  it("caps tail at MAX_TAIL", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("") } },
      calls,
    });
    await getContainerLogs(runtime, "foo", { tail: MAX_TAIL + 1000 }, client);
    const logCalls = calls.get("logs") as Array<{ opts: { tail?: number } }>;
    assert.equal(logCalls[0].opts.tail, MAX_TAIL);
  });

  it("floors tail to 0 when negative", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("") } },
      calls,
    });
    await getContainerLogs(runtime, "foo", { tail: -50 }, client);
    const logCalls = calls.get("logs") as Array<{ opts: { tail?: number } }>;
    assert.equal(logCalls[0].opts.tail, 0);
  });

  it("includes since when supplied", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("") } },
      calls,
    });
    await getContainerLogs(runtime, "foo", { since: 1700000000 }, client);
    const logCalls = calls.get("logs") as Array<{ opts: { since?: number } }>;
    assert.equal(logCalls[0].opts.since, 1700000000);
  });

  it("omits since when negative, NaN or Infinity", async () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const calls = new Map<string, unknown[]>();
      const client = makeMockClient({
        containers: { "sk-foo": { logs: Buffer.from("") } },
        calls,
      });
      await getContainerLogs(runtime, "foo", { since: bad }, client);
      const logCalls = calls.get("logs") as Array<{
        opts: { since?: number };
      }>;
      assert.equal(
        logCalls[0].opts.since,
        undefined,
        `since=${bad} should not be forwarded`,
      );
    }
  });

  it("falls back to default 200 when tail is NaN or Infinity", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const calls = new Map<string, unknown[]>();
      const client = makeMockClient({
        containers: { "sk-foo": { logs: Buffer.from("") } },
        calls,
      });
      await getContainerLogs(runtime, "foo", { tail: bad }, client);
      const logCalls = calls.get("logs") as Array<{ opts: { tail?: number } }>;
      assert.equal(
        logCalls[0].opts.tail,
        200,
        `tail=${bad} should fall back to 200`,
      );
    }
  });

  it("demuxes the multiplexed buffer into a line array", async () => {
    // The mock demuxStream forwards the source straight to stdout, so
    // both stdout and stderr text the runtime multiplexes arrive on the
    // combined channel (matching `podman logs` semantics).
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("out1\nout2\nerr1") } },
    });
    const lines = await getContainerLogs(runtime, "foo", undefined, client);
    assert.deepEqual(lines, ["out1", "out2", "err1"]);
  });

  it("throws when the runtime rejects (e.g. no such container)", async () => {
    const client = makeMockClient({
      containers: {
        "sk-ghost": {
          logs: () => Promise.reject(new Error("No such container")),
        },
      },
    });
    await assert.rejects(
      () => getContainerLogs(runtime, "ghost", undefined, client),
      /logs ghost/,
    );
  });

  it("strips trailing empty line caused by trailing newline", async () => {
    // Real `podman logs` output typically has a trailing newline,
    // which our split would otherwise turn into an empty array
    // entry.  Verify we drop it.
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("a\nb\n") } },
    });
    const lines = await getContainerLogs(runtime, "foo", undefined, client);
    assert.deepEqual(lines, ["a", "b"]);
  });

  it("does not emit a phantom blank line within demuxed text", async () => {
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("out1\nout2\nerr1") } },
    });
    const lines = await getContainerLogs(runtime, "foo", undefined, client);
    assert.deepEqual(lines, ["out1", "out2", "err1"]);
  });

  it("returns no empty lines for empty log output", async () => {
    const client = makeMockClient({
      containers: { "sk-foo": { logs: Buffer.from("err1\nerr2") } },
    });
    const lines = await getContainerLogs(runtime, "foo", undefined, client);
    assert.ok(
      !lines.some((l) => l === ""),
      `no empty lines expected, got ${JSON.stringify(lines)}`,
    );
  });
});
