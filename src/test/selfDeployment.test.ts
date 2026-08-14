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
    // Default to "linger dir unreadable" so the linger advisory never
    // fires for tests that don't opt in. Override per-test to drive
    // the enabled / not-enabled / absent-dir paths.
    readLingerDir: overrides.readLingerDir ?? (async () => null),
    resolveLingerUser: overrides.resolveLingerUser ?? (() => null),
    // Default to "libpod info unavailable" so the network-DNS advisory
    // never fires for tests that don't opt in. Override per-test to
    // drive the netavark-with/without-aardvark paths.
    readNetworkBackendInfo:
      overrides.readNetworkBackendInfo ?? (async () => null),
  };
}

/**
 * Assert that every `<<'EOF'` heredoc in a remediation block is closed by
 * a terminator on its own line at column 0. A copy-pasted heredoc whose
 * `EOF` is indented is never recognised by the shell, so the command hangs
 * waiting for input — the exact failure a user hit with the cgroup
 * delegation snippet.
 */
function assertHeredocsTerminated(lines: string[]): void {
  let open = 0;
  for (const line of lines) {
    if (/<<'EOF'\s*$/.test(line)) open++;
    else if (line === "EOF") open--;
  }
  assert.equal(
    open,
    0,
    `unbalanced heredoc — an EOF terminator is missing or indented:\n${lines.join("\n")}`,
  );
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
        // Pinned above every version floor so this "everything is fine"
        // baseline asserts an empty remediation without an advisory
        // (the default 5.4.2 trips the rootless nofile advice).
        resolveClient: resolveTo(rootlessPodman("5.5.0")),
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.remediation.length, 0);
    assert.equal(result.binary.name, "podman");
    // No binary concept over the socket — path is always null now.
    assert.equal(result.binary.path, null);
    assert.equal(result.binary.version, "5.5.0");
    assert.equal(result.daemon.reachable, true);
    assert.equal(result.daemon.rootless, true);
    assert.equal(result.isContainerized, false);
    // bare-metal: selfId is intentionally not probed (no notion of self-id)
    assert.equal(result.selfId.value, null);
    assert.equal(result.selfId.source, null);
  });

  it("old podman (< 4.5) → still ok, but advises an upgrade", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman("4.3.1")),
      }),
    );
    // Advisory only — an old-but-working podman is not a failure.
    assert.equal(result.status, "ok");
    assert.equal(result.binary.version, "4.3.1");
    const joined = result.remediation.join("\n");
    assert.match(joined, /older than 4\.5/);
    // The advisory names the concrete symptom (write EPIPE on large jobs) so
    // an operator hitting it later connects the dots.
    assert.match(joined, /EPIPE/);
  });

  it("current podman (>= 4.5) → ok with no EPIPE advisory", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman("4.5.0")),
      }),
    );
    assert.equal(result.status, "ok");
    // Scoped to the 4.5 floor this test is about: 4.5.0 is still below
    // the rootless nofile floor (5.5) and the supported baseline (5.4),
    // each of which has its own advisory.
    assert.equal(
      result.remediation.some((l) => l.includes("older than 4.5")),
      false,
    );
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
    // Bare-metal remediation: install a runtime + ensure its socket runs.
    const joined = result.remediation.join("\n");
    assert.match(joined, /Install a runtime/);
    assert.match(joined, /apt install podman/);
    assert.match(joined, /podman\.socket/);
    assert.doesNotMatch(joined, /bind-mount/i);
  });

  it("containerized, no socket → no-runtime + socket-mount remediation (no CLI)", async () => {
    // WHY: end users of off-the-shelf SK Docker images can't edit a
    // Dockerfile, so the remediation must lead with the socket bind-mount
    // and cover both Docker and Podman hosts. Post-dockerode-port there is
    // NO podman/docker CLI requirement inside the container — the
    // remediation must not tell operators to mount or install one.
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
    assert.match(joined, /\/var\/run\/docker\.sock/);
    assert.match(joined, /podman\.sock/);
    // The socket is the only requirement — explicitly states no CLI is needed.
    assert.match(joined, /no podman\/docker CLI binary is needed/i);

    // Regression guards: the obsolete CLI-binary advice must be gone.
    assert.doesNotMatch(joined, /\/usr\/bin\/docker/);
    assert.doesNotMatch(joined, /\/usr\/bin\/podman/);
    assert.doesNotMatch(joined, /docker-ce-cli/);
    assert.doesNotMatch(joined, /ghcr\.io\/dirkwa\/signalk-server/);

    // WHY: doctor probe can't know which runtime the host uses, so the
    // remediation must not promote one as "recommended" globally.
    assert.doesNotMatch(joined, /Podman \(recommended\)/);
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

  it("connect EACCES on the socket → permission-denied (the real dockerode message)", async () => {
    // The exact string dockerode throws when the socket's owner/group ACL
    // refuses the container user (verified live: container user not in the
    // host `docker` group). This must reach permission-denied, not the
    // generic socket-unreachable / no-runtime — the operator's fix is
    // group_add, which only the permission remediation names.
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => true,
        resolveClient: resolveTo(
          unreachableDaemon("connect EACCES /var/run/docker.sock"),
        ),
      }),
    );
    assert.equal(result.status, "permission-denied");
    assert.match(result.remediation.join("\n"), /group_add/);
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
        // Commands are pasted verbatim: the real self container ref must
        // be substituted, and the container restart (not the admin UI's
        // in-container process restart) must be spelled out.
        assert.doesNotMatch(joined, /<sk-container>/);
        assert.match(joined, /podman exec sk-test-host/);
        assert.match(
          joined,
          /systemctl --user restart signalk-server\.service/,
        );
        assert.match(joined, /podman restart sk-test-host/);
        // The delegate.conf heredoc must be copy-pasteable (column-0 EOF).
        assertHeredocsTerminated(result.remediation);
      },
    );
  });

  it("containerized + 64-hex self id → remediation uses 12-char short id", async () => {
    const fullHexId =
      "f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2";
    await withEnv(
      { SIGNALK_CONTAINER_ID: fullHexId, HOSTNAME: fullHexId },
      async () => {
        const result = await selfDeployment(
          "auto",
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId(fullHexId)),
            readCgroupControllers: async () => ["cpu", "cpuset", "io", "pids"],
          }),
        );
        assert.equal(result.status, "cgroup-controllers-incomplete");
        const joined = result.remediation.join("\n");
        assert.match(joined, /podman exec f1a2b3c4d5e6 /);
        assert.match(joined, /podman restart f1a2b3c4d5e6 /);
        assert.doesNotMatch(joined, new RegExp(fullHexId));
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

  it("containerized + rootless (cpuset absent, cpu/memory/pids present) → ok", async () => {
    // The real rootless deployment: systemd does not propagate the cpuset
    // controller down to user-<uid>.slice, so a healthy rootless host shows
    // exactly this set. cpuset is not in EXPECTED_CGROUP_CONTROLLERS, so it
    // must NOT escalate (it used to, firing a false positive on every
    // rootless install — including the Podman-machine VM on Windows/macOS).
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
            readCgroupControllers: async () => ["cpu", "io", "memory", "pids"],
          }),
        );
        assert.equal(result.status, "ok");
        assert.deepEqual(result.cgroupControllers.missing, []);
        // cpuset is reported as available-or-not verbatim, just not required.
        assert.deepEqual(result.cgroupControllers.available, [
          "cpu",
          "io",
          "memory",
          "pids",
        ]);
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

