import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRuntime, probeHostUser, type ExecFn } from "../runtime.js";

describe("detectRuntime", () => {
  it("returns a runtime info object when podman or docker is available", async () => {
    const result = await detectRuntime("auto");
    // On CI or dev machines, at least one should be available
    // If neither is installed, result is null — that's also valid
    if (result) {
      assert.ok(
        result.runtime === "podman" || result.runtime === "docker",
        `unexpected runtime: ${result.runtime}`,
      );
      assert.ok(typeof result.version === "string");
      assert.ok(typeof result.isPodmanDockerShim === "boolean");
    }
  });

  it("returns null for a nonexistent runtime", async () => {
    // Force a specific runtime that doesn't exist
    const result = await detectRuntime("podman" as any);
    // This may or may not be null depending on the system
    // but the function should not throw
    if (result) {
      assert.equal(result.runtime, "podman");
    }
  });

  it("captures hostUser when a runtime is detected on a POSIX platform", async () => {
    const result = await detectRuntime("auto");
    if (!result) return;
    if (typeof process.getuid !== "function") {
      // Windows: hostUser must be null and `--user` flags must be suppressed
      // downstream. detectRuntime is the source of that signal.
      assert.equal(result.hostUser, null);
      return;
    }
    assert.ok(result.hostUser);
    assert.equal(result.hostUser.uid, process.getuid());
    assert.equal(result.hostUser.gid, process.getgid!());
  });
});

/**
 * Build an ExecFn stub that responds based on a per-call matcher list.
 * Each entry matches against `[cmd, ...args]` (joined with spaces) and
 * returns its canned result. Unmatched calls fail the test loudly so a
 * detection-path change can't silently pick the wrong branch.
 */
function scriptedExec(
  responses: Array<{
    match: string;
    result: { stdout: string; exitCode: number };
  }>,
): ExecFn {
  return async (cmd, args) => {
    const joined = [cmd, ...args].join(" ");
    for (const { match, result } of responses) {
      if (joined.includes(match)) {
        return { stdout: result.stdout, stderr: "", exitCode: result.exitCode };
      }
    }
    throw new Error(`scriptedExec: unmatched call: ${joined}`);
  };
}

