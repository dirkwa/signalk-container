import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  prepareSandboxJob,
  SandboxOutput,
  SANDBOX_LIMITS,
} from "../sandbox.js";
import {
  setNamespace,
  resetNamespace,
  jobMarkerLabel,
  jobOwnerLabel,
} from "../namespace.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { SandboxJobRequest } from "../types.js";

const image = `ghcr.io/example/worker@sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;
const runnerPath = "/usr/local/bin/sandbox-runner";
const imageInfo = { Id: imageId, RepoDigests: [image], Config: {} };

function request(): SandboxJobRequest {
  return {
    image,
    ownerPluginId: "signalk-mcp",
    runnerPath,
    stdin: Buffer.from('{"code":"1+1"}'),
  };
}

function clientFor(info: Record<string, unknown> = imageInfo) {
  return makeMockClient({ images: { [image]: info } });
}

describe("sandbox preparation", () => {
  it("prepares a non-networked non-root plan without executing anything", async () => {
    const calls = new Map<string, unknown[]>();
    const client = makeMockClient({ images: { [image]: imageInfo }, calls });
    const plan = await prepareSandboxJob(request(), client);
    assert.deepEqual([...calls.keys()], []);
    assert.equal(plan.options.Image, imageId);
    assert.deepEqual(plan.options.Entrypoint, [runnerPath]);
    assert.deepEqual(plan.options.Cmd, []);
    assert.equal(plan.options.User, "65534:65534");
    assert.equal(plan.options.NetworkDisabled, true);
    assert.equal(plan.options.Tty, false);
    assert.equal(plan.options.OpenStdin, true);
    assert.deepEqual(plan.options.Healthcheck, { Test: ["NONE"] });
    const host = plan.options.HostConfig!;
    assert.equal(host.NetworkMode, "none");
    assert.equal(host.ReadonlyRootfs, true);
    assert.equal(host.Privileged, false);
    assert.deepEqual(host.CapDrop, ["ALL"]);
    assert.deepEqual(host.CapAdd, []);
    assert.deepEqual(host.SecurityOpt, ["no-new-privileges"]);
    assert.deepEqual(host.Binds, []);
    assert.deepEqual(host.Mounts, []);
    assert.deepEqual(host.Devices, []);
    assert.deepEqual(host.DeviceRequests, []);
    assert.deepEqual(host.PortBindings, {});
    assert.deepEqual(host.ExtraHosts, []);
    assert.equal(host.PublishAllPorts, false);
    assert.equal(host.IpcMode, "private");
    assert.equal(host.PidMode, "");
    assert.deepEqual(host.RestartPolicy, { Name: "no" });
    assert.deepEqual(host.LogConfig, { Type: "none", Config: {} });
    assert.equal(host.AutoRemove, false);
    assert.equal(host.Memory, SANDBOX_LIMITS.memoryBytes);
    assert.equal(host.MemorySwap, host.Memory);
    assert.equal(host.CpuQuota! / host.CpuPeriod!, 0.5);
    assert.equal(host.PidsLimit, SANDBOX_LIMITS.pids);
    assert.equal(host.ShmSize, SANDBOX_LIMITS.temporaryBytes);
    assert.equal(
      host.Tmpfs?.["/tmp"],
      `rw,noexec,nosuid,nodev,size=${SANDBOX_LIMITS.temporaryBytes},mode=1777`,
    );
  });

  it("never serializes input into daemon creation metadata", async () => {
    const req = request();
    req.stdin = Buffer.from("private-code-and-input");
    const plan = await prepareSandboxJob(req, clientFor());
    assert.equal(
      JSON.stringify(plan.options).includes("private-code-and-input"),
      false,
    );
    assert.equal(plan.stdin.toString(), "private-code-and-input");
    assert.deepEqual(plan.options.Env, ["HOME=/tmp", "TMPDIR=/tmp"]);
  });

  it("uses unique names and namespace-aware ownership labels", async () => {
    setNamespace("sandboxdev");
    try {
      const a = await prepareSandboxJob(request(), clientFor());
      const b = await prepareSandboxJob(request(), clientFor());
      assert.notEqual(a.id, b.id);
      assert.equal(a.options.name, `sandboxdev-job-sandbox-${a.id}`);
      assert.equal(a.options.Labels?.[jobMarkerLabel()], "true");
      assert.equal(a.options.Labels?.[jobOwnerLabel()], "signalk-mcp");
      assert.equal(a.options.Labels?.["sk-job-owner"], undefined);
    } finally {
      resetNamespace();
    }
  });

  for (const field of [
    "networkMode",
    "volumes",
    "env",
    "command",
    "resources",
    "securityOpt",
    "privileged",
  ]) {
    it(`rejects injected ${field} instead of silently ignoring it`, async () => {
      await assert.rejects(
        prepareSandboxJob({ ...request(), [field]: "override" }, clientFor()),
        /Unsupported/,
      );
    });
  }

  for (const badImage of [
    "alpine:latest",
    "example/worker@sha256:" + "a".repeat(64),
    "ghcr.io/example/worker:latest",
    "worker@sha256:" + "a".repeat(64),
    image + "x",
  ]) {
    it(`rejects an unpinned or malformed image: ${badImage}`, async () => {
      await assert.rejects(
        prepareSandboxJob({ ...request(), image: badImage }, clientFor()),
        /digest-pinned/,
      );
    });
  }

  it("does not pull a missing image or create a container", async () => {
    const calls = new Map<string, unknown[]>();
    await assert.rejects(
      prepareSandboxJob(request(), makeMockClient({ calls })),
      /no such image/,
    );
    assert.deepEqual([...calls.keys()], []);
  });

  for (const info of [
    { ...imageInfo, RepoDigests: [] },
    { ...imageInfo, RepoDigests: [image.replace("a", "c")] },
    { ...imageInfo, Id: "unverified" },
    { ...imageInfo, Config: null },
    { ...imageInfo, Config: { Volumes: { "/data": {} } } },
    { ...imageInfo, Config: { Volumes: [] } },
  ]) {
    it("refuses missing/mismatched image evidence or declared volumes", async () => {
      await assert.rejects(prepareSandboxJob(request(), clientFor(info)));
    });
  }

  for (const path of [
    "sh -c",
    "/bin/../bin/sh",
    "/",
    "/tmp/.",
    "/tmp/..",
    "/bin/sh\n",
  ]) {
    it(`rejects invalid runner path ${JSON.stringify(path)}`, async () => {
      await assert.rejects(
        prepareSandboxJob({ ...request(), runnerPath: path }, clientFor()),
        /runnerPath/,
      );
    });
  }

  it("requires a bounded owner identity", async () => {
    for (const ownerPluginId of ["", "x".repeat(215), "a\nb"]) {
      await assert.rejects(
        prepareSandboxJob({ ...request(), ownerPluginId }, clientFor()),
        /ownerPluginId/,
      );
    }
    await prepareSandboxJob(
      { ...request(), ownerPluginId: "@example/worker" },
      clientFor(),
    );
  });

  it("enforces input byte limits before touching the runtime", async () => {
    const client = clientFor();
    let inspected = false;
    client.getImage = () => {
      inspected = true;
      throw new Error("unexpected inspection");
    };
    await assert.rejects(
      prepareSandboxJob(
        { ...request(), stdin: Buffer.alloc(SANDBOX_LIMITS.inputBytes + 1) },
        client,
      ),
      /input limit/,
    );
    assert.equal(inspected, false);
    await prepareSandboxJob(
      { ...request(), stdin: Buffer.alloc(SANDBOX_LIMITS.inputBytes) },
      clientFor(),
    );
  });

  it("rejects shared input memory", async () => {
    await assert.rejects(
      prepareSandboxJob(
        { ...request(), stdin: new Uint8Array(new SharedArrayBuffer(10)) },
        clientFor(),
      ),
      /private bytes/,
    );
  });

  it("snapshots input and image selection before an asynchronous inspection", async () => {
    const req = request();
    const original = Buffer.from(req.stdin);
    const pending = prepareSandboxJob(req, clientFor());
    req.stdin.fill(0);
    req.image = "different:latest";
    req.runnerPath = "/different";
    const plan = await pending;
    assert.deepEqual(plan.stdin, original);
    assert.equal(plan.image, image);
    assert.deepEqual(plan.options.Entrypoint, [runnerPath]);
  });
});

describe("sandbox output byte budget", () => {
  it("bounds a single huge unterminated write and stops accepting data", () => {
    const output = new SandboxOutput(8);
    assert.equal(output.append(Buffer.alloc(1024 * 1024, 65)), false);
    assert.equal(output.exceeded, true);
    assert.equal(output.snapshot().toString(), "AAAAAAAA");
    assert.equal(output.append(Buffer.from("more")), false);
    assert.equal(output.snapshot().length, 8);
  });

  it("shares one budget across arbitrary stdout/stderr chunks", () => {
    const output = new SandboxOutput(8);
    assert.equal(output.append(Buffer.from("stdout")), true);
    assert.equal(output.append(Buffer.from("er")), true);
    assert.equal(output.exceeded, false);
    assert.equal(output.append(Buffer.from("r")), false);
    assert.equal(output.snapshot().toString(), "stdouter");
  });

  it("counts UTF-8 bytes rather than characters", () => {
    const output = new SandboxOutput(3);
    assert.equal(output.append(Buffer.from("éé")), false);
    assert.deepEqual(output.snapshot(), Buffer.from("éé").subarray(0, 3));
  });

  it("copies retained input chunks and returned snapshots", () => {
    const output = new SandboxOutput(8);
    const chunk = Buffer.from("abc");
    output.append(chunk);
    chunk.fill(0);
    const snapshot = output.snapshot();
    snapshot.fill(0);
    assert.equal(output.snapshot().toString(), "abc");
  });

  it("clearing output does not replenish the lifetime budget", () => {
    const output = new SandboxOutput(8);
    output.append(Buffer.from("abc"));
    output.clear();
    assert.equal(output.snapshot().length, 0);
    assert.equal(output.append(Buffer.from("def")), false);
  });

  for (const limit of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    SANDBOX_LIMITS.outputBytes + 1,
  ]) {
    it(`refuses invalid capacity ${limit}`, () => {
      assert.throws(() => new SandboxOutput(limit), /Invalid/);
    });
  }
});
