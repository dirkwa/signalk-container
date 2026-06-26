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

const BASE = "alpine";
const BASE_TAG = "3.19";

// node's test runner runs integration files CONCURRENTLY, and several
// siblings (recreate, removeContainer, …) also run containers on the shared
// docker.io/library/alpine:3.18/3.19 images. If this test reaped those shared
// tags, (a) a sibling's container could hold one (in-use guard skips it →
// flake), and (b) force-removal would untag the shared source out from under
// the siblings. So we synthesize PRIVATE images with their own distinct IDs
// via `commit`, under a repo no other test references, and reap only those.
// `localhost/` repos pass through qualifyImage unchanged on podman and docker.
const REPO = "localhost/sk-reap-e2e";
const OLD_TAG = "old";
const NEW_TAG = "new";
const UNRELATED = "localhost/sk-reap-e2e-unrelated";
const UNRELATED_TAG = "keep";
const CONTAINER_NAME = "reap-e2e-test";
const BUILDER_NAME = "sk-reap-e2e-builder";

// dockerode's full Docker surface (commit/tag/remove on images) — wider than
// the narrow ContainerClient the plugin uses, but the real client is a full
// Docker instance, so a test may reach for it.
interface RawImage {
  remove(opts: object): Promise<unknown>;
}
interface RawContainer {
  commit(opts: {
    repo: string;
    tag: string;
    comment?: string;
    changes?: string;
  }): Promise<{ Id: string }>;
  remove(opts: object): Promise<unknown>;
}
interface RawClient {
  createContainer(opts: object): Promise<RawContainer>;
  getContainer(ref: string): RawContainer;
  getImage(ref: string): RawImage;
}

function raw(): RawClient {
  return getClient() as unknown as RawClient;
}

async function removeImageRef(repo: string, tag: string): Promise<void> {
  try {
    await raw()
      .getImage(`${repo}:${tag}`)
      .remove({ force: true, noprune: true });
  } catch {
    // best-effort — already gone
  }
}

/** Local image IDs tagged for exactly `<repo>:<tag>` on this runtime. */
async function localIdsFor(
  runtime: ContainerRuntimeInfo,
  repo: string,
  tag: string,
): Promise<string[]> {
  const wants = new Set(
    qualifiedRepoVariants(repo, runtime).map((variant) => `${variant}:${tag}`),
  );
  const images = await getClient().listImages();
  return images
    .filter((i) => (i.RepoTags ?? []).some((rt) => wants.has(rt)))
    .map((i) => i.Id);
}