describe("selfDeployment — systemd linger advisory", () => {
  // WHY: rootless podman AND rootless docker live in the user's systemd
  // instance; without linger nothing starts the runtime socket (or
  // containers with a restart policy) at boot on a headless host. The
  // advisory must never escalate status and must never false-fire when
  // the linger state isn't visible.

  it("bare-metal rootless + user lingers → enabled, no advice, status ok", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readLingerDir: async () => ["dirk", "other"],
        resolveLingerUser: () => "dirk",
      }),
    );
    assert.equal(result.status, "ok");
    assert.deepEqual(result.linger, {
      user: "dirk",
      enabled: true,
      advice: [],
    });
  });

  it("bare-metal rootless + user does not linger → advice, status still ok", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readLingerDir: async () => ["someoneelse"],
        resolveLingerUser: () => "dirk",
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.linger?.enabled, false);
    assert.match(result.linger!.advice.join("\n"), /loginctl enable-linger/);
  });

  it("bare-metal rootless + linger dir absent → not enabled (nobody lingers)", async () => {
    // systemd creates the dir on the first enable-linger; on bare-metal
    // its absence is itself the finding.
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readLingerDir: async () => "absent",
        resolveLingerUser: () => "dirk",
      }),
    );
    assert.equal(result.linger?.enabled, false);
    assert.match(result.linger!.advice.join("\n"), /loginctl enable-linger/);
  });

  it("containerized + linger dir absent → linger null (host dir not mounted)", async () => {
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
            readLingerDir: async () => "absent",
          }),
        );
        assert.equal(result.status, "ok");
        assert.equal(result.linger, null);
      },
    );
  });

  it("containerized + mounted dir with entries → enabled, user null", async () => {
    // In-container the host username is unknowable; any linger entry
    // counts (exact on single-user hosts).
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
            readLingerDir: async () => ["dirk"],
          }),
        );
        assert.deepEqual(result.linger, {
          user: null,
          enabled: true,
          advice: [],
        });
      },
    );
  });

  it("containerized + mounted but empty dir → advice fires", async () => {
    await withEnv(
      { SIGNALK_CONTAINER_ID: "sk-test-host", HOSTNAME: "sk-test-host" },
      async () => {
        const result = await selfDeployment(
          "auto",
          null,
          probesWith({
            isContainerized: () => true,
            resolveClient: resolveTo(podmanWithSelfId("sk-test-host")),
            readLingerDir: async () => [],
          }),
        );
        assert.equal(result.status, "ok");
        assert.equal(result.linger?.enabled, false);
        assert.match(
          result.linger!.advice.join("\n"),
          /loginctl enable-linger/,
        );
      },
    );
  });

  it("bare-metal + username unresolvable → linger null (unknown, not a finding)", async () => {
    // Another user's linger entry says nothing about the SK user's, so
    // the any-entry fallback must not apply outside a container.
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(rootlessPodman()),
        readLingerDir: async () => ["someoneelse"],
        resolveLingerUser: () => null,
      }),
    );
    assert.equal(result.linger, null);
  });

  it("rootful docker → linger null (system service needs no linger)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(dockerRootful()),
        readLingerDir: async () => [],
        resolveLingerUser: () => "dirk",
      }),
    );
    assert.equal(result.linger, null);
  });

  it("rootless docker → probe runs (gate is rootless, not podman)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(dockerRootless()),
        readLingerDir: async () => ["dirk"],
        resolveLingerUser: () => "dirk",
      }),
    );
    assert.deepEqual(result.linger, {
      user: "dirk",
      enabled: true,
      advice: [],
    });
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
        // This block also embeds the delegate.conf heredoc — keep it valid.
        assertHeredocsTerminated(result.remediation);
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

  it("prefers the daemon-reported graphroot over the XDG-derived guess", async () => {
    // storage.conf points graphroot at /var/lib/podman-users/... (ext4)
    // while the XDG-guessed default path sits on ZFS. The daemon's
    // DockerRootDir must win, or the doctor probes a directory Podman
    // doesn't use and false-flags the idmap hazard.
    const client = makeMockClient({
      version: { Version: "5.4.2", Components: [{ Name: "Podman Engine" }] },
      info: {
        Rootless: true,
        SecurityOptions: ["name=rootless"],
        DockerRootDir: "/var/lib/podman-users/synthetic/storage",
      },
    });
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(client),
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(
      result.containerStorage?.storagePath,
      "/var/lib/podman-users/synthetic/storage",
    );
    assert.equal(result.containerStorage?.fstype, "ext4");
    assert.equal(result.containerStorage?.idmapHazard, false);
  });

  it("ignores the daemon graphroot when Signal K is containerized", async () => {
    // In-container SK talks to the HOST daemon: DockerRootDir is a host
    // path, but readMounts() sees the container's mount table. Matching
    // the host path against container mounts could classify a host ZFS
    // graphroot as the container's overlay root and suppress the
    // warning — so the daemon path must be ignored and the fallback
    // (same-namespace) path probed instead.
    const client = makeMockClient({
      version: { Version: "5.4.2", Components: [{ Name: "Podman Engine" }] },
      info: {
        Rootless: true,
        SecurityOptions: ["name=rootless"],
        DockerRootDir: "/var/lib/podman-users/synthetic/storage",
      },
    });
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => true,
        resolveClient: resolveTo(client),
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(
      result.containerStorage?.storagePath,
      "/var/lib/synthetic/.local/share/containers",
    );
    assert.equal(result.containerStorage?.fstype, "zfs");
    assert.equal(result.containerStorage?.idmapHazard, true);
  });

  it("falls back to the XDG-derived path when info() lacks DockerRootDir", async () => {
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
    assert.equal(
      result.containerStorage?.storagePath,
      "/var/lib/synthetic/.local/share/containers",
    );
    assert.equal(result.containerStorage?.fstype, "zfs");
    assert.equal(result.containerStorage?.idmapHazard, true);
  });

  it("ignores a non-string DockerRootDir and uses the fallback", async () => {
    const client = makeMockClient({
      version: { Version: "5.4.2", Components: [{ Name: "Podman Engine" }] },
      info: {
        Rootless: true,
        SecurityOptions: ["name=rootless"],
        DockerRootDir: 12345,
      },
    });
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(client),
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(
      result.containerStorage?.storagePath,
      "/var/lib/synthetic/.local/share/containers",
    );
  });

  it("normalizes dot segments in DockerRootDir before mount matching", async () => {
    // A `..` segment must not defeat the prefix comparison in
    // findCoveringMount — the normalized path resolves to the ext4 root,
    // not whatever mount the raw string happens to prefix-match.
    const client = makeMockClient({
      version: { Version: "5.4.2", Components: [{ Name: "Podman Engine" }] },
      info: {
        Rootless: true,
        SecurityOptions: ["name=rootless"],
        DockerRootDir: "/var/tmp/../lib/podman-users/synthetic/storage",
      },
    });
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(client),
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () => null,
      }),
    );
    assert.equal(
      result.containerStorage?.storagePath,
      "/var/lib/podman-users/synthetic/storage",
    );
    assert.equal(result.containerStorage?.fstype, "ext4");
    assert.equal(result.containerStorage?.idmapHazard, false);
  });

  it("ignores a non-absolute DockerRootDir and uses the fallback", async () => {
    const client = makeMockClient({
      version: { Version: "5.4.2", Components: [{ Name: "Podman Engine" }] },
      info: {
        Rootless: true,
        SecurityOptions: ["name=rootless"],
        DockerRootDir: "not/an/absolute/path",
      },
    });
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        isContainerized: () => false,
        resolveClient: resolveTo(client),
        readMounts: async () => zfsHomeMounts,
        resolveContainerStoragePath: () =>
          "/var/lib/synthetic/.local/share/containers",
      }),
    );
    assert.equal(
      result.containerStorage?.storagePath,
      "/var/lib/synthetic/.local/share/containers",
    );
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

