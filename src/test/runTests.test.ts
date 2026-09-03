import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { junitWritable, testArgs } from "../scripts/run-tests.js";

/**
 * The runner decides whether to attach the JUnit reporter. Getting that wrong
 * costs the whole suite: the registry clones into a read-only /home, where an
 * unconditional reporter exits non-zero before a single test executes.
 *
 * The unwritable cases need an unprivileged user — root ignores permission
 * bits, so `chmod` cannot create the condition (same guard as
 * `pickSocketPermission.test.ts`).
 */
/** Root ignores directory permission bits, so `chmod` cannot deny it. */
const ROOT_UID = 0;
/** Owner may write: the state a JUnit destination has to be in. */
const MODE_WRITABLE = 0o755;
/** Read+execute only: what makes `junitWritable` report false. */
const MODE_READ_ONLY = 0o555;

const CANNOT_DENY_WRITES =
  process.platform === "win32" ||
  (typeof process.getuid === "function" && process.getuid() === ROOT_UID);

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "skc-run-tests-"));
});

afterEach(() => {
  try {
    chmodSync(scratch, MODE_WRITABLE);
  } catch {
    // already gone / never narrowed
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("junitWritable", () => {
  it("accepts a directory that does not exist yet", () => {
    assert.equal(junitWritable(path.join(scratch, "fresh")), true);
  });

  it("accepts an existing writable directory", () => {
    const dir = path.join(scratch, "existing");
    mkdirSync(dir);
    assert.equal(junitWritable(dir), true);
  });

  it(
    "rejects an existing directory that cannot be written",
    { skip: CANNOT_DENY_WRITES },
    () => {
      // The case that cost a whole run: `mkdirSync` on an existing directory
      // succeeds even when writes are denied, so only an actual write reveals
      // it. Reporting `true` here makes the reporter fail with EACCES later.
      const dir = path.join(scratch, "readonly");
      mkdirSync(dir);
      chmodSync(dir, MODE_READ_ONLY);
      assert.equal(junitWritable(dir), false);
    },
  );

  it(
    "rejects a directory that cannot be created",
    { skip: CANNOT_DENY_WRITES },
    () => {
      chmodSync(scratch, MODE_READ_ONLY);
      assert.equal(junitWritable(path.join(scratch, "nope")), false);
    },
  );

  it("leaves no probe behind on success", () => {
    const dir = path.join(scratch, "clean");
    assert.equal(junitWritable(dir), true);
    assert.equal(readdirSync(dir).length, 0, "probe file was not removed");
  });
});

describe("testArgs", () => {
  it("omits the JUnit reporter when the destination is unwritable", () => {
    const args = testArgs(false);
    assert.ok(!args.includes("--test-reporter=junit"));
    assert.ok(!args.some((a) => a.includes("junit.xml")));
  });

  it("appends the JUnit reporter when writable, keeping spec on stdout", () => {
    const args = testArgs(true);
    assert.ok(args.includes("--test-reporter=junit"));
    assert.ok(
      args.includes("--test-reporter-destination=test-results/junit.xml"),
    );
    // Both reporters run: losing spec output would blind the CI console.
    assert.ok(args.includes("--test-reporter=spec"));
    assert.ok(args.includes("--test-reporter-destination=stdout"));
  });

  it("always runs the unit suite, and only it", () => {
    for (const withJunit of [true, false]) {
      const args = testArgs(withJunit);
      assert.equal(args.at(-1), "dist/test/*.test.js");
      assert.ok(!args.some((a) => a.includes("integration")));
    }
  });
});
