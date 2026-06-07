import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selfDeployment, type SelfDeploymentProbes } from "../doctor.js";
import type { ContainerClient, ResolvedClient } from "../client.js";
import { makeMockClient } from "./helpers/mockClient.js";

const TEST_SOCKET = "/run/test/podman.sock";

/**
 * Wrap a `ContainerClient` (typically from `makeMockClient`) as a
 * `resolveClient` probe that resolves to that client + a socket path.
 * "A runtime is present" means "a socket answered the Docker API", and the
 * resolved socket is authoritative for `daemon.socketPath`.
 */
function resolveTo(
  client: ContainerClient,
  socketPath = TEST_SOCKET,
): () => Promise<ResolvedClient | null> {
  return async () => ({ client, socketPath });
}

/** A `resolveClient` probe that reports no socket answered. */
const resolveNone: () => Promise<ResolvedClient | null> = async () => null;

/**
 * Mock client whose `version()`/`info()` describe a rootless podman
 * daemon. `version().Components` carries the `Podman Engine` name the
 * doctor classifies on; `info()` exposes the docker-compat rootless
 * shape (top-level `Rootless` + `SecurityOptions: ["name=rootless"]`).
 */
function rootlessPodman(version = "5.4.2"): ContainerClient {
  return makeMockClient({
    version: { Version: version, Components: [{ Name: "Podman Engine" }] },
    info: { Rootless: true, SecurityOptions: ["name=rootless"] },
  });
}

/** Mock client for a rootful podman daemon (Rootless: false). */
function rootfulPodman(): ContainerClient {
  return makeMockClient({
    version: { Version: "5.4.2", Components: [{ Name: "Podman Engine" }] },
    info: { Rootless: false, SecurityOptions: ["name=cgroupns"] },
  });
}

/**
 * Mock client for a docker daemon that reports rootless via
 * `SecurityOptions` (no top-level `Rootless` boolean — older / rootless
 * docker only surfaces `name=rootless` in the options list).
 */
function dockerRootless(): ContainerClient {
  return makeMockClient({
    version: {
      Version: "27.0",
      Components: [{ Name: "Engine" }],
      Platform: { Name: "Docker Engine" },
    },
    info: { SecurityOptions: ["name=seccomp", "name=rootless"] },
  });
}

/** Mock client for a rootful docker daemon (no rootless markers). */
function dockerRootful(): ContainerClient {
  return makeMockClient({
    version: {
      Version: "27.0",
      Components: [{ Name: "Engine" }],
      Platform: { Name: "Docker Engine" },
    },
    info: { SecurityOptions: ["name=seccomp", "name=cgroupns"] },
  });
}

/**
 * Build a client whose `version()` rejects with `message`, simulating a
 * socket that existed at resolve time but whose daemon API call fails.
 * The doctor classifies off the categorized error of the throw, so the
 * message drives the resulting status (`permission denied` → permission,
 * anything else → socket-unreachable) and is preserved verbatim in
 * `daemon.error`.
 */
function unreachableDaemon(message: string): ContainerClient {
  const base = makeMockClient();
  return {
    ...base,
    version: () => Promise.reject(new Error(message)),
  } as unknown as ContainerClient;
}

/**
 * Mock client that validates a single container id via `inspect` — used
 * to drive `findSelfContainerId`'s HOSTNAME / cgroup cascade. The valid
 * id's `inspect` returns an object with an `Id` field (what `tryInspect`
 * checks); every other id 404s. `version`/`info` describe rootless podman
 * so the daemon probe also passes.
 */
function podmanWithSelfId(selfId: string): ContainerClient {
  return makeMockClient({
    version: { Version: "5.4.2", Components: [{ Name: "Podman Engine" }] },
    info: { Rootless: true, SecurityOptions: ["name=rootless"] },
    containers: {
      [selfId]: { inspect: { Id: selfId } },
    },
  });
}

/**
 * Mock client where no container id validates (every `inspect` 404s),
 * driving `findSelfContainerId` to exhaust its cascade. Daemon probe
 * still succeeds (rootless podman).
 */
function podmanNoSelfId(): ContainerClient {
  return makeMockClient({
    version: { Version: "5.4.2", Components: [{ Name: "Podman Engine" }] },
    info: { Rootless: true, SecurityOptions: ["name=rootless"] },
  });
}

