import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyTextToClipboard } from "../clipboard.js";

// The helper reads the `navigator` and `document` globals. Modern Node
// ships a read-only `navigator` getter, so override via defineProperty
// (plain assignment throws) and restore the descriptors afterwards.
const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const docDesc = Object.getOwnPropertyDescriptor(globalThis, "document");

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
  else delete (globalThis as Record<string, unknown>).navigator;
  if (docDesc) Object.defineProperty(globalThis, "document", docDesc);
  else delete (globalThis as Record<string, unknown>).document;
});

describe("copyTextToClipboard", () => {
  it("uses the async Clipboard API when available", async () => {
    let written: string | null = null;
    setGlobal("navigator", {
      clipboard: {
        writeText: (t: string) => {
          written = t;
          return Promise.resolve();
        },
      },
    });
    // Make the legacy path throw if reached, so we know async won.
    setGlobal("document", undefined);

    const ok = await copyTextToClipboard("hello");
    assert.equal(ok, true);
    assert.equal(written, "hello");
  });

  it("falls back to execCommand when the async API is unavailable", async () => {
    setGlobal("navigator", {}); // no clipboard
    let execArg: string | null = null;
    let appended = 0;
    let removed = 0;
    const fakeTextarea = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: () => {},
      select: () => {},
    };
    setGlobal("document", {
      createElement: () => fakeTextarea,
      body: {
        appendChild: () => {
          appended++;
        },
        removeChild: () => {
          removed++;
        },
      },
      execCommand: (cmd: string) => {
        execArg = cmd;
        return true;
      },
    });

    const ok = await copyTextToClipboard("payload");
    assert.equal(ok, true);
    assert.equal(execArg, "copy");
    assert.equal(fakeTextarea.value, "payload");
    assert.equal(appended, 1);
    assert.equal(removed, 1); // textarea cleaned up even on success
  });

  it("returns false when neither mechanism is available (SSR-safe)", async () => {
    setGlobal("navigator", undefined);
    setGlobal("document", undefined);
    const ok = await copyTextToClipboard("x");
    assert.equal(ok, false);
  });

  it("returns false when execCommand reports failure", async () => {
    setGlobal("navigator", {});
    setGlobal("document", {
      createElement: () => ({
        value: "",
        style: {} as Record<string, string>,
        setAttribute: () => {},
        select: () => {},
      }),
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand: () => false,
    });
    const ok = await copyTextToClipboard("x");
    assert.equal(ok, false);
  });
});
