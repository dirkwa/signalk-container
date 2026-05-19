import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DIGEST_RE,
  resolveImage,
  type ResolveDeps,
} from "../manifest/resolver.js";
import type { ContainerRuntimeInfo } from "../types.js";

const runtime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const DIGEST = "sha256:" + "a".repeat(64);
const OTHER_DIGEST = "sha256:" + "b".repeat(64);

interface SpyCalls {
  imageExists: string[];
  pullImage: string[];
  getRepoDigest: string[];
  getImageDigest: string[];
}

function makeDeps(opts: {
  imageExists?: (image: string) => boolean;
  repoDigest?: (image: string) => string | null;
  imageDigestFallback?: (image: string) => string | null;
}): { deps: ResolveDeps; calls: SpyCalls } {
  const calls: SpyCalls = {
    imageExists: [],
    pullImage: [],
    getRepoDigest: [],
    getImageDigest: [],
  };
  const deps: ResolveDeps = {
    qualifyImage(image) {
      // Test stub: prefix two-segment refs like `repo/name[:tag]` with
      // `docker.io/`. Real `qualifyImage` is richer; the tests only
      // exercise the namespaced case. `localhost/foo` is left alone
      // because podman doesn't prefix host-local refs.
      if (image.includes("/") && !image.startsWith("localhost"))
        return `docker.io/${image}`;
      return image;
    },
    async imageExists(_runtime, image) {
      calls.imageExists.push(image);
      return opts.imageExists ? opts.imageExists(image) : false;
    },
    async pullImage(_runtime, image) {
      calls.pullImage.push(image);
    },
    async getRepoDigest(_runtime, image) {
      calls.getRepoDigest.push(image);
      return opts.repoDigest ? opts.repoDigest(image) : null;
    },
    async getImageDigest(_runtime, image) {
      calls.getImageDigest.push(image);
      return opts.imageDigestFallback ? opts.imageDigestFallback(image) : null;
    },
  };
  return { deps, calls };
}

describe("resolveImage — tag-only path", () => {
  it("pulls and resolves to RepoDigest when image is absent", async () => {
    const { deps, calls } = makeDeps({
      imageExists: () => false,
      repoDigest: () => DIGEST,
    });
    const r = await resolveImage(
      runtime,
      { image: "questdb/questdb", tag: "9.0.0" },
      deps,
    );
    assert.equal(r.source, "resolved-from-tag");
    assert.equal(r.resolvedDigest, DIGEST);
    assert.equal(r.pullSpec, "docker.io/questdb/questdb:9.0.0");
    assert.deepEqual(calls.imageExists, ["docker.io/questdb/questdb:9.0.0"]);
    assert.deepEqual(calls.pullImage, ["docker.io/questdb/questdb:9.0.0"]);
    assert.deepEqual(calls.getRepoDigest, ["docker.io/questdb/questdb:9.0.0"]);
    assert.deepEqual(calls.getImageDigest, []);
  });

  it("skips pull when image is already present locally", async () => {
    const { deps, calls } = makeDeps({
      imageExists: () => true,
      repoDigest: () => DIGEST,
    });
    const r = await resolveImage(
      runtime,
      { image: "questdb/questdb", tag: "9.0.0" },
      deps,
    );
    assert.equal(r.resolvedDigest, DIGEST);
    assert.deepEqual(calls.pullImage, []);
    assert.deepEqual(calls.getRepoDigest, ["docker.io/questdb/questdb:9.0.0"]);
  });

  it("falls back to local:<image-id> when getRepoDigest returns null", async () => {
    const { deps } = makeDeps({
      imageExists: () => true,
      repoDigest: () => null,
      imageDigestFallback: () => "sha256:" + "f".repeat(64),
    });
    const r = await resolveImage(
      runtime,
      { image: "my-local-build", tag: "dev" },
      deps,
    );
    assert.equal(r.source, "resolved-from-tag");
    assert.equal(r.resolvedDigest, `local:sha256:${"f".repeat(64)}`);
  });

  it("falls back to local:unknown when both digests are unavailable", async () => {
    const { deps } = makeDeps({
      imageExists: () => true,
      repoDigest: () => null,
      imageDigestFallback: () => null,
    });
    const r = await resolveImage(runtime, { image: "ghost", tag: "tag" }, deps);
    assert.equal(r.resolvedDigest, "local:unknown");
  });
});

describe("resolveImage — digest-set path", () => {
  it("pulls image@digest when absent and returns declared", async () => {
    const { deps, calls } = makeDeps({ imageExists: () => false });
    const r = await resolveImage(
      runtime,
      { image: "questdb/questdb", tag: "9.0.0", digest: DIGEST },
      deps,
    );
    assert.equal(r.source, "declared");
    assert.equal(r.resolvedDigest, DIGEST);
    assert.equal(r.pullSpec, `docker.io/questdb/questdb@${DIGEST}`);
    assert.deepEqual(calls.imageExists, [
      `docker.io/questdb/questdb@${DIGEST}`,
    ]);
    assert.deepEqual(calls.pullImage, [`docker.io/questdb/questdb@${DIGEST}`]);
    assert.deepEqual(calls.getRepoDigest, []);
  });

  it("skips pull and getRepoDigest when image is present locally", async () => {
    const { deps, calls } = makeDeps({ imageExists: () => true });
    const r = await resolveImage(
      runtime,
      { image: "questdb/questdb", tag: "9.0.0", digest: OTHER_DIGEST },
      deps,
    );
    assert.equal(r.resolvedDigest, OTHER_DIGEST);
    assert.deepEqual(calls.pullImage, []);
    assert.deepEqual(calls.getRepoDigest, []);
  });
});

describe("resolveImage — invalid digest format throws synchronously", () => {
  const cases = [
    "sha256:abc",
    "sha512:" + "a".repeat(64),
    "a".repeat(64),
    "sha256:" + "g".repeat(64), // non-hex
    "sha256:" + "a".repeat(63), // one short
    "sha256:" + "a".repeat(65), // one long
    "",
  ];
  for (const bad of cases) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const { deps } = makeDeps({});
      await assert.rejects(
        () =>
          resolveImage(
            runtime,
            { image: "questdb/questdb", tag: "9.0.0", digest: bad },
            deps,
          ),
        /Invalid digest/,
      );
    });
  }
});

describe("DIGEST_RE", () => {
  it("matches a canonical sha256 digest", () => {
    assert.ok(DIGEST_RE.test(DIGEST));
  });
  it("rejects uppercase hex", () => {
    assert.ok(!DIGEST_RE.test("sha256:" + "A".repeat(64)));
  });
});