describe("selfDeployment — network DNS helper advisory (podman/netavark)", () => {
  it("netavark with aardvark-dns resolved → no advisory", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(rootlessPodman()),
        readNetworkBackendInfo: async () => ({
          backend: "netavark",
          dns: {
            version: "aardvark-dns 1.14.0",
            package: "aardvark-dns_1.14.0-3_amd64",
            path: "/usr/lib/podman/aardvark-dns",
          },
        }),
      }),
    );
    assert.equal(result.status, "ok");
    assert.deepEqual(result.networkDns, {
      backend: "netavark",
      helperPath: "/usr/lib/podman/aardvark-dns",
      dnsBroken: false,
      advice: [],
    });
  });

  it("netavark without a DNS helper → advisory, status stays ok", async () => {
    // The 2026-07 Armbian field shape: netavark installed, aardvark-dns
    // skipped by recommends-off apt. libpod info then reports a dns
    // object with no path ({"package": "Unknown"}).
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(rootlessPodman()),
        readNetworkBackendInfo: async () => ({
          backend: "netavark",
          dns: { package: "Unknown" },
        }),
      }),
    );
    assert.equal(result.status, "ok");
    assert.ok(result.networkDns);
    assert.equal(result.networkDns.dnsBroken, true);
    assert.equal(result.networkDns.helperPath, null);
    assert.ok(result.networkDns.advice.length > 0);
    assert.match(result.networkDns.advice.join("\n"), /aardvark-dns/);
    assert.match(
      result.networkDns.advice.join("\n"),
      /apt install aardvark-dns/,
    );
  });

  it("rootful podman is probed too (aardvark applies beyond rootless)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(rootfulPodman()),
        readNetworkBackendInfo: async () => ({
          backend: "netavark",
          dns: { package: "Unknown" },
        }),
      }),
    );
    assert.ok(result.networkDns);
    assert.equal(result.networkDns.dnsBroken, true);
  });

  it("CNI backend without a dns object → no advisory (dnsname plugin era)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(rootlessPodman()),
        readNetworkBackendInfo: async () => ({ backend: "cni" }),
      }),
    );
    assert.ok(result.networkDns);
    assert.equal(result.networkDns.dnsBroken, false);
    assert.deepEqual(result.networkDns.advice, []);
  });

  it("libpod info unavailable → networkDns null (no false advisory)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(rootlessPodman()),
        readNetworkBackendInfo: async () => null,
      }),
    );
    assert.equal(result.networkDns, null);
  });

  it("docker runtime → probe not consulted, networkDns null", async () => {
    let called = false;
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({
        resolveClient: resolveTo(dockerRootful()),
        readNetworkBackendInfo: async () => {
          called = true;
          return { backend: "netavark", dns: { package: "Unknown" } };
        },
      }),
    );
    assert.equal(result.networkDns, null);
    assert.equal(called, false);
  });
});

