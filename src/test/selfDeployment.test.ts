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
    // Default to a fixed synthetic version so tests don't spawn the
    // real podman/docker binary. Override when the test asserts on a
    // specific version string.
    readBinaryVersion:
      overrides.readBinaryVersion ?? (async () => "test-1.0.0"),
    // Default to the production behaviour (read real process.env) so
    // tests that mutate process.env via withEnv() see consistent
    // results across the binary-discovery, socket-inference, AND
    // self-id source-attribution layers. Override per-test when you
    // want to assert that injected readEnv drives a specific path.
    readEnv: overrides.readEnv ?? ((k: string) => process.env[k]),
    // Default to "all expected controllers delegated" so the cgroup
    // status escalation never fires for tests that don't opt in.
    // Override per-test to drive cgroup-controllers-incomplete /
    // unprobeable paths.
    readCgroupControllers:
      overrides.readCgroupControllers ??
      (async () => ["cpu", "cpuset", "io", "memory", "pids"]),
    // Default to a "memory enabled" kernel cmdline so the
    // kernel-disabled-memory escalation never fires for tests that
    // don't opt in. Override per-test to drive the Raspberry-Pi-OS
    // Trixie scenario.
    readKernelCmdline:
      overrides.readKernelCmdline ??
      (async () => "root=PARTUUID=abc rootwait quiet"),
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

  it("containerized, no binaries → no-runtime + end-user-friendly bind-mount remediation", async () => {
    // WHY: end users of off-the-shelf SK Docker images can't edit a
    // Dockerfile, so the remediation must lead with the bind-mount path
    // and cover both Docker and Podman hosts.
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

    assert.match(joined, /If your host runs Docker/);
    assert.match(joined, /If your host runs Podman/);
    assert.match(joined, /-v \/usr\/bin\/docker:\/usr\/bin\/docker:ro/);
    assert.match(joined, /-v \/usr\/bin\/podman:\/usr\/bin\/podman:ro/);
    assert.match(joined, /\/var\/run\/docker\.sock/);
    assert.match(joined, /podman\.sock/);
    assert.match(joined, /For image maintainers/);
    assert.match(joined, /install -y docker-ce-cli/);
    assert.match(joined, /install -y podman/);

    // WHY: doctor probe can't know which runtime the host uses, so the
    // remediation must not promote one as "recommended" globally.
    assert.doesNotMatch(joined, /Podman \(recommended\)/);

    // WHY: the pre-built image is the lowest-friction option for users
    // who can pick their SK image. Surface it before the bind-mount
    // recipes so users see it first.
    assert.match(joined, /ghcr\.io\/dirkwa\/signalk-server:latest/);
    assert.match(joined, /pre-built image/i);
    const prebuiltIdx = joined.indexOf("ghcr.io/dirkwa/signalk-server");
    const dockerBindIdx = joined.indexOf("/usr/bin/docker:/usr/bin/docker");
    assert.ok(
      prebuiltIdx >= 0 && prebuiltIdx < dockerBindIdx,
      "pre-built image section must appear before the bind-mount recipes",
    );

    const maintainerIdx = joined.indexOf("For image maintainers");
    assert.ok(
      dockerBindIdx >= 0 && maintainerIdx > dockerBindIdx,
      "bind-mount path must appear before the image-maintainer section",
    );
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

  it("podman socketPath falls back to DOCKER_HOST when CONTAINER_HOST is unset", async () => {
    const result = await selfDeployment(
      "auto",
      fakeExec({ stdout: "true", exitCode: 0 }),
      probesWith({
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
        readEnv: (k) =>
          k === "DOCKER_HOST" ? "unix:///var/run/docker.sock" : undefined,
      }),
    );
    // Podman honors DOCKER_HOST in docker-API compat mode.
    assert.equal(result.daemon.socketPath, "unix:///var/run/docker.sock");
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

  it("source attribution honours injected readEnv, not process.env", async () => {
    // findSelfContainerId still reads process.env directly (it has no
    // injection seam), so we keep process.env set so it returns a
    // value. But our source-attribution layer must use the injected
    // readEnv — proving the consistency fix lands:
    // process.env says SIGNALK_CONTAINER_ID="real-id" → value resolves.
    // injected readEnv says SIGNALK_CONTAINER_ID="something-else" →
    // attribution must NOT report source="env" (because the injected
    // probe disagrees with the value).
    await withEnv({ SIGNALK_CONTAINER_ID: "real-id" }, async () => {
      const result = await selfDeployment(
        "auto",
        fakeExec({ stdout: "true", exitCode: 0 }),
        probesWith({
          isContainerized: () => true,
          findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
          readEnv: (k) =>
            k === "SIGNALK_CONTAINER_ID" ? "something-else" : undefined,
        }),
      );
      assert.equal(result.selfId.value, "real-id");
      assert.notEqual(result.selfId.source, "env");
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

/**
 * Branching exec that drives every selfDeployment probe to the
 * happy-path response: `info` reports rootless, self-id `inspect`
 * resolves the synthetic container ID.
 */
function happyExec(selfId: string) {
  return async (
    _runtime: ContainerRuntimeInfo,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    if (args[0] === "info") {
      return { stdout: "true", stderr: "", exitCode: 0 };
    }
    if (args[0] === "inspect" && args.includes(selfId)) {
      return { stdout: "running", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "no such object", exitCode: 1 };
  };
}

describe("selfDeployment — cgroup controllers", () => {
  it("containerized + memory not delegated → cgroup-controllers-incomplete", async () => {
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          happyExec("sk-test-host"),
          probesWith({
            isContainerized: () => true,
            findBinary: async (n) =>
              n === "podman" ? "/usr/bin/podman" : null,
            // Missing "memory" — matches the real Pi5 deployment we hit.
            readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
          }),
        );
        assert.equal(result.status, "cgroup-controllers-incomplete");
        assert.deepEqual(result.cgroupControllers.available, [
          "cpu",
          "cpuset",
          "io",
          "pids",
        ]);
        assert.deepEqual(result.cgroupControllers.missing, ["memory"]);
        const joined = result.remediation.join("\n");
        assert.match(joined, /memory/);
        assert.match(joined, /Delegate=cpu cpuset io memory pids/);
      },
    );
  });

  it("containerized + all expected delegated → ok (no escalation)", async () => {
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          happyExec("sk-test-host"),
          probesWith({
            isContainerized: () => true,
            findBinary: async (n) =>
              n === "podman" ? "/usr/bin/podman" : null,
            readCgroupControllers: async () => [
              "cpu",
              "cpuset",
              "io",
              "memory",
              "pids",
            ],
          }),
        );
        assert.equal(result.status, "ok");
        assert.deepEqual(result.cgroupControllers.missing, []);
      },
    );
  });

  it("containerized + cgroup v1 host (probe returns null) → ok, missing=[]", async () => {
    // We can't know whether memory is delegated on cgroup v1 systems —
    // each controller is a separate subdir, not a single file. Skip the
    // escalation rather than firing false positives.
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          happyExec("sk-test-host"),
          probesWith({
            isContainerized: () => true,
            findBinary: async (n) =>
              n === "podman" ? "/usr/bin/podman" : null,
            readCgroupControllers: async () => null,
          }),
        );
        assert.equal(result.status, "ok");
        assert.equal(result.cgroupControllers.available, null);
        assert.deepEqual(result.cgroupControllers.missing, []);
      },
    );
  });

  it("bare-metal + memory missing → ok (cgroup status is in-container only)", async () => {
    // Bare-metal hosts virtually always have full delegation; even if
    // they don't, signalk-container can't act on it (rootless SK on the
    // bare-metal user is the controlled case the user can adjust
    // themselves). Don't escalate.
    const result = await selfDeployment(
      "auto",
      happyExec("never-matched"),
      probesWith({
        isContainerized: () => false,
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
        readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
      }),
    );
    assert.equal(result.status, "ok");
    assert.deepEqual(result.cgroupControllers.missing, ["memory"]);
  });

  it("self-id-unresolved trumps cgroup-controllers-incomplete in status", async () => {
    // Both problems can be true simultaneously; self-id-unresolved is
    // louder (blocks sibling-container creation entirely) so the
    // operator should see that first. The cgroup data is still
    // populated in the result body for diagnostic purposes.
    const inspectAlwaysFails = async (
      _runtime: ContainerRuntimeInfo,
      args: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (args[0] === "info") {
        return { stdout: "true", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "no such object", exitCode: 1 };
    };
    await withEnv(
      { SIGNALK_CONTAINER_ID: undefined, HOSTNAME: "not-a-container-id" },
      async () => {
        const result = await selfDeployment(
          "auto",
          inspectAlwaysFails,
          probesWith({
            isContainerized: () => true,
            findBinary: async (n) =>
              n === "podman" ? "/usr/bin/podman" : null,
            readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
          }),
        );
        assert.equal(result.status, "self-id-unresolved");
        // Cgroup data still surfaced in the body.
        assert.deepEqual(result.cgroupControllers.missing, ["memory"]);
      },
    );
  });
});

describe("selfDeployment — kernel cgroup_disable=memory detection", () => {
  // WHY: Raspberry Pi OS Trixie's GPU firmware injects cgroup_disable=memory
  // into the kernel cmdline. The systemd-Delegate fix doesn't help in that
  // case — the doctor must surface the kernel-level fix instead.

  it("flags kernelDisabledMemory when cmdline contains cgroup_disable=memory", async () => {
    const result = await selfDeployment(
      "auto",
      happyExec("sk-test-host"),
      probesWith({
        isContainerized: () => true,
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
        readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
        readKernelCmdline: async () =>
          "root=PARTUUID=abc cgroup_disable=memory rootwait quiet",
      }),
    );
    assert.equal(result.cgroupControllers.kernelDisabledMemory, true);
  });

  it("does NOT flag kernelDisabledMemory when a later cgroup_enable=memory overrides it", async () => {
    // Kernel evaluates cmdline left-to-right; a later occurrence wins.
    // This is exactly the fix path documented in the remediation block.
    const result = await selfDeployment(
      "auto",
      happyExec("sk-test-host"),
      probesWith({
        isContainerized: () => true,
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
        readCgroupControllers: async () => [
          "cpu",
          "cpuset",
          "io",
          "memory",
          "pids",
        ],
        readKernelCmdline: async () =>
          "root=PARTUUID=abc cgroup_disable=memory rootwait cgroup_enable=memory cgroup_memory=1",
      }),
    );
    assert.equal(result.cgroupControllers.kernelDisabledMemory, false);
  });

  it("DOES flag when an earlier cgroup_enable is overridden by a LATER cgroup_disable (last-token wins)", async () => {
    // Defensive against the wrong direction — last-token-wins must work
    // for the disable side too, otherwise we'd silently miss this case.
    const result = await selfDeployment(
      "auto",
      happyExec("sk-test-host"),
      probesWith({
        isContainerized: () => true,
        findBinary: async (n) => (n === "podman" ? "/usr/bin/podman" : null),
        readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
        readKernelCmdline: async () =>
          "root=PARTUUID=abc cgroup_enable=memory cgroup_memory=1 cgroup_disable=memory rootwait",
      }),
    );
    assert.equal(result.cgroupControllers.kernelDisabledMemory, true);
  });

  it("kernel-disabled remediation block names the cmdline.txt edit, not the systemd snippet", async () => {
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          happyExec("sk-test-host"),
          probesWith({
            isContainerized: () => true,
            findBinary: async (n) =>
              n === "podman" ? "/usr/bin/podman" : null,
            readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
            readKernelCmdline: async () =>
              "root=PARTUUID=abc cgroup_disable=memory rootwait",
          }),
        );
        assert.equal(result.status, "cgroup-controllers-incomplete");
        const remediation = result.remediation.join("\n");
        assert.match(remediation, /cgroup_disable=memory/);
        assert.match(remediation, /cmdline\.txt/);
        assert.match(remediation, /cgroup_enable=memory/);
        assert.match(remediation, /sudo reboot/);
      },
    );
  });

  it("plain-missing-delegation remediation block still names the systemd snippet (no kernel disable)", async () => {
    // Regression guard: the kernel-disabled branch must not leak into
    // the "memory missing, but kernel is fine" case.
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          happyExec("sk-test-host"),
          probesWith({
            isContainerized: () => true,
            findBinary: async (n) =>
              n === "podman" ? "/usr/bin/podman" : null,
            readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
            readKernelCmdline: async () => "root=PARTUUID=abc rootwait quiet",
          }),
        );
        assert.equal(result.status, "cgroup-controllers-incomplete");
        const remediation = result.remediation.join("\n");
        assert.match(remediation, /Delegate=cpu cpuset io memory pids/);
        assert.doesNotMatch(remediation, /cmdline\.txt/);
      },
    );
  });

  it("treats unreadable cmdline as 'not kernel-disabled' (false negative is safer than false positive)", async () => {
    // Non-Linux hosts, restricted /proc, weird sandboxes all return null.
    // We prefer to fall through to the systemd-only remediation than to
    // wrongly tell the operator to edit a cmdline.txt they don't have.
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          happyExec("sk-test-host"),
          probesWith({
            isContainerized: () => true,
            findBinary: async (n) =>
              n === "podman" ? "/usr/bin/podman" : null,
            readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
            readKernelCmdline: async () => null,
          }),
        );
        assert.equal(result.cgroupControllers.kernelDisabledMemory, false);
        const remediation = result.remediation.join("\n");
        assert.match(remediation, /Delegate=cpu cpuset io memory pids/);
      },
    );
  });
});
