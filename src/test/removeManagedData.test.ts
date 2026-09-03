import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  removeManagedData,
  WIPE_MOUNT_PATH,
  type WipeJobOutcome,
} from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const runtime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

/**
 * Disk-backed scratch root (the repo's gitignored `.scratch/` — NOT /tmp,
 * which is tmpfs/RAM on the maintainer's boxes). Each test gets a fresh subdir.
 *
 * Falls back to the system temp dir when the repo is not writable. The plugin
 * registry clones into /home and runs the suite under firejail
 * `--read-only=/home`, where every one of these tests would otherwise fail on
 * `mkdir` and be scored as a real failure. Preferring real disk is a
 * performance choice, so trading it for a run that works is the right way
 * round.
 */
function resolveScratchRoot(): string {
  const preferred = path.join(process.cwd(), ".scratch", "remove-managed-data");
  try {
    mkdirSync(preferred, { recursive: true });
    // `mkdirSync` on an existing directory succeeds even where the filesystem
    // is read-only, and `.scratch/` survives earlier local runs — so probe by
    // creating something, which is what every test then does.
    const probe = path.join(preferred, ".writable-probe");
    mkdirSync(probe, { recursive: true });
    rmSync(probe, { recursive: true, force: true });
    return preferred;
  } catch {
    return mkdtempSync(path.join(tmpdir(), "skc-remove-managed-data-"));
  }
}

const SCRATCH_ROOT = resolveScratchRoot();
/** True when the repo was unwritable and a temp dir stood in for it. */
const SCRATCH_IS_TEMPORARY = !SCRATCH_ROOT.startsWith(process.cwd());

let scratch: string;
let counter = 0;