function probesWith(overrides: SelfDeploymentProbes): SelfDeploymentProbes {
  return {
    isContainerized: overrides.isContainerized ?? (() => false),
    // Default to "no socket answered" so a test that doesn't opt into a
    // reachable runtime lands on the no-runtime branch. Override with a
    // resolveTo(...) probe to drive the reachable paths.
    resolveClient: overrides.resolveClient ?? resolveNone,
    // Default to the production behaviour (read real process.env) so
    // tests that mutate process.env via withEnv() see consistent
    // results across the socket-inference AND self-id source-attribution
    // layers. Override per-test when you want to assert that injected
    // readEnv drives a specific path.
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
    // Default to "mounts unreadable" so the containerStorage probe
    // short-circuits to `null` for tests that don't care about it.
    // Override per-test to drive the rootless-Podman + ZFS scenario.
    readMounts: overrides.readMounts ?? (async () => null),
    // Default to "no storage path resolvable" so the probe also
    // short-circuits to `null` even if readMounts is overridden.
    // Override per-test to point at a synthetic storage root.
    resolveContainerStoragePath:
      overrides.resolveContainerStoragePath ?? (() => null),
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
  it("bare-metal, podman socket reachable, rootless → ok + rootless true", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.remediation.length, 0);
    assert.equal(result.binary.name, "podman");
    // No binary concept over the socket — path is always null now.
    assert.equal(result.binary.path, null);
    assert.equal(result.binary.version, "5.4.2");
    assert.equal(result.daemon.reachable, true);
    assert.equal(result.daemon.rootless, true);
    assert.equal(result.isContainerized, false);
    // bare-metal: selfId is intentionally not probed (no notion of self-id)
    assert.equal(result.selfId.value, null);
    assert.equal(result.selfId.source, null);
  });

  it("bare-metal, podman reachable, rootful → ok + rootless false", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(rootfulPodman()),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.daemon.rootless, false);
  });

  it("bare-metal, docker reachable → ok, rootless extracted from SecurityOptions", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(dockerRootless()),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.binary.name, "docker");
    assert.equal(result.daemon.rootless, true);
  });

  it("docker without rootless markers → rootless=false (not null)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(dockerRootful()),
      }),
    );
    assert.equal(result.daemon.rootless, false);
  });
});

describe("selfDeployment — no-runtime branch", () => {
  it("bare-metal, no socket → status no-runtime + bare-metal remediation", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveNone,
      }),
    );
    assert.equal(result.status, "no-runtime");
    assert.equal(result.binary.name, null);
    assert.equal(result.daemon.reachable, false);
    // Bare-metal remediation mentions installing podman / docker.
    const joined = result.remediation.join("\n");
    assert.match(joined, /Install one/);
    assert.match(joined, /apt install podman/);
    assert.doesNotMatch(joined, /bind-mount/i);
  });

  it("containerized, no socket → no-runtime + end-user-friendly bind-mount remediation", async () => {
    // WHY: end users of off-the-shelf SK Docker images can't edit a
    // Dockerfile, so the remediation must lead with the bind-mount path
    // and cover both Docker and Podman hosts.
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => true,
        resolveClient: resolveNone,
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
  it("socket resolved, podman daemon unreachable → socket-unreachable + podman remediation", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => true,
        // version() rejects: socket existed at resolve time but the API
        // call failed. ECONNREFUSED classifies as socket-unreachable;
        // runtime name falls back to docker, but the message names
        // podman so we assert on the docker remediation below.
        resolveClient: resolveTo(
          unreachableDaemon("connect ECONNREFUSED /run/podman/podman.sock"),
        ),
      }),
    );
    assert.equal(result.status, "socket-unreachable");
    assert.equal(result.daemon.reachable, false);
    assert.match(result.daemon.error ?? "", /ECONNREFUSED/);
    // version() failed, so the runtime name can't be classified and the
    // doctor falls back to docker — the docker socket remediation fires.
    const joined = result.remediation.join("\n");
    assert.match(joined, /docker\.sock/);
    assert.match(joined, /DOCKER_HOST=/);
  });

  it("socket resolved, docker daemon unreachable → socket-unreachable + docker remediation", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => true,
        resolveClient: resolveTo(
          unreachableDaemon(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
          ),
        ),
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
      null,
      probesWith({
        isContainerized: () => true,
        resolveClient: resolveTo(
          unreachableDaemon(
            "permission denied while trying to connect to the Docker daemon socket",
          ),
        ),
      }),
    );
    assert.equal(result.status, "permission-denied");
    const joined = result.remediation.join("\n");
    assert.match(joined, /docker' group/);
    assert.match(joined, /group_add/);
  });

  it("unclassified daemon error → defaults to socket-unreachable, preserves raw text", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(
          unreachableDaemon(
            "Some unexpected runtime error that doesn't match any pattern",
          ),
        ),
      }),
    );
    assert.equal(result.status, "socket-unreachable");
    assert.equal(
      result.daemon.error,
      "Some unexpected runtime error that doesn't match any pattern",
    );
  });
});

