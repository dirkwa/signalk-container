import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { imageRunsAsUser } from "../doctor.js";
import { _setCurrentHostIdsForTesting } from "../runtime.js";
import type { ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
  isRootless: false,
};

const podmanRootless: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
};

// Pin host UID/GID so the user-mapping flags the probe emits are
// deterministic across CI (often UID 0) and a dev machine (often
// 1000) — the *flags* are what we're asserting on, not the host's
// actual identity.
before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

interface CapturedCall {
  args: string[];
}

function makeExec(
  result: { stdout: string; stderr?: string; exitCode: number },
  capture?: CapturedCall[],
) {
  return async (_runtime: ContainerRuntimeInfo, args: string[]) => {
    capture?.push({ args: [...args] });
    return {
      stdout: result.stdout,
      stderr: result.stderr ?? "",
      exitCode: result.exitCode,
    };
  };
}

describe("imageRunsAsUser", () => {
  it("returns ok=true when the probe exits 0 and prints 'ok'", async () => {
    const result = await imageRunsAsUser(
      docker,
      "questdb/questdb:9.0.0",
      undefined,
      makeExec({ stdout: "ok", exitCode: 0 }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.output, "ok");
    assert.equal(result.error, undefined);
  });

  it("returns ok=false when the probe exits non-zero", async () => {
    const result = await imageRunsAsUser(
      docker,
      "broken/image:1.0",
      undefined,
      makeExec({
        stdout: "",
        stderr: "touch: cannot create '/tmp/x': Permission denied",
        exitCode: 1,
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /exited with code 1/);
    assert.match(result.output, /Permission denied/);
  });

  it("returns ok=false when exit=0 but stdout does not contain 'ok' (touch silently failed via &&)", async () => {
    const result = await imageRunsAsUser(
      docker,
      "weird/image:1.0",
      undefined,
      makeExec({ stdout: "", exitCode: 0 }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /did not print 'ok'/);
  });

  it("returns ok=false (never throws) when the exec layer throws", async () => {
    const failingExec = async () => {
      throw new Error("podman: command not found");
    };
    const result = await imageRunsAsUser(
      docker,
      "any/image",
      undefined,
      failingExec,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /command not found/);
  });

  it("emits --user host:host under docker by default", async () => {
    const calls: CapturedCall[] = [];
    await imageRunsAsUser(
      docker,
      "questdb/questdb:9.0.0",
      undefined,
      makeExec({ stdout: "ok", exitCode: 0 }, calls),
    );
    assert.equal(calls.length, 1);
    const args = calls[0].args;
    const userIdx = args.indexOf("--user");
    assert.ok(userIdx >= 0, `--user missing: ${args.join(" ")}`);
    assert.equal(args[userIdx + 1], "1000:1000");
  });

  it("emits --userns=keep-id (no --user) under rootless podman", async () => {
    const calls: CapturedCall[] = [];
    await imageRunsAsUser(
      podmanRootless,
      "questdb/questdb:9.0.0",
      undefined,
      makeExec({ stdout: "ok", exitCode: 0 }, calls),
    );
    const args = calls[0].args;
    const usernsIdx = args.indexOf("--userns");
    assert.ok(usernsIdx >= 0, `--userns missing: ${args.join(" ")}`);
    assert.match(args[usernsIdx + 1], /^keep-id:uid=0,gid=0$/);
    // Rootless podman branch emits keep-id but NOT --user.
    assert.ok(
      !args.includes("--user"),
      `--user should not appear under rootless podman: ${args.join(" ")}`,
    );
  });

  it("emits no user flags when user is false (opt out)", async () => {
    const calls: CapturedCall[] = [];
    await imageRunsAsUser(
      docker,
      "questdb/questdb:9.0.0",
      false,
      makeExec({ stdout: "ok", exitCode: 0 }, calls),
    );
    const args = calls[0].args;
    assert.ok(!args.includes("--user"));
    assert.ok(!args.includes("--userns"));
  });

  it("runs the probe via `run --rm <image> sh -c 'touch /tmp/x && echo ok'`", async () => {
    const calls: CapturedCall[] = [];
    await imageRunsAsUser(
      docker,
      "questdb/questdb:9.0.0",
      undefined,
      makeExec({ stdout: "ok", exitCode: 0 }, calls),
    );
    const args = calls[0].args;
    // Headline: it's a `run --rm` invocation that ends in the probe shell.
    assert.equal(args[0], "run");
    assert.ok(args.includes("--rm"));
    assert.ok(args.includes("sh"));
    assert.ok(args.includes("-c"));
    const cmdIdx = args.indexOf("-c");
    assert.equal(args[cmdIdx + 1], "touch /tmp/x && echo ok");
  });

  it("qualifies the image for podman (docker.io/ prefix when bare)", async () => {
    const calls: CapturedCall[] = [];
    await imageRunsAsUser(
      podmanRootless,
      "questdb/questdb:9.0.0",
      undefined,
      makeExec({ stdout: "ok", exitCode: 0 }, calls),
    );
    const args = calls[0].args;
    assert.ok(
      args.includes("docker.io/questdb/questdb:9.0.0"),
      `expected qualifyImage to prefix docker.io/, got: ${args.join(" ")}`,
    );
  });
});