describe("reapSupersededImages — real runtime", () => {
  let runtime: ContainerRuntimeInfo | null = null;

  // Synthesize the private old/new versions as distinct image IDs from a
  // single committed base container, so reaping them never touches a
  // shared image another concurrent test depends on.
  async function buildPrivateImages(): Promise<void> {
    // Idempotent: drop any existing private refs first. Re-committing a
    // live repo:tag moves the tag to a new image id and orphans the old
    // one as a dangling <none> image that teardown (which removes by
    // repo:tag) would never reclaim. Called from `before` and re-called
    // by the null-anchor test, so it must not leak across invocations.
    await removeImageRef(REPO, OLD_TAG);
    await removeImageRef(REPO, NEW_TAG);
    await removeImageRef(UNRELATED, UNRELATED_TAG);
    // A leaked builder from a crashed prior run would make createContainer
    // fail on the duplicate name; clear it first.
    try {
      await raw().getContainer(BUILDER_NAME).remove({ force: true });
    } catch {
      // not present
    }
    const base = qualifiedRepoVariants(BASE, runtime!).find(
      (v) => v.includes("library/") || !v.includes("/"),
    )!;
    const builder = await raw().createContainer({
      Image: `${base}:${BASE_TAG}`,
      Cmd: ["true"],
      name: BUILDER_NAME,
    });
    // Distinct `changes` per commit → distinct image IDs.
    await builder.commit({
      repo: REPO,
      tag: OLD_TAG,
      comment: "reaper-e2e old",
      changes: "LABEL sk-reap-e2e=old",
    });
    await builder.commit({
      repo: REPO,
      tag: NEW_TAG,
      comment: "reaper-e2e new",
      changes: "LABEL sk-reap-e2e=new",
    });
    await builder.commit({
      repo: UNRELATED,
      tag: UNRELATED_TAG,
      comment: "reaper-e2e unrelated",
      changes: "LABEL sk-reap-e2e=unrelated",
    });
    await builder.remove({ force: true }).catch(() => {});
  }

  before(async () => {
    runtime = await hasContainerRuntime();
    if (!runtime) return;
    // Avoid depending on host-UID idmap support (same rationale as the
    // recreate integration test) — we're testing reaping, not user-ns.
    setDisableUserns(true);
    await pullImage(runtime, `${BASE}:${BASE_TAG}`);
    await buildPrivateImages();
  });

  after(async () => {
    if (runtime) {
      try {
        await removeContainer(runtime, CONTAINER_NAME);
      } catch {
        // best-effort
      }
      try {
        // buildPrivateImages already removes the builder; this is a
        // belt-and-suspenders cleanup if a commit threw before that.
        await raw().getContainer(BUILDER_NAME).remove({ force: true });
      } catch {
        // builder container already removed
      }
      await removeImageRef(REPO, OLD_TAG);
      await removeImageRef(REPO, NEW_TAG);
      await removeImageRef(UNRELATED, UNRELATED_TAG);
    }
    setDisableUserns(false);
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

    // Sanity: both private versions and the unrelated image are present.
    const oldBefore = await localIdsFor(runtime, REPO, OLD_TAG);
    const newBefore = await localIdsFor(runtime, REPO, NEW_TAG);
    const unrelatedBefore = await localIdsFor(
      runtime,
      UNRELATED,
      UNRELATED_TAG,
    );
    assert.equal(oldBefore.length, 1, "old version should be present pre-reap");
    assert.equal(newBefore.length, 1, "new version should be present pre-reap");
    assert.equal(
      unrelatedBefore.length,
      1,
      "unrelated image should be present pre-reap",
    );

    // Only our private repo is managed; keep 0 prior versions.
    const managed: ManagedImageRef[] = [{ image: REPO, runningImageId }];
    const result = await reapSupersededImages(runtime, managed, 0);

    assert.equal(result.imagesRemoved, 1, "exactly one image reaped (old)");

    const oldAfter = await localIdsFor(runtime, REPO, OLD_TAG);
    const newAfter = await localIdsFor(runtime, REPO, NEW_TAG);
    const unrelatedAfter = await localIdsFor(runtime, UNRELATED, UNRELATED_TAG);

    assert.equal(oldAfter.length, 0, "old version must be removed");
    assert.equal(newAfter.length, 1, "new version (running) must survive");
    assert.deepEqual(
      newAfter,
      newBefore,
      "running image id unchanged after reap",
    );
    assert.equal(
      unrelatedAfter.length,
      1,
      "unrelated image must never be reaped",
    );
  });

  it("never reaps when the running image cannot be resolved (null anchor)", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }

    // Remove the prior test's container so it no longer holds `:new`, then
    // rebuild the private images (the prior test reaped `old`).
    // buildPrivateImages is idempotent and frees the refs before recommitting.
    try {
      await removeContainer(runtime, CONTAINER_NAME);
    } catch {
      // OK if absent.
    }
    await buildPrivateImages();
    const oldBefore = await localIdsFor(runtime, REPO, OLD_TAG);
    assert.equal(oldBefore.length, 1, "old version re-present");

    // runningImageId null -> unanchored repo -> reap nothing.
    const managed: ManagedImageRef[] = [{ image: REPO, runningImageId: null }];
    const result = await reapSupersededImages(runtime, managed, 0);

    assert.equal(result.imagesRemoved, 0, "no reap without a running anchor");
    const oldAfter = await localIdsFor(runtime, REPO, OLD_TAG);
    assert.equal(oldAfter.length, 1, "old version must survive");
  });

  it("qualifies a bare managed repo to a form that matches the local tags", async (t) => {
    if (!runtime) {
      t.skip("no container runtime available");
      return;
    }
    // The reaper qualifies a bare manifest repo to whatever spelling the
    // runtime stores locally before matching tags. Assert at least one
    // produced variant actually appears in a local image's RepoTags —
    // exercises the qualification against the real runtime's naming.
    const variants = qualifiedRepoVariants(BASE, runtime);
    const images = await getClient().listImages();
    const localRepos = new Set(
      images
        .flatMap((i) => i.RepoTags ?? [])
        .map((rt) => rt.slice(0, rt.lastIndexOf(":"))),
    );
    assert.ok(
      variants.some((v) => localRepos.has(v)),
      `one of ${JSON.stringify(variants)} should match a local repo tag`,
    );
  });
});