describe("selfDeployment — runtime classification from version()", () => {
  it("podman version() Components classify as podman", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(rootlessPodman()),
      }),
    );
    assert.equal(result.binary.name, "podman");
  });

  it("docker version() Components classify as docker", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(dockerRootless()),
      }),
    );
    assert.equal(result.binary.name, "docker");
  });
});

describe("selfDeployment — env echo + socket path", () => {
  it("echoes DOCKER_HOST, CONTAINER_HOST, XDG_RUNTIME_DIR verbatim", async () => {
    const env: Record<string, string> = {
      DOCKER_HOST: "unix:///var/run/docker.sock",
      CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
      XDG_RUNTIME_DIR: "/run/user/1000",
    };
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(
          rootlessPodman(),
          "/run/user/1000/podman/podman.sock",
        ),
        readEnv: (k) => env[k],
      }),
    );
    assert.equal(result.env.DOCKER_HOST, env.DOCKER_HOST);
    assert.equal(result.env.CONTAINER_HOST, env.CONTAINER_HOST);
    assert.equal(result.env.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR);
  });

  it("daemon.socketPath comes from the resolved socket, not env inference", async () => {
    // Under the socket seam the authoritative socket path is whatever
    // resolveClient picked — not a guess derived from env vars.
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(
          rootlessPodman(),
          "/run/user/1000/podman/podman.sock",
        ),
      }),
    );
    assert.equal(result.daemon.socketPath, "/run/user/1000/podman/podman.sock");
  });

  it("no-runtime branch infers socketPath from DOCKER_HOST env", async () => {
    // When no socket answered there is no resolved path, so the report
    // falls back to the env-inferred docker socket so the operator can
    // see what was attempted.
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveNone,
        readEnv: (k) =>
          k === "DOCKER_HOST" ? "unix:///var/run/docker.sock" : undefined,
      }),
    );
    assert.equal(result.status, "no-runtime");
    assert.equal(result.daemon.socketPath, "unix:///var/run/docker.sock");
  });
});

