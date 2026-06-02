import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { getImageHealthcheck, ensureRunning } from "../containers.js";
import { _setCurrentHostIdsForTesting, type ExecResult } from "../runtime.js";
import type { ContainerConfig, ContainerRuntimeInfo } from "../types.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

// Deterministic user-mapping flags regardless of who runs the suite.
before(() => _setCurrentHostIdsForTesting(() => ({ uid: 1000, gid: 1000 })));
after(() => _setCurrentHostIdsForTesting(null));

const HEALTHCHECK_JSON = JSON.stringify({
  Test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:6502/signalk"],
  Interval: 30_000_000_000,
  Timeout: 5_000_000_000,
  StartPeriod: 15_000_000_000,
  Retries: 3,
});

describe("getImageHealthcheck", () => {
  it("parses the image's healthcheck from inspect JSON", async () => {
    const exec = async (): Promise<ExecResult> => ({
      stdout: HEALTHCHECK_JSON,
      stderr: "",
      exitCode: 0,
    });
    const hc = await getImageHealthcheck(podman, "ghcr.io/x/y:tag", exec);
    assert.deepEqual(hc, {
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:6502/signalk"],
      intervalNs: 30_000_000_000,
      timeoutNs: 5_000_000_000,
      startPeriodNs: 15_000_000_000,
      retries: 3,
    });
  });

  it("returns null when the image declares no healthcheck", async () => {
    const exec = async (): Promise<ExecResult> => ({
      stdout: "null",
      stderr: "",
      exitCode: 0,
    });
    assert.equal(await getImageHealthcheck(podman, "img", exec), null);
  });

  it("returns null for HEALTHCHECK NONE", async () => {
    const exec = async (): Promise<ExecResult> => ({
      stdout: JSON.stringify({ Test: ["NONE"] }),
      stderr: "",
      exitCode: 0,
    });
    assert.equal(await getImageHealthcheck(podman, "img", exec), null);
  });

  it("returns null when inspect fails", async () => {
    const exec = async (): Promise<ExecResult> => ({
      stdout: "",
      stderr: "no such image",
      exitCode: 1,
    });
    assert.equal(await getImageHealthcheck(podman, "img", exec), null);
  });
});

describe("ensureRunning — image healthcheck re-emitted as run flags", () => {
  // Drive the missing-state create path and capture the `run` args. The fake
  // answers the state probe (missing), image inspect (present), the
  // healthcheck format-inspect, and the run.
  function captureRunArgs(
    config: ContainerConfig,
    healthcheckStdout: string,
  ): { runArgs: () => string[] | null; run: () => Promise<void> } {
    let captured: string[] | null = null;
    const exec = async (
      _runtime: ContainerRuntimeInfo,
      args: string[],
    ): Promise<ExecResult> => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "", stderr: "no such object", exitCode: 1 };
      }
      // Healthcheck format-inspect.
      if (
        cmd === "image" &&
        args[1] === "inspect" &&
        args.includes("{{json .Config.Healthcheck}}")
      ) {
        return { stdout: healthcheckStdout, stderr: "", exitCode: 0 };
      }
      // Plain image-exists inspect.
      if (cmd === "image" && args[1] === "inspect") {
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
      if (cmd === "run") {
        captured = args;
        return { stdout: "id", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    };
    return {
      runArgs: () => captured,
      run: () =>
        ensureRunning(docker, "demo", config, () => {}, undefined, exec),
    };
  }

  it("emits --health-cmd and timing flags from the image healthcheck", async () => {
    const cap = captureRunArgs(
      { image: "ghcr.io/x/y", tag: "tag" },
      HEALTHCHECK_JSON,
    );
    await cap.run();
    const args = cap.runArgs();
    assert.ok(args, "run was invoked");
    const i = args!.indexOf("--health-cmd");
    assert.ok(i >= 0, "--health-cmd present");
    assert.equal(
      args![i + 1],
      "wget -q -O /dev/null http://127.0.0.1:6502/signalk",
    );
    assert.ok(args!.includes("--health-interval"));
    assert.equal(args![args!.indexOf("--health-interval") + 1], "30s");
    assert.equal(args![args!.indexOf("--health-timeout") + 1], "5s");
    assert.equal(args![args!.indexOf("--health-start-period") + 1], "15s");
    assert.equal(args![args!.indexOf("--health-retries") + 1], "3");
  });

  it("emits no health flags when the image has no healthcheck", async () => {
    const cap = captureRunArgs({ image: "ghcr.io/x/y", tag: "tag" }, "null");
    await cap.run();
    const args = cap.runArgs();
    assert.ok(args, "run was invoked");
    assert.ok(!args!.includes("--health-cmd"), "no --health-cmd emitted");
  });
});

