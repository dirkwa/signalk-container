import { it } from "node:test";
import assert from "node:assert/strict";
import { SandboxFrames } from "../sandbox-stream.js";
import { SandboxOutput } from "../sandbox.js";

function frame(type: number, value: string): Buffer {
  const bytes = Buffer.from(value),
    header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
it("decodes fragmented headers and interleaved streams under one byte budget", () => {
  const output = new SandboxOutput(8),
    frames = new SandboxFrames(output);
  const bytes = Buffer.concat([
    frame(1, "abc"),
    frame(2, "def"),
    frame(1, "ghi"),
  ]);
  let accepted = true;
  for (const byte of bytes) {
    accepted = frames.append(Buffer.from([byte]));
    if (!accepted) break;
  }
  assert.equal(accepted, false);
  assert.equal(output.snapshot().toString(), "abcdefgh");
});
it("does not allocate a declared multi-gigabyte frame", () => {
  const output = new SandboxOutput(4),
    frames = new SandboxFrames(output);
  const header = Buffer.from([1, 0, 0, 0, 255, 255, 255, 255]);
  assert.equal(frames.append(header), true);
  assert.equal(frames.append(Buffer.from("12345")), false);
  assert.equal(output.snapshot().length, 4);
});
it("rejects bad framing and truncation", () => {
  const frames = new SandboxFrames(new SandboxOutput());
  assert.throws(() => frames.append(Buffer.from([3, 0, 0, 0, 0, 0, 0, 1])));
  const partial = new SandboxFrames(new SandboxOutput());
  partial.append(frame(1, "abc").subarray(0, 9));
  assert.throws(() => partial.finish());
});
