import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { chmodSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _pickSocketForTesting } from "../client.js";

/**
 * `pickSocket` must NOT swallow a socket that exists but refuses the
 * connection on a permission ACL (EACCES). Returning `null` there makes the
 * doctor report the generic "no container runtime found"; the socket is plainly
 * present and the real fix is `group_add`. The fallback returns the refused
 * socket so the doctor's daemon probe re-hits the EACCES and reports
 * permission-denied.
 *
 * Linux-only and non-root-only: chmod 000 does not deny root, and Windows has
 * no unix-socket-permission semantics. Skips cleanly elsewhere so `npm test`
 * stays green in CI's Windows runner and in root sandboxes.
 */
const SKIP =
  process.platform !== "linux" ||
  (typeof process.getuid === "function" && process.getuid() === 0);

describe("pickSocket — existing-but-refused socket falls back to permission", () => {
  let dir: string;
  let deniedSock: string;
  let server: net.Server | null = null;

  before(() => {
    if (SKIP) return;
    dir = mkdtempSync(join(tmpdir(), "skc-picksock-"));
    deniedSock = join(dir, "denied.sock");
    server = net.createServer(() => {});
    return new Promise<void>((resolve) => {
      server!.listen(deniedSock, () => {
        chmodSync(deniedSock, 0o000);
        resolve();
      });
    });
  });

  after(() => {
    if (SKIP) return;
    server?.close();
    try {
      chmodSync(deniedSock, 0o600);
      unlinkSync(deniedSock);
    } catch {
      // socket already gone — nothing to clean up
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "returns the refused socket when no later candidate answers",
    { skip: SKIP },
    async () => {
      const absent = join(dir, "absent.sock"); // ENOENT — skipped, not remembered
      const picked = await _pickSocketForTesting([deniedSock, absent]);
      assert.equal(picked, deniedSock);
    },
  );

  it(
    "returns null when every candidate is absent (no socket to remember)",
    { skip: SKIP },
    async () => {
      // Absent sockets (ENOENT) are NOT remembered as a permission fallback,
      // so all-absent candidates fall through to null → no-runtime, distinct
      // from the existing-but-refused case above.
      const absentA = join(dir, "absentA.sock");
      const absentB = join(dir, "absentB.sock");
      const picked = await _pickSocketForTesting([absentA, absentB]);
      assert.equal(picked, null);
    },
  );
});
