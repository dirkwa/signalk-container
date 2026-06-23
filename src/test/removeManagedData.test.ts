import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
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

// Disk-backed scratch root (the repo's gitignored `.scratch/` — NOT /tmp,
// which is tmpfs/RAM on the maintainer's boxes). Each test gets a fresh subdir.
const SCRATCH_ROOT = path.join(
  process.cwd(),
  ".scratch",
  "remove-managed-data",
);

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

/** A wipe runner that must never be called (host-side delete should suffice). */
const failIfCalled = (): Promise<WipeJobOutcome> => {
  throw new Error("runWipeJob should not have been invoked");
};

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

  describe("EACCES fallback (rootless-Podman subuid)", () => {
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
          "sk-questdb": { inspect: { Config: { Image: "questdb/questdb:8" } } },
        },
      });

      await removeManagedData(runtime, "questdb", dataDir, runWipeJob, client);

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
          "sk-questdb": { inspect: { Config: { Image: "questdb/questdb:8" } } },
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
  });

  describe("wipe mount path", () => {
    it("exposes the helper mount path constant", () => {
      assert.equal(typeof WIPE_MOUNT_PATH, "string");
      assert.ok(WIPE_MOUNT_PATH.startsWith("/"));
    });
  });
});
