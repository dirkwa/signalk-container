import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLiveContainerConfig } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const SEP = "\x1f";

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

function buildStdout(parts: {
  image: string;
  cmd: string;
  networkMode: string;
  binds: string;
  env: string;
  portBindings: string;
  extraHosts?: string;
}): string {
  return [
    parts.image,
    parts.cmd,
    parts.networkMode,
    parts.binds,
    parts.env,
    parts.portBindings,
    parts.extraHosts ?? "null",
  ].join(SEP);
}

describe("getLiveContainerConfig", () => {
  it("returns null when inspect exits non-zero", async () => {
    const exec = fakeExec({
      stdout: "",
      stderr: "no such object",
      exitCode: 1,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "ghost", exec);
    assert.equal(result, null);
  });

  it("returns null when stdout has wrong number of sections", async () => {
    const exec = fakeExec({ stdout: `only-one-section`, exitCode: 0 });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.equal(result, null);
  });

  it("splits image:tag on the LAST colon (so registry ports survive)", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "localhost:5000/my/image:v1.2.3",
        cmd: "null",
        networkMode: "bridge",
        binds: "null",
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.image, "localhost:5000/my/image");
    assert.equal(result.tag, "v1.2.3");
  });

  it("defaults tag to 'latest' when image string has no tag", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "questdb/questdb",
        cmd: "null",
        networkMode: "bridge",
        binds: "null",
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.image, "questdb/questdb");
    assert.equal(result.tag, "latest");
  });

  it("parses Cmd array; falls back to null when not an array", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: '["sleep","30"]',
        networkMode: "",
        binds: "null",
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.deepEqual(result.command, ["sleep", "30"]);
  });

  it("treats Cmd=null as null command", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "",
        binds: "null",
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.command, null);
  });

  it("strips :Z suffix from podman binds", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "",
        binds: '["/host/path:/data:Z"]',
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.deepEqual(result.binds, [
      { host: "/host/path", container: "/data" },
    ]);
  });

  it("strips combined :ro,Z flags from binds", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "",
        binds: '["/host/path:/data:ro,Z"]',
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.deepEqual(result.binds, [
      { host: "/host/path", container: "/data" },
    ]);
  });

  it("handles named volumes (no leading slash) without flags", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "",
        binds: '["my-volume:/data"]',
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.deepEqual(result.binds, [{ host: "my-volume", container: "/data" }]);
  });

  it("parses Env entries into a Map keyed by name", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "",
        binds: "null",
        env: '["PATH=/usr/bin","MY_FLAG=on","COUNT=42"]',
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.env.get("PATH"), "/usr/bin");
    assert.equal(result.env.get("MY_FLAG"), "on");
    assert.equal(result.env.get("COUNT"), "42");
  });

  it("preserves '=' inside env values", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "",
        binds: "null",
        env: '["DSN=postgres://user:pw@host/db?sslmode=require"]',
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(
      result.env.get("DSN"),
      "postgres://user:pw@host/db?sslmode=require",
    );
  });

  it("parses PortBindings into Map<port/proto, PortBinding[]>", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "",
        binds: "null",
        env: "null",
        portBindings: '{"9000/tcp":[{"HostIp":"127.0.0.1","HostPort":"9000"}]}',
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    const bindings = result.portBindings.get("9000/tcp");
    assert.ok(bindings);
    assert.deepEqual(bindings, [{ hostIp: "127.0.0.1", hostPort: 9000 }]);
  });

  it("treats null PortBindings JSON as empty map", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "",
        binds: "null",
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.portBindings.size, 0);
  });

  it("preserves podman 'slirp4netns' networkMode (canonicalized later in diff)", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "x:1",
        cmd: "null",
        networkMode: "slirp4netns",
        binds: "null",
        env: "null",
        portBindings: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.networkMode, "slirp4netns");
  });

  it("parses a fully-loaded snapshot end-to-end", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "questdb/questdb:9.0.0",
        cmd: '["/app/bin/run.sh"]',
        networkMode: "bridge",
        binds: '["/host/data:/data:Z","my-cfg:/etc/cfg"]',
        env: '["JAVA_OPTS=-Xmx2g","TZ=UTC"]',
        portBindings:
          '{"9000/tcp":[{"HostIp":"127.0.0.1","HostPort":"9000"}],"8812/tcp":[{"HostIp":"","HostPort":"8812"}]}',
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.image, "questdb/questdb");
    assert.equal(result.tag, "9.0.0");
    assert.deepEqual(result.command, ["/app/bin/run.sh"]);
    assert.equal(result.networkMode, "bridge");
    assert.deepEqual(result.binds, [
      { host: "/host/data", container: "/data" },
      { host: "my-cfg", container: "/etc/cfg" },
    ]);
    assert.equal(result.env.get("JAVA_OPTS"), "-Xmx2g");
    assert.equal(result.env.get("TZ"), "UTC");
    assert.equal(result.portBindings.size, 2);
  });

  it("parses a JSON array of extraHosts into a Map<hostname, ip>", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "questdb/questdb:9.0.0",
        cmd: "null",
        networkMode: "bridge",
        binds: "null",
        env: "null",
        portBindings: "null",
        extraHosts:
          '["host.containers.internal:host-gateway","other.host:192.168.1.50"]',
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(
      result.extraHosts.get("host.containers.internal"),
      "host-gateway",
    );
    assert.equal(result.extraHosts.get("other.host"), "192.168.1.50");
    assert.equal(result.extraHosts.size, 2);
  });

  it("returns an empty extraHosts Map when the section is JSON null", async () => {
    // Podman/Docker emit `null` (literal) when no --add-host was passed.
    const exec = fakeExec({
      stdout: buildStdout({
        image: "questdb/questdb:9.0.0",
        cmd: "null",
        networkMode: "bridge",
        binds: "null",
        env: "null",
        portBindings: "null",
        extraHosts: "null",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.extraHosts.size, 0);
  });

  it("returns an empty extraHosts Map and does not throw on malformed JSON", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "questdb/questdb:9.0.0",
        cmd: "null",
        networkMode: "bridge",
        binds: "null",
        env: "null",
        portBindings: "null",
        extraHosts: "not-json-{",
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.extraHosts.size, 0);
  });

  it("skips extraHosts entries without a colon separator", async () => {
    const exec = fakeExec({
      stdout: buildStdout({
        image: "questdb/questdb:9.0.0",
        cmd: "null",
        networkMode: "bridge",
        binds: "null",
        env: "null",
        portBindings: "null",
        extraHosts: '["bogus","good.host:10.0.0.1"]',
      }),
      exitCode: 0,
    });
    const result = await getLiveContainerConfig(dummyRuntime, "x", exec);
    assert.ok(result);
    assert.equal(result.extraHosts.size, 1);
    assert.equal(result.extraHosts.get("good.host"), "10.0.0.1");
  });
});