beforeEach(() => {
  counter += 1;
  scratch = path.join(SCRATCH_ROOT, `t${counter}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  // Restore any modes the EACCES tests narrowed so cleanup can descend.
  try {
    chmodSync(scratch, 0o755);
  } catch {
    // already gone / never narrowed
  }
  rmSync(scratch, { recursive: true, force: true });
});

after(() => {
  // The repo-local `.scratch/` is gitignored and deliberately kept between
  // runs; a temp-dir stand-in has no such role, so it is not left behind.
  if (SCRATCH_IS_TEMPORARY) {
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  }
});

/** A wipe runner that must never be called (host-side delete should suffice). */
const failIfCalled = (): Promise<WipeJobOutcome> => {
  throw new Error("runWipeJob should not have been invoked");
};

/**
 * `chmod 0o555` denies only an unprivileged user, so the EACCES these tests
 * depend on cannot be produced as root or on Windows.
 */
const SKIP_EACCES =
  process.platform === "win32" ||
  (typeof process.getuid === "function" && process.getuid() === 0);

describe("removeManagedData", () => {
  describe("path safety", () => {
    it("refuses an empty path", async () => {
      const client = makeMockClient({});
      await assert.rejects(
        removeManagedData(runtime, "x", "", failIfCalled, client),
        /refusing to delete unsafe path/,
      );
    });

    it("refuses the filesystem root", async () => {
      const client = makeMockClient({});
      await assert.rejects(
        removeManagedData(runtime, "x", "/", failIfCalled, client),
        /refusing to delete unsafe path/,
      );
    });

    it("refuses whitespace-only path", async () => {
      const client = makeMockClient({});
      await assert.rejects(
        removeManagedData(runtime, "x", "   ", failIfCalled, client),
        /refusing to delete unsafe path/,
      );
    });

    it("refuses a relative path (would resolve against cwd)", async () => {
      const client = makeMockClient({});
      await assert.rejects(
        removeManagedData(runtime, "x", "../data", failIfCalled, client),
        /refusing to delete unsafe path/,
      );
      await assert.rejects(
        removeManagedData(runtime, "x", "foo", failIfCalled, client),
        /refusing to delete unsafe path/,
      );
    });
  });

  describe("container removal", () => {
    it("removes the container before deleting data", async () => {
      const dataDir = path.join(scratch, "data");
      mkdirSync(dataDir);
      writeFileSync(path.join(dataDir, "f"), "x");

      const calls = new Map<string, unknown[]>();
      const client = makeMockClient({
        calls,
        containers: {
          "sk-questdb": { inspect: { Config: { Image: "questdb/questdb" } } },
        },
      });

      await removeManagedData(
        runtime,
        "questdb",
        dataDir,
        failIfCalled,
        client,
      );

      // stop + remove went to the prefixed container name.
      const removed = calls.get("remove") ?? [];
      assert.ok(
        removed.some((r) => (r as { id?: string }).id === "sk-questdb"),
        "expected sk-questdb to be removed",
      );
      assert.equal(existsSync(dataDir), false);
    });

    it("is idempotent when the container is already missing", async () => {
      const dataDir = path.join(scratch, "data");
      mkdirSync(dataDir);
      // No `containers` entry → inspect 404s and remove tolerates not-found.
      const client = makeMockClient({});
      await removeManagedData(runtime, "ghost", dataDir, failIfCalled, client);
      assert.equal(existsSync(dataDir), false);
    });

    it("fires onRemoved AFTER the container is removed", async () => {
      const dataDir = path.join(scratch, "data");
      mkdirSync(dataDir);
      const events: string[] = [];
      const calls = new Map<string, unknown[]>();
      const client = makeMockClient({
        calls,
        containers: {
          "sk-questdb": { inspect: { Config: { Image: "questdb/questdb" } } },
        },
      });
      await removeManagedData(
        runtime,
        "questdb",
        dataDir,
        failIfCalled,
        client,
        () => events.push("onRemoved"),
      );
      // The mock records each remove() in `calls`; assert remove happened and
      // onRemoved fired after it (not before, not without removal).
      assert.ok(
        (calls.get("remove") ?? []).some(
          (r) => (r as { id?: string }).id === "sk-questdb",
        ),
        "expected sk-questdb to be removed",
      );
      assert.deepEqual(events, ["onRemoved"]);
    });

    it("does NOT fire onRemoved or reach remove() when a pre-removal inspect error rethrows", async () => {
      const dataDir = path.join(scratch, "data");
      mkdirSync(dataDir);
      // A non-404 inspect error rethrows through safeInspect before the
      // container is removed — the container is still running, so neither
      // remove() nor the teardown callback must run.
      const calls = new Map<string, unknown[]>();
      const client = makeMockClient({
        calls,
        containers: {
          "sk-questdb": { inspect: new Error("daemon connection reset") },
        },
      });
      let removedCalled = false;
      await assert.rejects(
        removeManagedData(
          runtime,
          "questdb",
          dataDir,
          failIfCalled,
          client,
          () => {
            removedCalled = true;
          },
        ),
      );
      assert.equal(removedCalled, false);
      assert.equal(calls.get("remove"), undefined, "remove() must not run");
      // Data dir untouched — nothing was removed.
      assert.equal(existsSync(dataDir), true);
    });
  });

  describe("host-side delete path (docker / rootful)", () => {
    it("deletes host-owned data directly without the wipe job", async () => {
      const dataDir = path.join(scratch, "data");
      mkdirSync(dataDir);
      writeFileSync(path.join(dataDir, "a"), "1");
      mkdirSync(path.join(dataDir, "sub"));
      writeFileSync(path.join(dataDir, "sub", "b"), "2");

      const client = makeMockClient({
        containers: {
          "sk-app": { inspect: { Config: { Image: "library/app:1" } } },
        },
      });

      await removeManagedData(runtime, "app", dataDir, failIfCalled, client);
      assert.equal(existsSync(dataDir), false);
    });
  });

  // These tests force EACCES via a read-only parent dir (`chmod 0o555`), which
  // only denies an unprivileged user: root ignores directory permission bits,
  // so fs.rm succeeds and the fallback never triggers. Windows has no such
  // semantics either. The rootless-Podman subuid scenario they cover is
  // Linux-and-unprivileged by nature, so skip where the condition cannot be
  // created — including root sandboxes such as the plugin registry's harness,
  // where an unskipped run reports these as genuine failures. Same guard as
  // `pickSocketPermission.test.ts`, for the same reason.
  describe(
    "EACCES fallback (rootless-Podman subuid)",
    { skip: SKIP_EACCES },
    () => {
      it("invokes the wipe job, then drops the now-empty parent", async () => {
        // A read-only parent forces fs.rm of the child to throw EACCES,
        // standing in for the subuid-ownership case (host user can't delete).
        const dataDir = path.join(scratch, "data");
        mkdirSync(dataDir);
        writeFileSync(path.join(dataDir, "subuid-owned"), "x");
        chmodSync(scratch, 0o555);

        let wipeArgs: { image: string; dir: string } | undefined;
        const runWipeJob = async (
          image: string,
          dir: string,
        ): Promise<WipeJobOutcome> => {
          wipeArgs = { image, dir };
          // Simulate the in-userns wipe: it can delete the subuid-owned files
          // and (re)gain write on the parent so the host-side retry succeeds.
          chmodSync(scratch, 0o755);
          rmSync(path.join(dataDir, "subuid-owned"), { force: true });
          return { ok: true };
        };

        const client = makeMockClient({
          containers: {
            "sk-questdb": {
              inspect: { Config: { Image: "questdb/questdb:8" } },
            },
          },
        });

        await removeManagedData(
          runtime,
          "questdb",
          dataDir,
          runWipeJob,
          client,
        );

        assert.deepEqual(wipeArgs, {
          image: "questdb/questdb:8",
          dir: dataDir,
        });
        assert.equal(existsSync(dataDir), false);
      });

      it("throws a descriptive error when the wipe job fails", async () => {
        const dataDir = path.join(scratch, "data");
        mkdirSync(dataDir);
        writeFileSync(path.join(dataDir, "f"), "x");
        chmodSync(scratch, 0o555);

        const runWipeJob = async (): Promise<WipeJobOutcome> => ({
          ok: false,
          error: "Container exited with code 1",
        });

        const client = makeMockClient({
          containers: {
            "sk-questdb": {
              inspect: { Config: { Image: "questdb/questdb:8" } },
            },
          },
        });

        await assert.rejects(
          removeManagedData(runtime, "questdb", dataDir, runWipeJob, client),
          /in-userns wipe of .* failed: Container exited with code 1/,
        );
      });

      it("throws when fallback is needed but the image is unknown", async () => {
        const dataDir = path.join(scratch, "data");
        mkdirSync(dataDir);
        writeFileSync(path.join(dataDir, "f"), "x");
        chmodSync(scratch, 0o555);

        // No `containers` entry → inspect 404s → no image captured.
        const client = makeMockClient({});

        await assert.rejects(
          removeManagedData(runtime, "ghost", dataDir, failIfCalled, client),
          /container's image is unknown/,
        );
      });
    },
  );

  describe("wipe mount path", () => {
    it("exposes the helper mount path constant", () => {
      assert.equal(typeof WIPE_MOUNT_PATH, "string");
      assert.ok(WIPE_MOUNT_PATH.startsWith("/"));
    });
  });
});