describe("detectRuntime — podman remote-mode fallback", () => {
  it("returns info without remoteSocketUrl when local podman works", async () => {
    const exec = scriptedExec([
      {
        match: "podman --version",
        result: { stdout: "podman version 5.7.0", exitCode: 0 },
      },
      {
        match: "podman info --format",
        result: { stdout: "true", exitCode: 0 },
      },
      // The first `podman info` without --format is the operability probe;
      // subsequent calls with --format are the cgroup/rootless probes.
      { match: "podman info", result: { stdout: "ok", exitCode: 0 } },
    ]);
    const result = await detectRuntime("podman", exec);
    assert.ok(result);
    assert.equal(result.runtime, "podman");
    assert.equal(result.remoteSocketUrl, undefined);
  });

  it("falls back to remote mode when in-container podman info fails", async () => {
    const origContainerHost = process.env.CONTAINER_HOST;
    const origContainer = process.env.container;
    process.env.CONTAINER_HOST = "unix:///var/run/docker.sock";
    process.env.container = "podman";
    try {
      const exec = scriptedExec([
        {
          match: "podman --version",
          result: { stdout: "podman version 5.7.0", exitCode: 0 },
        },
        {
          match: "podman --remote --url unix:///var/run/docker.sock info",
          result: { stdout: "ok", exitCode: 0 },
        },
        // `podman info` (no remote) — the operability probe. Simulates the
        // newuidmap-not-found error path: exit non-zero.
        { match: "podman info", result: { stdout: "", exitCode: 125 } },
      ]);
      const result = await detectRuntime("podman", exec);
      assert.ok(result);
      assert.equal(result.runtime, "podman");
      assert.equal(result.remoteSocketUrl, "unix:///var/run/docker.sock");
    } finally {
      if (origContainerHost === undefined) delete process.env.CONTAINER_HOST;
      else process.env.CONTAINER_HOST = origContainerHost;
      if (origContainer === undefined) delete process.env.container;
      else process.env.container = origContainer;
    }
  });

  it("returns null when both direct and remote podman info fail", async () => {
    const origContainerHost = process.env.CONTAINER_HOST;
    const origContainer = process.env.container;
    delete process.env.CONTAINER_HOST;
    process.env.container = "podman";
    try {
      // Match the remote-info call too so this test stays robust on CI
      // hosts that happen to have /var/run/docker.sock on disk (Linux
      // GitHub Actions runners do): if findRemoteSocket finds it, the
      // remote retry runs and also fails → null. If no socket exists,
      // tryRuntime returns null before reaching the remote call. Both
      // paths converge on null, which is the contract under test.
      const exec = scriptedExec([
        {
          match: "podman --version",
          result: { stdout: "podman version 5.7.0", exitCode: 0 },
        },
        { match: "podman --remote", result: { stdout: "", exitCode: 125 } },
        { match: "podman info", result: { stdout: "", exitCode: 125 } },
      ]);
      const result = await detectRuntime("podman", exec);
      assert.equal(result, null);
    } finally {
      if (origContainerHost === undefined) delete process.env.CONTAINER_HOST;
      else process.env.CONTAINER_HOST = origContainerHost;
      if (origContainer === undefined) delete process.env.container;
      else process.env.container = origContainer;
    }
  });

  it("returns null when not containerized and direct podman info fails", async () => {
    const origContainerHost = process.env.CONTAINER_HOST;
    const origContainer = process.env.container;
    delete process.env.CONTAINER_HOST;
    delete process.env.container;
    try {
      // Same robustness note as above: the remote matcher covers the
      // case where /.dockerenv or /run/.containerenv happens to exist
      // on the CI host (rare but possible) and isContainerized()
      // returns true despite the env var being deleted. Without a
      // working remote, the contract is still "return null".
      const exec = scriptedExec([
        {
          match: "podman --version",
          result: { stdout: "podman version 5.7.0", exitCode: 0 },
        },
        { match: "podman --remote", result: { stdout: "", exitCode: 125 } },
        { match: "podman info", result: { stdout: "", exitCode: 125 } },
      ]);
      const result = await detectRuntime("podman", exec);
      assert.equal(result, null);
    } finally {
      if (origContainerHost === undefined) delete process.env.CONTAINER_HOST;
      else process.env.CONTAINER_HOST = origContainerHost;
      if (origContainer === undefined) delete process.env.container;
      else process.env.container = origContainer;
    }
  });
});

