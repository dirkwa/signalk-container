import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dockerHubTags, githubReleases } from "../updates/sources.js";
import type { ContainerRuntimeInfo } from "../types.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.0.0",
  isPodmanDockerShim: false,
};

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  return async (
    input: string | URL | globalThis.Request,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("githubReleases", () => {
  it("returns latest stable version, stripping leading v", async () => {
    const source = githubReleases("foo/bar", {
      fetchImpl: stubFetch(() =>
        jsonResponse([
          { tag_name: "v9.2.0", draft: false, prerelease: false },
          { tag_name: "v9.1.0", draft: false, prerelease: false },
        ]),
      ),
    });
    const result = await source.fetch(dummyRuntime);
    assert.deepEqual(result, { kind: "version", latest: "9.2.0" });
  });

  it("skips drafts", async () => {
    const source = githubReleases("foo/bar", {
      fetchImpl: stubFetch(() =>
        jsonResponse([
          { tag_name: "v10.0.0", draft: true, prerelease: false },
          { tag_name: "v9.2.0", draft: false, prerelease: false },
        ]),
      ),
    });
    const result = await source.fetch(dummyRuntime);
    assert.deepEqual(result, { kind: "version", latest: "9.2.0" });
  });

  it("skips prereleases by default", async () => {
    const source = githubReleases("foo/bar", {
      fetchImpl: stubFetch(() =>
        jsonResponse([
          { tag_name: "v10.0.0-rc1", draft: false, prerelease: true },
          { tag_name: "v9.2.0", draft: false, prerelease: false },
        ]),
      ),
    });
    const result = await source.fetch(dummyRuntime);
    assert.deepEqual(result, { kind: "version", latest: "9.2.0" });
  });

  it("includes prereleases when allowPrerelease is true", async () => {
    const source = githubReleases("foo/bar", {
      allowPrerelease: true,
      fetchImpl: stubFetch(() =>
        jsonResponse([
          { tag_name: "v10.0.0-rc1", draft: false, prerelease: true },
          { tag_name: "v9.2.0", draft: false, prerelease: false },
        ]),
      ),
    });
    const result = await source.fetch(dummyRuntime);
    assert.deepEqual(result, { kind: "version", latest: "10.0.0-rc1" });
  });

  it("strips a custom tagPrefix", async () => {
    const source = githubReleases("foo/bar", {
      tagPrefix: "release-",
      fetchImpl: stubFetch(() =>
        jsonResponse([
          {
            tag_name: "release-9.2.0",
            draft: false,
            prerelease: false,
          },
        ]),
      ),
    });
    const result = await source.fetch(dummyRuntime);
    assert.deepEqual(result, { kind: "version", latest: "9.2.0" });
  });

  it("returns error kind for HTTP 502", async () => {
    const source = githubReleases("foo/bar", {
      fetchImpl: stubFetch(() => new Response("bad gateway", { status: 502 })),
    });
    const result = await source.fetch(dummyRuntime);
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.match(result.error, /502/);
    }
  });

  it("returns error kind when no matching release", async () => {
    const source = githubReleases("foo/bar", {
      fetchImpl: stubFetch(() => jsonResponse([])),
    });
    const result = await source.fetch(dummyRuntime);
    assert.equal(result.kind, "error");
  });

  it("returns error kind when response is not an array", async () => {
    const source = githubReleases("foo/bar", {
      fetchImpl: stubFetch(() => jsonResponse({ message: "not found" })),
    });
    const result = await source.fetch(dummyRuntime);
    assert.equal(result.kind, "error");
  });

  it("propagates fetch network errors (caller handles via isOfflineError)", async () => {
    const source = githubReleases("foo/bar", {
      fetchImpl: async () => {
        const err = new Error("fetch failed") as Error & {
          cause?: NodeJS.ErrnoException;
        };
        const cause = new Error("ENETUNREACH") as NodeJS.ErrnoException;
        cause.code = "ENETUNREACH";
        err.cause = cause;
        throw err;
      },
    });
    await assert.rejects(() => source.fetch(dummyRuntime), /fetch failed/);
  });
});

describe("dockerHubTags", () => {
  it("returns first matching version tag, stripping v", async () => {
    const source = dockerHubTags("library/redis", {
      fetchImpl: stubFetch(() =>
        jsonResponse({
          results: [{ name: "latest" }, { name: "v7.4.0" }, { name: "7.2.0" }],
        }),
      ),
    });
    const result = await source.fetch(dummyRuntime);
    assert.deepEqual(result, { kind: "version", latest: "7.4.0" });
  });

  it("prefixes library/ for unqualified images", async () => {
    let capturedUrl = "";
    const source = dockerHubTags("redis", {
      fetchImpl: stubFetch((url) => {
        capturedUrl = url;
        return jsonResponse({ results: [{ name: "7.0.0" }] });
      }),
    });
    await source.fetch(dummyRuntime);
    assert.match(capturedUrl, /library\/redis/);
  });

  it("does not prefix library/ for user images", async () => {
    let capturedUrl = "";
    const source = dockerHubTags("questdb/questdb", {
      fetchImpl: stubFetch((url) => {
        capturedUrl = url;
        return jsonResponse({ results: [{ name: "9.2.0" }] });
      }),
    });
    await source.fetch(dummyRuntime);
    assert.doesNotMatch(capturedUrl, /library\//);
    assert.match(capturedUrl, /questdb\/questdb/);
  });
});