describe("selfDeployment — Podman version advisories", () => {
  /**
   * Rootful podman at an arbitrary version. The nofile defect is
   * rootless-only, so the rootful variant is the negative control for
   * the 5.5 gate.
   */
  function rootfulPodmanAt(version: string): ContainerClient {
    return makeMockClient({
      version: { Version: version, Components: [{ Name: "Podman Engine" }] },
      info: { Rootless: false, SecurityOptions: ["name=cgroupns"] },
    });
  }

  const hasNofileAdvice = (lines: string[]): boolean =>
    lines.some((l) => l.includes("older than 5.5"));
  const hasEpipeAdvice = (lines: string[]): boolean =>
    lines.some((l) => l.includes("older than 4.5"));
  const hasBaselineAdvice = (lines: string[]): boolean =>
    lines.some((l) => l.includes("older than 5.4"));

  it("rootless podman 5.4.2 → only the nofile advisory, status stays ok", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootlessPodman("5.4.2")) }),
    );
    assert.equal(result.status, "ok");
    assert.ok(hasNofileAdvice(result.remediation));
    // 5.4.2 meets the supported baseline and is above the 4.5 floor, so
    // exactly one advisory fires.
    assert.equal(hasEpipeAdvice(result.remediation), false);
    assert.equal(hasBaselineAdvice(result.remediation), false);
  });

  it("rootless podman 5.3 → baseline advisory, status stays ok", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootlessPodman("5.3.1")) }),
    );
    assert.equal(result.status, "ok");
    assert.ok(hasBaselineAdvice(result.remediation));
  });

  it("rootless podman 5.4.0 → no baseline advisory (boundary is inclusive)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootlessPodman("5.4.0")) }),
    );
    assert.equal(result.status, "ok");
    assert.equal(hasBaselineAdvice(result.remediation), false);
  });

  it("rootFUL podman 5.3 → baseline advisory (gate ignores rootless)", async () => {
    // The baseline states support/test coverage, not a rootless-only
    // defect — unlike the nofile advisory it must fire rootful too.
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootfulPodmanAt("5.3.1")) }),
    );
    assert.equal(result.status, "ok");
    assert.ok(hasBaselineAdvice(result.remediation));
    assert.equal(hasNofileAdvice(result.remediation), false);
    assert.equal(hasEpipeAdvice(result.remediation), false);
    // Wording pinned HERE and not in the rootless-5.3 case: there the
    // nofile advisory also fires and its text mentions trixie-backports,
    // which would shadow a baseline advisory that lost its own mention.
    const joined = result.remediation.join("\n");
    assert.match(joined, /trixie/);
    assert.match(joined, /5\.4\.2/);
  });

  it("rootless podman 5.5.0 → no nofile advisory (boundary is inclusive)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootlessPodman("5.5.0")) }),
    );
    assert.equal(result.status, "ok");
    assert.deepEqual(result.remediation, []);
  });

  it("rootless podman 6.0.0 → no advisory", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootlessPodman("6.0.0")) }),
    );
    assert.deepEqual(result.remediation, []);
  });

  it("rootFUL podman 5.4.2 → no nofile advisory (defect is rootless-only)", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootfulPodmanAt("5.4.2")) }),
    );
    assert.equal(result.status, "ok");
    assert.equal(hasNofileAdvice(result.remediation), false);
  });

  it("rootless podman 4.3 → all THREE advisories, each naming its own mechanism", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootlessPodman("4.3.1")) }),
    );
    assert.equal(result.status, "ok");
    assert.ok(hasBaselineAdvice(result.remediation));
    assert.ok(hasEpipeAdvice(result.remediation));
    assert.ok(hasNofileAdvice(result.remediation));
  });

  it("docker is never subject to the podman version advisories", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(dockerRootless()) }),
    );
    assert.deepEqual(result.remediation, []);
  });

  it("unparseable podman version → no advisory rather than a false positive", async () => {
    const client = makeMockClient({
      version: { Version: "unknown", Components: [{ Name: "Podman Engine" }] },
      info: { Rootless: true, SecurityOptions: ["name=rootless"] },
    });
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(client) }),
    );
    assert.deepEqual(result.remediation, []);
  });

  it("dev-suffixed version parses on its leading major.minor", async () => {
    const result = await selfDeployment(
      "auto",
      null,
      probesWith({ resolveClient: resolveTo(rootlessPodman("5.4.2-dev")) }),
    );
    assert.ok(hasNofileAdvice(result.remediation));
  });
});
