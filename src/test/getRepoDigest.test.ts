import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRepoDigest } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

interface FakeResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

function fakeExec(result: FakeResult) {
  return async () => ({
    stdout: result.stdout,
    stderr: result.stderr ?? "",
    exitCode: result.exitCode,
  });
}

const DIGEST = "sha256:" + "a".repeat(64);

describe("getRepoDigest", () => {
  it("returns the digest portion of a single RepoDigest entry", async () => {
    const result = await getRepoDigest(
      podman,
      "questdb/questdb:9.0.0",
      fakeExec({ stdout: `questdb/questdb@${DIGEST}\n`, exitCode: 0 }),
    );
    assert.equal(result, DIGEST);
  });

  it("returns null when stdout is empty (no RepoDigests)", async () => {
    const result = await getRepoDigest(
      podman,
      "local-build:dev",
      fakeExec({ stdout: "\n", exitCode: 0 }),
    );
    assert.equal(result, null);
  });

  it("returns null when exec exits non-zero", async () => {
    const result = await getRepoDigest(
      podman,
      "missing:tag",
      fakeExec({ stdout: "", exitCode: 1 }),
    );
    assert.equal(result, null);
  });

  it("returns null when output has no @ separator", async () => {
    const result = await getRepoDigest(
      podman,
      "weird:tag",
      fakeExec({ stdout: "no-at-sign-here\n", exitCode: 0 }),
    );
    assert.equal(result, null);
  });

  it("returns null when the digest format is invalid", async () => {
    const result = await getRepoDigest(
      podman,
      "weird:tag",
      fakeExec({ stdout: "repo@sha256:notenoughhex\n", exitCode: 0 }),
    );
    assert.equal(result, null);
  });
});
