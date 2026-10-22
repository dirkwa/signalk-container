import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runJob, splitLongLine } from "../jobs.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isRootless: false,
};

const MAX_LINE = 16 * 1024;

/** A finished log stream delivering `chunks` as separate writes. */
function streamOfChunks(chunks: string[]): NodeJS.ReadableStream {
  const s = new PassThrough();
  for (const c of chunks) s.write(Buffer.from(c));
  s.end();
  return s;
}

async function linesFrom(chunks: string[]): Promise<string[]> {
  const lines: string[] = [];
  const client = makeMockClient({
    images: { "alpine:3.19": {} },
    defaultContainer: {
      logs: () => Promise.resolve(streamOfChunks(chunks)),
      wait: { StatusCode: 0 },
    },
  });
  const result = await runJob(
    docker,
    {
      image: "alpine:3.19",
      command: ["true"],
      onStdoutLine: (line) => lines.push(line),
    },
    client,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.log, lines);
  return lines;
}

describe("runJob log line length", () => {
  it("keeps a character split across two log frames intact", async () => {
    const s = new PassThrough();
    const client = makeMockClient({
      images: { "alpine:3.19": {} },
      defaultContainer: {
        logs: () => Promise.resolve(s),
        wait: { StatusCode: 0 },
      },
    });
    const bytes = Buffer.from("café\n");
    s.write(bytes.subarray(0, 4));
    s.write(bytes.subarray(4));
    s.end();

    const result = await runJob(
      docker,
      { image: "alpine:3.19", command: ["true"] },
      client,
    );
    assert.deepEqual(result.log, ["café"]);
  });

  it("keeps a last line that has no newline", async () => {
    assert.deepEqual(await linesFrom(["first\nlast"]), ["first", "last"]);
  });

  it("passes output without newlines on in bounded pieces", async () => {
    const chunk = "x".repeat(10 * 1024);
    const lines = await linesFrom(Array.from({ length: 10 }, () => chunk));

    assert.ok(lines.every((l) => l.length <= MAX_LINE));
    assert.equal(lines.join(""), chunk.repeat(10));
  });

  it("splits one oversized chunk without losing or reordering text", async () => {
    const text = Array.from({ length: 3 * MAX_LINE + 5 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join("");
    const lines = await linesFrom([text]);

    assert.deepEqual(
      lines.map((l) => l.length),
      [MAX_LINE, MAX_LINE, MAX_LINE, 5],
    );
    assert.equal(lines.join(""), text);
  });

  it("splits an oversized line that ends with a newline", async () => {
    const text = "y".repeat(MAX_LINE + 10);
    const lines = await linesFrom([`${text}\nnext\n`]);

    assert.deepEqual(
      lines.map((l) => l.length),
      [MAX_LINE, 10, 4],
    );
    assert.equal(lines.slice(0, 2).join(""), text);
  });

  it("leaves ordinary lines untouched", async () => {
    const lines = await linesFrom(["first line\nsecond ", "line\n", "tail"]);
    assert.deepEqual(lines, ["first line", "second line", "tail"]);
  });
});

describe("splitLongLine", () => {
  it("never splits a surrogate pair", () => {
    const pieces = splitLongLine("a" + "\u{1F600}".repeat(4), 4);
    assert.deepEqual(pieces, ["a\u{1F600}", "\u{1F600}\u{1F600}", "\u{1F600}"]);
  });

  it("still advances when the limit cannot hold a surrogate pair", () => {
    assert.deepEqual(splitLongLine("\u{1F600}", 1), ["\ud83d", "\ude00"]);
  });

  it("rejects a limit below one", () => {
    assert.throws(() => splitLongLine("abc", 0), RangeError);
    assert.throws(() => splitLongLine("abc", 1.5), RangeError);
  });

  it("returns a short line as is", () => {
    assert.deepEqual(splitLongLine("abc", 4), ["abc"]);
  });
});
