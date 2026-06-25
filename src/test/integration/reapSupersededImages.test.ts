import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import {
  ensureRunning,
  removeContainer,
  getImageDigest,
  reapSupersededImages,
  pullImage,
  prefixedName,
  qualifiedRepoVariants,
} from "../../containers.js";
import { detectRuntime, setDisableUserns } from "../../runtime.js";
import { getClient } from "../../client.js";
import type { ContainerRuntimeInfo, ManagedImageRef } from "../../types.js";

async function hasContainerRuntime(): Promise<ContainerRuntimeInfo | null> {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}

// busybox `sleep` ignores SIGTERM; trap so stop is prompt.
const TRAP_AND_WAIT_CMD = ["sh", "-c", "trap exit TERM; sleep 60 & wait"];

const REPO = "docker.io/library/alpine";
const OLD_TAG = "3.18";
const NEW_TAG = "3.19";
// An image the test pulls but never manages — must survive reaping.
const UNRELATED = "docker.io/library/busybox";
const UNRELATED_TAG = "1.36";

const CONTAINER_NAME = "reap-e2e-test";

/** All local image IDs that carry any of the given `repo:tag` refs. */
async function localIdsFor(repoTag: string): Promise<string[]> {
  const images = await getClient().listImages();
  return images
    .filter((i) => (i.RepoTags ?? []).includes(repoTag))
    .map((i) => i.Id);
}

describe("reapSupersededImages — real runtime", () => {
  let runtime: ContainerRuntimeInfo | null = null;

  before(async () => {
    runtime = await hasContainerRuntime();
    if (!runtime) return;
    // Avoid depending on host-UID idmap support (same rationale as the
    // recreate integration test) — we're testing reaping, not user-ns.
    setDisableUserns(true);
    // Pull both alpine versions + an unrelated image so they exist locally.
    await pullImage(runtime, `${REPO}:${OLD_TAG}`);
    await pullImage(runtime, `${REPO}:${NEW_TAG}`);
    await pullImage(runtime, `${UNRELATED}:${UNRELATED_TAG}`);
  });

  after(async () => {
    setDisableUserns(false);
    if (!runtime) return;
    try {
      await removeContainer(runtime, CONTAINER_NAME);
    } catch {
      // best-effort
    }
  });

  it("removes the superseded version, keeps the running one and unrelated images", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    try {
      await removeContainer(runtime, CONTAINER_NAME);
    } catch {
      // OK if absent.
    }

    // Run a container on the NEW tag — this is the version that must survive.
    await ensureRunning(
      runtime,
      CONTAINER_NAME,
      {
        image: REPO,
        tag: NEW_TAG,
        command: TRAP_AND_WAIT_CMD,
        restart: "no",
      },
      () => {},
    );

    // The live container carries the `sk-` prefix, so resolve its image
    // id through the prefixed name — exactly what collectManagedImageRefs
    // does in index.ts.
    const runningImageId = await getImageDigest(
      runtime,
      prefixedName(CONTAINER_NAME),
    );
    assert.ok(runningImageId, "should resolve the running image id");

    // Sanity: both alpine versions and the unrelated image are present.
    const oldBefore = await localIdsFor(`${REPO}:${OLD_TAG}`);
    const newBefore = await localIdsFor(`${REPO}:${NEW_TAG}`);
    const unrelatedBefore = await localIdsFor(`${UNRELATED}:${UNRELATED_TAG}`);
    assert.equal(oldBefore.length, 1, "alpine:3.18 should be present pre-reap");
    assert.equal(newBefore.length, 1, "alpine:3.19 should be present pre-reap");
    assert.equal(
      unrelatedBefore.length,
      1,
      "busybox should be present pre-reap",
    );

    // Only alpine is managed; keep 0 prior versions.
    const managed: ManagedImageRef[] = [{ image: REPO, runningImageId }];
    const result = await reapSupersededImages(runtime, managed, 0);

    assert.equal(result.imagesRemoved, 1, "exactly one image reaped (3.18)");

    const oldAfter = await localIdsFor(`${REPO}:${OLD_TAG}`);
    const newAfter = await localIdsFor(`${REPO}:${NEW_TAG}`);
    const unrelatedAfter = await localIdsFor(`${UNRELATED}:${UNRELATED_TAG}`);

    assert.equal(oldAfter.length, 0, "alpine:3.18 must be removed");
    assert.equal(newAfter.length, 1, "alpine:3.19 (running) must survive");
    assert.deepEqual(
      newAfter,
      newBefore,
      "running image id unchanged after reap",
    );
    assert.equal(
      unrelatedAfter.length,
      1,
      "unrelated busybox must never be reaped",
    );
  });

  it("never reaps when the running image cannot be resolved (null anchor)", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    // Re-pull 3.18 so there is a superseded version to (not) reap.
    await pullImage(runtime, `${REPO}:${OLD_TAG}`);
    const oldBefore = await localIdsFor(`${REPO}:${OLD_TAG}`);
    assert.equal(oldBefore.length, 1, "alpine:3.18 re-present");

    // runningImageId null -> unanchored repo -> reap nothing.
    const managed: ManagedImageRef[] = [{ image: REPO, runningImageId: null }];
    const result = await reapSupersededImages(runtime, managed, 0);

    assert.equal(result.imagesRemoved, 0, "no reap without a running anchor");
    const oldAfter = await localIdsFor(`${REPO}:${OLD_TAG}`);
    assert.equal(oldAfter.length, 1, "alpine:3.18 must survive");
  });

  it("expands a bare managed repo to the docker.io/library form podman uses", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    // The reaper relies on qualifiedRepoVariants emitting the
    // `docker.io/library/<name>` spelling podman actually stores (verified
    // against this host's `listImages` output), so a manifest holding a
    // bare `alpine` still matches the local tags. This is the finding-1
    // case exercised against the real runtime's naming.
    assert.ok(
      qualifiedRepoVariants("alpine", runtime).includes(REPO),
      `variants should include ${REPO}`,
    );
  });
});