describe("ensureRunning — explicit healthcheck override", () => {
  // Like captureRunArgs above, but also records whether the image-healthcheck
  // inspect was consulted, so we can assert the override skips it.
  function captureRunArgs(config: ContainerConfig): {
    runArgs: () => string[] | null;
    imageHealthcheckInspected: () => boolean;
    run: () => Promise<void>;
  } {
    let captured: string[] | null = null;
    let inspectedImageHealthcheck = false;
    const exec = async (
      _runtime: ContainerRuntimeInfo,
      args: string[],
    ): Promise<ExecResult> => {
      const cmd = args[0];
      if (
        cmd === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.Running}}|{{.State.Pid}}")
      ) {
        return { stdout: "", stderr: "no such object", exitCode: 1 };
      }
      if (
        cmd === "image" &&
        args[1] === "inspect" &&
        args.includes("{{json .Config.Healthcheck}}")
      ) {
        inspectedImageHealthcheck = true;
        return { stdout: "null", stderr: "", exitCode: 0 };
      }
      if (cmd === "image" && args[1] === "inspect") {
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
      if (cmd === "run") {
        captured = args;
        return { stdout: "id", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    };
    return {
      runArgs: () => captured,
      imageHealthcheckInspected: () => inspectedImageHealthcheck,
      run: () =>
        ensureRunning(docker, "demo", config, () => {}, undefined, exec),
    };
  }

  it("emits --health-cmd from a CMD override and skips the image inspect", async () => {
    const cap = captureRunArgs({
      image: "questdb/questdb",
      tag: "latest",
      healthcheck: {
        test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/"],
        interval: "30s",
        timeout: "5s",
        startPeriod: "15s",
        retries: 3,
      },
    });
    await cap.run();
    const args = cap.runArgs();
    assert.ok(args, "run was invoked");
    const i = args!.indexOf("--health-cmd");
    assert.ok(i >= 0, "--health-cmd present");
    assert.equal(args![i + 1], "curl -f http://127.0.0.1:9000/");
    assert.equal(args![args!.indexOf("--health-interval") + 1], "30s");
    assert.equal(args![args!.indexOf("--health-timeout") + 1], "5s");
    assert.equal(args![args!.indexOf("--health-start-period") + 1], "15s");
    assert.equal(args![args!.indexOf("--health-retries") + 1], "3");
    assert.equal(
      cap.imageHealthcheckInspected(),
      false,
      "override skips the image-healthcheck inspect",
    );
  });

  it("wraps a CMD-SHELL override as a single shell string", async () => {
    const cap = captureRunArgs({
      image: "x/y",
      tag: "t",
      healthcheck: {
        test: ["CMD-SHELL", "curl -f http://localhost:9000/ || exit 1"],
      },
    });
    await cap.run();
    const args = cap.runArgs();
    const i = args!.indexOf("--health-cmd");
    assert.ok(i >= 0, "--health-cmd present");
    assert.equal(args![i + 1], "curl -f http://localhost:9000/ || exit 1");
  });

  it("emits --no-healthcheck when the override is false", async () => {
    const cap = captureRunArgs({
      image: "x/y",
      tag: "t",
      healthcheck: false,
    });
    await cap.run();
    const args = cap.runArgs();
    assert.ok(args, "run was invoked");
    assert.ok(args!.includes("--no-healthcheck"), "--no-healthcheck emitted");
    assert.ok(!args!.includes("--health-cmd"), "no --health-cmd with false");
    assert.equal(
      cap.imageHealthcheckInspected(),
      false,
      "false override skips the image-healthcheck inspect",
    );
  });
});
