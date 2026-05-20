import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selfDeployment, type SelfDeploymentProbes } from "../doctor.js";
import type { ContainerRuntimeInfo, RuntimeName } from "../types.js";

interface FakeResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

/**
 * Single-call fake. The doctor's daemon probe only ever invokes `exec`
 * once per scenario (a single `info` call), so a fixed result is all
 * we need.
 */
function fakeExec(result: FakeResult) {
  return async () => ({
    stdout: result.stdout,
    stderr: result.stderr ?? "",
    exitCode: result.exitCode,
  });
}

function probesWith(overrides: SelfDeploymentProbes): SelfDeploymentProbes {
  return {
    isContainerized: overrides.isContainerized ?? (() => false),
    findBinary: overrides.findBinary ?? (async () => null as string | null),
    readEnv: overrides.readEnv ?? (() => undefined),
  };
}

/**
 * Most tests need to drive `findSelfContainerId` to a deterministic
 * answer. Since that helper reads `process.env.SIGNALK_CONTAINER_ID`
 * directly (without an injection seam), we mutate the real env around
 * each test that cares.
 */
function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("selfDeployment — happy paths", () => {
  it("bare-metal, podman present, rootless → ok + rootless true", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "true", exitCode: 0 }),
      probesWith({
        isContainerized: () => false,
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.remediation.length, 0);
    assert.equal(result.binary.name, "podman");
    assert.equal(result.daemon.reachable, true);
    assert.equal(result.daemon.rootless, true);
    assert.equal(result.isContainerized, false);
    // bare-metal: selfId is intentionally not probed (no notion of self-id)
    assert.equal(result.selfId.value, null);
    assert.equal(result.selfId.source, null);
  });

  it("bare-metal, podman present, rootful → ok + rootless false", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "false", exitCode: 0 }),
      probesWith({
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.daemon.rootless, false);
  });

  it("bare-metal, docker present → ok, rootless extracted from SecurityOptions", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "name=seccomp\nname=rootless\n", exitCode: 0 }),
      probesWith({
        // simulate auto-discovery falling through podman to docker
        findBinary: async (n) => (n === "docker" ? "/usr/bin/docker" : null),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.binary.name, "docker");
    assert.equal(result.daemon.rootless, true);
  });

  it("docker without rootless flag → rootless=false (not null)", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "name=seccomp\n", exitCode: 0 }),
      probesWith({
        findBinary: async (n) => (n === "docker" ? "/usr/bin/docker" : null),
      }),
    );
    assert.equal(result.daemon.rootless, false);
  });
});

describe("selfDeployment — no-runtime branch", () => {
  it("bare-metal, no binaries → status no-runtime + bare-metal remediation", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "", exitCode: 0 }),
      probesWith({
        isContainerized: () => false,
        findBinary: async () => null,
      }),
    );
    assert.equal(result.status, "no-runtime");
    assert.equal(result.binary.name, null);
    // Bare-metal remediation mentions installing podman / docker.
    const joined = result.remediation.join("\n");
    assert.match(joined, /Install one/);
    assert.match(joined, /apt install podman/);
    assert.doesNotMatch(joined, /bind-mount/i);
  });

  it("containerized, no binaries → no-runtime + in-container remediation (podman-remote first)", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "", exitCode: 0 }),
      probesWith({
        isContainerized: () => true,
        findBinary: async () => null,
      }),
    );
    assert.equal(result.status, "no-runtime");
    const joined = result.remediation.join("\n");
    // The README prereq path comes first — install in your image.
    assert.match(
      joined,
      /add `podman` \(or `podman-remote`\) to your Signal K image/,
    );
    // Bind-mount of the host binary is offered as a fallback only.
    const installIdx = joined.indexOf("install -y podman");
    const bindIdx = joined.indexOf("bind-mount the host binary");
    assert.ok(
      installIdx >= 0 && bindIdx >= 0 && installIdx < bindIdx,
      "install instruction should appear before bind-mount fallback",
    );
    // Rootless podman example must be present and listed first.
    const rootlessIdx = joined.indexOf("Rootless Podman");
    const rootfulIdx = joined.indexOf("Rootful Podman");
    assert.ok(rootlessIdx >= 0 && rootlessIdx < rootfulIdx);
  });
});

describe("selfDeployment — daemon failure classification", () => {
  it("podman binary present, socket missing → socket-unreachable + podman remediation", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({
        stdout: "",
        stderr:
          "Cannot connect to Podman. Please verify your connection to the Linux system",
        exitCode: 125,
      }),
      probesWith({
        isContainerized: () => true,
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
      }),
    );
    assert.equal(result.status, "socket-unreachable");
    assert.equal(result.daemon.reachable, false);
    assert.match(result.daemon.error ?? "", /Cannot connect to Podman/);
    const joined = result.remediation.join("\n");
    assert.match(joined, /podman.socket/);
    assert.match(joined, /CONTAINER_HOST=unix/);
  });

  it("docker binary present, daemon unreachable → socket-unreachable + docker remediation", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({
        stdout: "",
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        exitCode: 1,
      }),
      probesWith({
        isContainerized: () => true,
        findBinary: async (n) => (n === "docker" ? "/usr/bin/docker" : null),
      }),
    );
    assert.equal(result.status, "socket-unreachable");
    const joined = result.remediation.join("\n");
    assert.match(joined, /docker\.sock/);
    assert.match(joined, /DOCKER_HOST=/);
  });

  it("permission denied → status permission-denied + group_add remediation", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({
        stdout: "",
        stderr:
          "permission denied while trying to connect to the Docker daemon socket",
        exitCode: 1,
      }),
      probesWith({
        isContainerized: () => true,
        findBinary: async (n) => (n === "docker" ? "/usr/bin/docker" : null),
      }),
    );
    assert.equal(result.status, "permission-denied");
    const joined = result.remediation.join("\n");
    assert.match(joined, /docker' group/);
    assert.match(joined, /group_add/);
  });

  it("unclassified daemon stderr → defaults to socket-unreachable, preserves raw text", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({
        stdout: "",
        stderr: "Some unexpected runtime error that doesn't match any pattern",
        exitCode: 2,
      }),
      probesWith({
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
      }),
    );
    assert.equal(result.status, "socket-unreachable");
    assert.equal(
      result.daemon.error,
      "Some unexpected runtime error that doesn't match any pattern",
    );
  });
});

