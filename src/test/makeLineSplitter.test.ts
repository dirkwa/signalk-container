import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLineSplitter } from "../runtime.js";

describe("makeLineSplitter", () => {
  it("emits one line per LF", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("a\nb\nc\n");
    s.flush();
    assert.deepEqual(lines, ["a", "b", "c"]);
  });

  it("treats CRLF, LF and bare CR as line terminators", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    // tippecanoe-style: same line repainted with bare \r, then a real \n
    s.push("progress 10%\rprogress 20%\rprogress 30%\nfinal\n");
    s.flush();
    assert.deepEqual(lines, [
      "progress 10%",
      "progress 20%",
      "progress 30%",
      "final",
    ]);
  });

  it("buffers partial lines across pushes", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("hel");
    s.push("lo\nwor");
    s.push("ld");
    assert.deepEqual(lines, ["hello"]);
    s.flush();
    assert.deepEqual(lines, ["hello", "world"]);
  });

  it("drops empty lines", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("\n\na\n\nb\n");
    s.flush();
    assert.deepEqual(lines, ["a", "b"]);
  });
});