describe("selfDeployment — selfId resolution", () => {
  it("containerized + SIGNALK_CONTAINER_ID set → selfId.source = env", async () => {
    await withEnv({ SIGNALK_CONTAINER_ID: "sk-test-001" }, async () => {
      const result = await selfDeployment(
        "auto",
        null,
        probesWith({
          isContainerized: () => true,
          // Explicit env override short-circuits findSelfContainerId
          // before any inspect, so the daemon probe is all the mock
          // client needs to satisfy.
          resolveClient: resolveTo(podmanNoSelfId()),
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
        null,
        probesWith({
          isContainerized: () => true,
          resolveClient: resolveTo(podmanNoSelfId()),
          readEnv: (k) =>
            k === "SIGNALK_CONTAINER_ID" ? "something-else" : undefined,
        }),
      );
      assert.equal(result.selfId.value, "real-id");
      assert.notEqual(result.selfId.source, "env");
    });
  });

  it("containerized + cascade fails on all branches → status self-id-unresolved", async () => {
    // No env override; HOSTNAME and cgroup will be attempted but the
    // mock client 404s every inspect, so tryInspect rejects every
    // candidate. The daemon probe still succeeds (rootless podman).
    await withEnv(
      { SIGNALK_CONTAINER_ID: undefined, HOSTNAME: "not-a-container-id" },
      async () => {
        const result = await selfDeployment(
          "auto",
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanNoSelfId()),
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

describe("selfDeployment — cgroup controllers", () => {
  it("containerized + memory not delegated → cgroup-controllers-incomplete", async () => {
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
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
    await withEnv(
      { SIGNALK_CONTAINER_ID: undefined, HOSTNAME: "not-a-container-id" },
      async () => {
        const result = await selfDeployment(
          "auto",
          null,
          probesWith({
            isContainerized: () => true,
            // Every inspect 404s → self-id unresolved.
            resolveClient: resolveTo(podmanNoSelfId()),
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
      null,
      probesWith({
        isContainerized: () => true,
        resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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
      null,
      probesWith({
        isContainerized: () => true,
        resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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
      null,
      probesWith({
        isContainerized: () => true,
        resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
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

describe("selfDeployment — containerStorage probe (rootless podman)", () => {
  // Reusable mount tables. Each list is in the same order `/proc/mounts`
  // would emit; the doctor's findCoveringMount() picks the deepest
  // match, so order matters less than coverage.
  const ext4Mounts = [
    { mountPoint: "/", fstype: "ext4" },
    { mountPoint: "/home", fstype: "ext4" },
  ];
  const zfsHomeMounts = [
    { mountPoint: "/", fstype: "ext4" },
    { mountPoint: "/home", fstype: "zfs" },
    { mountPoint: "/var/lib/synthetic", fstype: "zfs" },
  ];

  it("flags idmapHazard true on rootless podman backed by ZFS", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(result.status, "ok"); // advisory, never escalates
    assert.notEqual(result.containerStorage, null);
    assert.equal(result.containerStorage?.fstype, "zfs");
    assert.equal(result.containerStorage?.idmapHazard, true);
    assert.equal(
      result.containerStorage?.storagePath,
      "/var/lib/synthetic/.local/share/containers",
    );
    const advice = result.containerStorage?.advice.join("\n") ?? "";
    assert.match(advice, /fuse-overlayfs/);
    assert.match(advice, /disableUserNamespaceRemap|Disable user-namespace/i);
  });

  it("does not flag idmapHazard on rootless podman backed by ext4", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readMounts: async () => ext4Mounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(result.containerStorage?.fstype, "ext4");
    assert.equal(result.containerStorage?.idmapHazard, false);
    assert.deepEqual(result.containerStorage?.advice, []);
  });

  it("returns containerStorage null on rootful podman (probe is not relevant)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootfulPodman()), // rootless=false
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(result.daemon.rootless, false);
    assert.equal(result.containerStorage, null);
  });

  it("returns containerStorage null on docker (probe is podman-only)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(dockerRootless()),
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(result.binary.name, "docker");
    assert.equal(result.containerStorage, null);
  });

  it("returns containerStorage null when mounts are unreadable", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readMounts: async () => null, // simulate non-Linux / sandboxed
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(result.containerStorage, null);
  });

  it("returns containerStorage null when the storage path can't be resolved", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () => null,
      }),
    );
    assert.equal(result.containerStorage, null);
  });

  it("picks the deepest covering mount when nested mounts overlap", async () => {
    // `/var/lib/synthetic/podman` is its own ZFS dataset nested under a parent
    // ext4 home mount. The doctor must report zfs, not ext4.
    const nestedMounts = [
      { mountPoint: "/", fstype: "ext4" },
      { mountPoint: "/home", fstype: "ext4" },
      { mountPoint: "/var/lib/synthetic/podman", fstype: "zfs" },
    ];
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readMounts: async () => nestedMounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/podman/.local/share/containers",
      }),
    );
    assert.equal(result.containerStorage?.fstype, "zfs");
    assert.equal(result.containerStorage?.idmapHazard, true);
  });
});

describe("selfDeployment — rootless detection from info()", () => {
  // Under the socket seam rootless is read off the docker-compat info()
  // shape, not parsed out of CLI stdout. These replace the CLI-era
  // "defensive stdout parsing" suite — the parsing concern no longer
  // exists, but the rootless-detection branches still matter.

  it("podman docker-compat info exposes top-level Rootless:true", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(
          makeMockClient({
            version: {
              Version: "5.4.2",
              Components: [{ Name: "Podman Engine" }],
            },
            info: { Rootless: true, SecurityOptions: ["name=rootless"] },
          }),
        ),
      }),
    );
    assert.equal(result.daemon.rootless, true);
  });

  it("podman docker-compat info exposes top-level Rootless:false", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(
          makeMockClient({
            version: {
              Version: "5.4.2",
              Components: [{ Name: "Podman Engine" }],
            },
            info: { Rootless: false, SecurityOptions: ["name=cgroupns"] },
          }),
        ),
      }),
    );
    assert.equal(result.daemon.rootless, false);
  });

  it("falls back to SecurityOptions name=rootless when no Rootless boolean", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(
          makeMockClient({
            version: {
              Version: "5.4.2",
              Components: [{ Name: "Podman Engine" }],
            },
            info: { SecurityOptions: ["name=seccomp", "name=rootless"] },
          }),
        ),
      }),
    );
    assert.equal(result.daemon.rootless, true);
  });

  it("returns null when info() exposes neither Rootless nor SecurityOptions", async () => {
    // Older daemons / compat endpoints that omit both signals leave
    // rootless undetermined rather than guessing.
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(
          makeMockClient({
            version: {
              Version: "5.4.2",
              Components: [{ Name: "Podman Engine" }],
            },
            info: {},
          }),
        ),
      }),
    );
    assert.equal(result.daemon.rootless, null);
  });

  it("does not treat SecurityOptions without rootless as rootless", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(
          makeMockClient({
            version: {
              Version: "5.4.2",
              Components: [{ Name: "Podman Engine" }],
            },
            info: { SecurityOptions: ["name=seccomp", "name=cgroupns"] },
          }),
        ),
      }),
    );
    assert.equal(result.daemon.rootless, false);
  });
});