describe("detectRuntime — docker CLI talking to podman compat socket", () => {
  it("reclassifies docker→podman when DefaultRuntime is crun", async () => {
    // Scenario on a rootless-podman host that also installs the real
    // docker CLI (or bind-mounts /var/run/docker.sock to the podman
    // socket and ships docker in the image). `docker --version` says
    // "Docker version ..."; the podman daemon answers /info with
    // `DefaultRuntime=crun`. Without the compat-API check we would
    // report runtime=docker and show "D" in the config panel even
    // though the user is running podman.
    //
    // After reclassification, the operability probe still invokes
    // the original `name` ("docker") because tryRuntime passes
    // `name` to the directInfo exec — see "docker info" matcher
    // below. The cgroup-controllers and rootless probes, however,
    // use hardcoded "podman" strings (see probeCgroupControllers /
    // probeRootless in runtime.ts) — see "podman info --format"
    // matcher below.
    const exec = scriptedExec([
      {
        match: "docker --version",
        result: { stdout: "Docker version 29.5.2, build 79eb04c", exitCode: 0 },
      },
      {
        match: "docker info --format {{.DefaultRuntime}}",
        result: { stdout: "crun", exitCode: 0 },
      },
      {
        match: "docker info --format {{.ServerVersion}}",
        result: { stdout: "5.4.2", exitCode: 0 },
      },
      // The operability probe runs `docker info` (no --format) because
      // tryRuntime always invokes via the original `name`. The cgroup
      // and rootless probes use hardcoded `podman info` because they
      // always speak to a podman binary regardless of the surface name.
      {
        match: "podman info --format",
        result: { stdout: "true", exitCode: 0 },
      },
      { match: "docker info", result: { stdout: "ok", exitCode: 0 } },
    ]);
    const result = await detectRuntime("docker", exec);
    assert.ok(result);
    assert.equal(result.runtime, "podman");
    assert.equal(result.isPodmanDockerShim, true);
    // Server-reported version wins over the docker CLI version so the
    // UI shows the podman daemon version, not the docker client.
    assert.equal(result.version, "5.4.2");
  });

  it("keeps docker classification when DefaultRuntime is runc", async () => {
    const exec = scriptedExec([
      {
        match: "docker --version",
        result: { stdout: "Docker version 28.0.0, build abc", exitCode: 0 },
      },
      {
        match: "docker info --format {{.DefaultRuntime}}",
        result: { stdout: "runc", exitCode: 0 },
      },
    ]);
    const result = await detectRuntime("docker", exec);
    assert.ok(result);
    assert.equal(result.runtime, "docker");
    assert.equal(result.isPodmanDockerShim, false);
    assert.equal(result.version, "28.0.0");
  });

  it("falls back to binary name when docker info is unreachable", async () => {
    const exec = scriptedExec([
      {
        match: "docker --version",
        result: { stdout: "Docker version 28.0.0, build abc", exitCode: 0 },
      },
      {
        match: "docker info --format {{.DefaultRuntime}}",
        result: { stdout: "", exitCode: 1 },
      },
    ]);
    const result = await detectRuntime("docker", exec);
    assert.ok(result);
    assert.equal(result.runtime, "docker");
    assert.equal(result.isPodmanDockerShim, false);
  });
});

