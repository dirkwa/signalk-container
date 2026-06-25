import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectImagesToReap } from "../containers.js";
import type { LocalImageSummary, ManagedImageRef } from "../types.js";

const REPO = "ghcr.io/dirkwa/signalk-backup-server";

/** Build a managed-repo image summary with one semver tag. */
function img(
  id: string,
  tag: string,
  opts: { created?: number; inUseCount?: number; repo?: string } = {},
): LocalImageSummary {
  return {
    id,
    repoTags: [`${opts.repo ?? REPO}:${tag}`],
    created: opts.created ?? 0,
    size: 100,
    inUseCount: opts.inUseCount ?? 0,
  };
}

function managed(runningImageId: string | null, repo = REPO): ManagedImageRef {
  return { image: repo, runningImageId };
}

function reaped(
  images: LocalImageSummary[],
  refs: ManagedImageRef[],
  keep: number,
): string[] {
  return selectImagesToReap(images, refs, keep).sort();
}

describe("selectImagesToReap", () => {
  it("keeps running + N prior, reaps the rest (keep=1)", () => {
    const images = [
      img("id-0.6.5", "0.6.5"),
      img("id-0.6.6", "0.6.6"),
      img("id-0.6.7", "0.6.7"),
    ];
    // running is 0.6.7; keep 1 prior -> keep 0.6.6, reap 0.6.5
    assert.deepEqual(reaped(images, [managed("id-0.6.7")], 1), ["id-0.6.5"]);
  });

  it("keep=0 reaps all superseded but never the running image", () => {
    const images = [
      img("id-0.6.5", "0.6.5"),
      img("id-0.6.6", "0.6.6"),
      img("id-0.6.7", "0.6.7"),
    ];
    assert.deepEqual(reaped(images, [managed("id-0.6.7")], 0), [
      "id-0.6.5",
      "id-0.6.6",
    ]);
  });

  it("keep large enough to retain everything reaps nothing", () => {
    const images = [
      img("id-0.6.5", "0.6.5"),
      img("id-0.6.6", "0.6.6"),
      img("id-0.6.7", "0.6.7"),
    ];
    assert.deepEqual(reaped(images, [managed("id-0.6.7")], 2), []);
  });

  it("when the running image is absent from the list, keep counts the newest superseded", () => {
    const images = [
      img("id-0.6.5", "0.6.5"),
      img("id-0.6.6", "0.6.6"),
      img("id-0.6.7", "0.6.7"),
    ];
    // running id not present -> all three are reapable; keep 1 newest (0.6.7),
    // reap the two older.
    assert.deepEqual(reaped(images, [managed("id-absent")], 1), [
      "id-0.6.5",
      "id-0.6.6",
    ]);
  });

  it("never reaps unrelated images (repo not managed)", () => {
    const images = [
      img("q-9.0.0", "9.0.0", { repo: "docker.io/questdb/questdb" }),
      img("q-9.0.1", "9.0.1", { repo: "docker.io/questdb/questdb" }),
    ];
    // questdb is not in the managed set
    assert.deepEqual(reaped(images, [managed("id-0.6.7")], 0), []);
  });

  it("reaps only the managed repo when unrelated images are mixed in", () => {
    const images = [
      img("id-0.6.5", "0.6.5"),
      img("id-0.6.6", "0.6.6"),
      img("q-9.0.0", "9.0.0", { repo: "docker.io/questdb/questdb" }),
    ];
    // managed running 0.6.6, keep 0 -> reap 0.6.5; questdb untouched
    assert.deepEqual(reaped(images, [managed("id-0.6.6")], 0), ["id-0.6.5"]);
  });

  it("never reaps an image in use by a (stopped) container", () => {
    const images = [
      img("id-0.6.5", "0.6.5", { inUseCount: 1 }),
      img("id-0.6.6", "0.6.6"),
    ];
    // 0.6.5 is referenced by a stopped container; keep 0, running 0.6.6
    assert.deepEqual(reaped(images, [managed("id-0.6.6")], 0), []);
  });

  it("ignores images with no repo tags (local builds)", () => {
    const images: LocalImageSummary[] = [
      { id: "local", repoTags: [], created: 5, size: 1, inUseCount: 0 },
      img("id-0.6.5", "0.6.5"),
    ];
    assert.deepEqual(reaped(images, [managed("id-0.6.6")], 0), ["id-0.6.5"]);
  });

  it("de-dupes an image that carries two tags of the same repo", () => {
    const images: LocalImageSummary[] = [
      {
        id: "id-dual",
        repoTags: [`${REPO}:0.6.6`, `${REPO}:latest`],
        created: 10,
        size: 100,
        inUseCount: 0,
      },
      img("id-0.6.5", "0.6.5", { created: 5 }),
    ];
    // running 0.6.7 (absent), keep 1 -> keep newest (dual 0.6.6/latest),
    // reap 0.6.5. The dual-tagged image is counted once.
    assert.deepEqual(reaped(images, [managed("id-0.6.7")], 1), ["id-0.6.5"]);
  });

  it("orders floating-only tags by created time", () => {
    const images: LocalImageSummary[] = [
      {
        id: "old",
        repoTags: [`${REPO}:latest`],
        created: 1,
        size: 1,
        inUseCount: 0,
      },
      {
        id: "mid",
        repoTags: [`${REPO}:latest`],
        created: 2,
        size: 1,
        inUseCount: 0,
      },
      {
        id: "new",
        repoTags: [`${REPO}:latest`],
        created: 3,
        size: 1,
        inUseCount: 0,
      },
    ];
    // running = newest "new"; keep 1 prior -> keep "mid", reap "old"
    assert.deepEqual(reaped(images, [managed("new")], 1), ["old"]);
  });

  it("orders semver ahead of a stray latest blob in the same repo", () => {
    const images: LocalImageSummary[] = [
      img("id-0.6.6", "0.6.6", { created: 5 }),
      img("id-0.6.5", "0.6.5", { created: 4 }),
      {
        id: "id-latest",
        repoTags: [`${REPO}:latest`],
        created: 100, // newest by time, but non-semver sorts last
        size: 1,
        inUseCount: 0,
      },
    ];
    // running 0.6.7 (absent); ordering newest-first: 0.6.6, 0.6.5, latest.
    // keep 1 -> keep 0.6.6, reap 0.6.5 and latest.
    assert.deepEqual(reaped(images, [managed("id-0.6.7")], 1), [
      "id-0.6.5",
      "id-latest",
    ]);
  });

  it("excludes the running image even at keep=0 when it is also a candidate", () => {
    const images = [img("id-0.6.7", "0.6.7")];
    assert.deepEqual(reaped(images, [managed("id-0.6.7")], 0), []);
  });

  it("keeps every version of a repo whose running image-ID is unknown (null)", () => {
    const images = [
      img("id-0.6.5", "0.6.5"),
      img("id-0.6.6", "0.6.6"),
      img("id-0.6.7", "0.6.7"),
    ];
    // null running-id -> no anchor -> reap nothing for this repo, even at keep=0
    assert.deepEqual(reaped(images, [managed(null)], 0), []);
  });

  it("returns nothing when there are no managed refs", () => {
    const images = [img("id-0.6.5", "0.6.5"), img("id-0.6.6", "0.6.6")];
    assert.deepEqual(reaped(images, [], 0), []);
  });

  it("clamps a negative keep to 0", () => {
    const images = [img("id-0.6.5", "0.6.5"), img("id-0.6.6", "0.6.6")];
    assert.deepEqual(reaped(images, [managed("id-0.6.6")], -3), ["id-0.6.5"]);
  });
});
