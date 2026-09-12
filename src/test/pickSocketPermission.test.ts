import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

  // The boot-race shape on a rootless host: the preferred
  // `/run/user/<uid>/podman/podman.sock` is socket-activated and not there
  // yet, while the rootful `/run/podman/podman.sock` sits behind a
  // `0700 root:root` directory and denies us. Returning the denial would pin
  // the plugin — via `resolveClient`'s cache — to a socket it can never use,
  // and the operator would have to restart Signal K by hand once the user
  // socket appeared.
  it(
    "prefers null over a denial that a not-yet-present socket outranks",
    { skip: SKIP },
    async () => {
      const absent = join(dir, "notyet.sock");
      const picked = await _pickSocketForTesting([absent, deniedSock]);
      assert.equal(picked, null);
    },
  );

  // Only genuine absence outranks a denial. Every other way a higher-priority
  // candidate can fail leaves the denial the most useful thing we know: its
  // remediation is actionable, whereas suppressing it would report no-runtime
  // and leave the caller re-probing a host whose real fix is an ACL change.
  it(
    "still returns the denial when a higher-priority path is not a socket",
    { skip: SKIP },
    async () => {
      const plainFile = join(dir, "stale.sock");
      writeFileSync(plainFile, "");
      const picked = await _pickSocketForTesting([plainFile, deniedSock]);
      assert.equal(picked, deniedSock);
    },
  );
});