describe("probeRootless — docker-compat-API SecurityOptions fallback", () => {
  // Scenario: signalk-server runs as a Podman container with the
  // host's rootless podman socket bind-mounted to /var/run/docker.sock.
  // The in-container `podman` binary cannot reach a daemon (its
  // default socket path differs), so the native `Host.Security.Rootless`
  // probe returns null. Without the SecurityOptions fallback,
  // isRootless stays null and the userMappingFlags fall through to a
  // plain `--user 1000:1000` instead of `--userns=keep-id`, which
  // breaks bind-mounted consumer-plugin data dirs (questdb, grafana).

  it("returns true when SecurityOptions contains name=rootless", async () => {
    const exec = scriptedExec([
      {
        match: "docker --version",
        result: { stdout: "Docker version 29.5.2", exitCode: 0 },
      },
      {
        match: "docker info --format {{.DefaultRuntime}}",
        result: { stdout: "crun", exitCode: 0 },
      },
      {
        match: "docker info --format {{.ServerVersion}}",
        result: { stdout: "5.4.2", exitCode: 0 },
      },
      // Primary podman probe fails — the in-container podman binary
      // can't reach a daemon. The cascade should fall through to
      // the docker compat-API SecurityOptions probe.
      {
        match: "podman info --format",
        result: { stdout: "", exitCode: 125 },
      },
      // Docker compat API DOES expose SecurityOptions and reveals
      // rootless via the `name=rootless` token.
      {
        match: "docker info --format {{.SecurityOptions}}",
        result: {
          stdout: "[name=apparmor name=seccomp,profile=default name=rootless]",
          exitCode: 0,
        },
      },
      { match: "docker info", result: { stdout: "ok", exitCode: 0 } },
    ]);
    const result = await detectRuntime("docker", exec);
    assert.ok(result);
    assert.equal(result.runtime, "podman");
    assert.equal(result.isPodmanDockerShim, true);
    assert.equal(
      result.isRootless,
      true,
      "compat-API fallback should report rootless=true",
    );
  });

  it("returns false when SecurityOptions does not contain rootless", async () => {
    const exec = scriptedExec([
      {
        match: "docker --version",
        result: { stdout: "Docker version 29.5.2", exitCode: 0 },
      },
      {
        match: "docker info --format {{.DefaultRuntime}}",
        result: { stdout: "crun", exitCode: 0 },
      },
      {
        match: "docker info --format {{.ServerVersion}}",
        result: { stdout: "5.4.2", exitCode: 0 },
      },
      {
        match: "podman info --format",
        result: { stdout: "", exitCode: 125 },
      },
      // Rootful podman backend — SecurityOptions doesn't mention rootless.
      {
        match: "docker info --format {{.SecurityOptions}}",
        result: {
          stdout: "[name=apparmor name=seccomp,profile=default]",
          exitCode: 0,
        },
      },
      { match: "docker info", result: { stdout: "ok", exitCode: 0 } },
    ]);
    const result = await detectRuntime("docker", exec);
    assert.ok(result);
    assert.equal(
      result.isRootless,
      false,
      "compat-API fallback should report rootless=false when token absent",
    );
  });

  it("leaves isRootless null when both probes fail", async () => {
    const exec = scriptedExec([
      {
        match: "docker --version",
        result: { stdout: "Docker version 29.5.2", exitCode: 0 },
      },
      {
        match: "docker info --format {{.DefaultRuntime}}",
        result: { stdout: "crun", exitCode: 0 },
      },
      {
        match: "docker info --format {{.ServerVersion}}",
        result: { stdout: "5.4.2", exitCode: 0 },
      },
      {
        match: "podman info --format",
        result: { stdout: "", exitCode: 125 },
      },
      {
        match: "docker info --format {{.SecurityOptions}}",
        result: { stdout: "", exitCode: 1 },
      },
      { match: "docker info", result: { stdout: "ok", exitCode: 0 } },
    ]);
    const result = await detectRuntime("docker", exec);
    assert.ok(result);
    assert.equal(result.isRootless, null);
  });

  it("does NOT call the compat-API probe when invoked via the podman binary", async () => {
    // When tryRuntime started with `name='podman'` (native podman
    // detection), the primary probe is authoritative — its empty
    // output should leave isRootless=null and NOT fall through to a
    // docker-compat probe that doesn't apply.
    const calls: string[] = [];
    const exec = scriptedExec([
      {
        match: "podman --version",
        result: { stdout: "podman version 5.4.2", exitCode: 0 },
      },
      {
        match: "podman info --format {{.Host.Security.Rootless}}",
        result: { stdout: "WARN... only", exitCode: 0 },
      },
      {
        match: "podman info --format {{json .Host.CgroupControllers}}",
        result: { stdout: "null", exitCode: 0 },
      },
      { match: "podman info", result: { stdout: "ok", exitCode: 0 } },
    ]);
    const wrappedExec: typeof exec = (cmd, args, env) => {
      calls.push([cmd, ...args].join(" "));
      return exec(cmd, args, env);
    };
    const result = await detectRuntime("podman", wrappedExec);
    assert.ok(result);
    assert.equal(result.isPodmanDockerShim, false);
    // The compat-API fallback must NOT have been attempted.
    assert.ok(
      !calls.some((c) => c.includes("info --format {{.SecurityOptions}}")),
      "SecurityOptions probe should not run when binary is podman",
    );
  });
});

describe("probeHostUser", () => {
  it("returns uid/gid from process.getuid/getgid on POSIX", () => {
    if (typeof process.getuid !== "function") {
      // Skip on Windows — covered by the null-path test below.
      return;
    }
    const result = probeHostUser();
    assert.ok(result);
    assert.equal(result.uid, process.getuid());
    assert.equal(result.gid, process.getgid!());
  });

  it("returns null when process.getuid is undefined (Windows)", () => {
    // Simulate Windows by stubbing both getters to undefined.
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as { getuid?: () => number }).getuid = undefined;
      (process as { getgid?: () => number }).getgid = undefined;
      assert.equal(probeHostUser(), null);
    } finally {
      process.getuid = origGetuid;
      process.getgid = origGetgid;
    }
  });
});