describe("selfDeployment — preference filtering", () => {
  it("preference=podman never asks findBinary for docker", async () => {
    const probed: RuntimeName[] = [];
    const result = await selfDeployment(
      "podman",
      fakeExec({ stdout: "true", exitCode: 0 }),
      probesWith({
        findBinary: async (n) => {
          probed.push(n);
          return n === "podman" ? "/usr/bin/podman" : null;
        },
      }),
    );
    assert.deepEqual(probed, ["podman"]);
    assert.equal(result.binary.name, "podman");
  });

  it("preference=docker never asks findBinary for podman", async () => {
    const probed: RuntimeName[] = [];
    const result = await selfDeployment(
      "docker",
      fakeExec({ stdout: "name=rootless\n", exitCode: 0 }),
      probesWith({
        findBinary: async (n) => {
          probed.push(n);
          return n === "docker" ? "/usr/bin/docker" : null;
        },
      }),
    );
    assert.deepEqual(probed, ["docker"]);
    assert.equal(result.binary.name, "docker");
  });
});

describe("selfDeployment — env echo + socket inference", () => {
  it("echoes DOCKER_HOST, CONTAINER_HOST, XDG_RUNTIME_DIR verbatim", async () => {
    const env: Record<string, string> = {
      DOCKER_HOST: "unix:///var/run/docker.sock",
      CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
      XDG_RUNTIME_DIR: "/run/user/1000",
    };
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "true", exitCode: 0 }),
      probesWith({
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
        readEnv: (k) => env[k],
      }),
    );
    assert.equal(result.env.DOCKER_HOST, env.DOCKER_HOST);
    assert.equal(result.env.CONTAINER_HOST, env.CONTAINER_HOST);
    assert.equal(result.env.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR);
    // socketPath for podman comes from CONTAINER_HOST when available.
    assert.equal(result.daemon.socketPath, env.CONTAINER_HOST);
  });

  it("docker socketPath comes from DOCKER_HOST", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "name=rootless\n", exitCode: 0 }),
      probesWith({
        findBinary: async (n) => (n === "docker" ? "/usr/bin/docker" : null),
        readEnv: (k) =>
          k === "DOCKER_HOST" ? "tcp://1.2.3.4:2375" : undefined,
      }),
    );
    assert.equal(result.daemon.socketPath, "tcp://1.2.3.4:2375");
  });
});

describe("selfDeployment — selfId resolution", () => {
  it("containerized + SIGNALK_CONTAINER_ID set → selfId.source = env", async () => {
    await withEnv({ SIGNALK_CONTAINER_ID: "sk-test-001" }, async () => {
      const result = await selfDeployment(
        "auto",
        fakeExec({ stdout: "true", exitCode: 0 }),
        probesWith({
          isContainerized: () => true,
          findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
        }),
      );
      assert.equal(result.status, "ok");
      assert.equal(result.selfId.value, "sk-test-001");
      assert.equal(result.selfId.source, "env");
    });
  });

  it("containerized + cascade fails on all branches → status self-id-unresolved", async () => {
    // No env override; HOSTNAME and cgroup will be attempted but our
    // fake exec returns exit 1 for every inspect, so tryInspect rejects
    // every candidate.  fakeExec returns the same shape for `info`
    // (called once, exit 0) AND `inspect` (exit 1) because we hand it
    // a fresh closure that branches on argv.
    const branchingExec = async (
      _runtime: ContainerRuntimeInfo,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (args[0] === "info") {
        return { stdout: "true", stderr: "", exitCode: 0 };
      }
      // inspect ...: reject everything
      return { stdout: "", stderr: "no such object", exitCode: 1 };
    };
    await withEnv(
      { SIGNALK_CONTAINER_ID: undefined, HOSTNAME: "not-a-container-id" },
      async () => {
        const result = await selfDeployment(
          "auto",
          branchingExec,
          probesWith({
            isContainerized: () => true,
            findBinary: async (n) =>
              n === "podman" ? "/usr/bin/podman" : null,
          }),
        );
        assert.equal(result.status, "self-id-unresolved");
        assert.equal(result.selfId.value, null);
        assert.equal(result.selfId.source, null);
        const joined = result.remediation.join("\n");
        assert.match(joined, /SIGNALK_CONTAINER_ID/);
      },
    );
  });
});
