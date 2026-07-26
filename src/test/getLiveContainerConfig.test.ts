import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLiveContainerConfig } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

type Json = Record<string, unknown>;

/**
 * Build a dockerode-style `inspect()` result from the same logical pieces the
 * CLI-era template emitted. Fields left undefined are simply omitted so the
 * subject exercises its `?? null` defaulting.
 */
function buildInspect(parts: {
  image?: string;
  cmd?: string[] | null;
  networkMode?: string;
  binds?: string[] | null;
  env?: string[] | null;
  portBindings?: Record<string, unknown> | null;
  extraHosts?: string[] | null;
  user?: string;
  devices?: Array<Record<string, unknown>> | null;
  deviceCgroupRules?: string[] | null;
  groupAdd?: string[] | null;
}): Json {
  return {
    Config: {
      Image: parts.image,
      Cmd: parts.cmd ?? null,
      Env: parts.env ?? null,
      User: parts.user,
    },
    HostConfig: {
      NetworkMode: parts.networkMode,
      Binds: parts.binds ?? null,
      PortBindings: parts.portBindings ?? null,
      ExtraHosts: parts.extraHosts ?? null,
      Devices: parts.devices ?? null,
      DeviceCgroupRules: parts.deviceCgroupRules ?? null,
      GroupAdd: parts.groupAdd ?? null,
    },
  };
}

/** A mock client whose single container ("sk-x") inspects to `inspect`. */
function clientWith(inspect: Json) {
  return makeMockClient({ defaultContainer: { inspect } });
}

describe("getLiveContainerConfig", () => {
  it("returns null when the container is missing", async () => {
    // No container registered → inspect() throws 404 → safeInspect maps to null.
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "ghost",
      makeMockClient({}),
    );
    assert.equal(result, null);
  });

  it("returns a default-filled config for a minimal inspect payload", async () => {
    // dockerode hands back parsed JSON; a payload missing Config/HostConfig
    // yields a non-null result with empty/default fields rather than null.
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith({}),
    );
    assert.ok(result);
    assert.equal(result.image, "");
    assert.equal(result.tag, "latest");
    assert.equal(result.command, null);
    assert.equal(result.networkMode, "");
    assert.equal(result.env.size, 0);
    assert.deepEqual(result.binds, []);
    assert.equal(result.portBindings.size, 0);
    assert.equal(result.extraHosts.size, 0);
    assert.equal(result.user, "");
    assert.deepEqual(result.devices, []);
    assert.deepEqual(result.deviceCgroupRules, []);
    assert.deepEqual(result.groupAdd, []);
  });

  it("splits image:tag on the LAST colon (so registry ports survive)", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "localhost:5000/my/image:v1.2.3",
          networkMode: "bridge",
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.image, "localhost:5000/my/image");
    assert.equal(result.tag, "v1.2.3");
  });

  it("defaults tag to 'latest' when image string has no tag", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "questdb/questdb",
          networkMode: "bridge",
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.image, "questdb/questdb");
    assert.equal(result.tag, "latest");
  });

  it("parses Cmd array; falls back to null when not an array", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          cmd: ["sleep", "30"],
          networkMode: "",
        }),
      ),
    );
    assert.ok(result);
    assert.deepEqual(result.command, ["sleep", "30"]);
  });

  it("treats Cmd=null as null command", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          cmd: null,
          networkMode: "",
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.command, null);
  });

  it("strips :Z suffix from podman binds", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          binds: ["/host/path:/data:Z"],
        }),
      ),
    );
    assert.ok(result);
    assert.deepEqual(result.binds, [
      { host: "/host/path", container: "/data" },
    ]);
  });

  it("strips combined :ro,Z flags from binds", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          binds: ["/host/path:/data:ro,Z"],
        }),
      ),
    );
    assert.ok(result);
    assert.deepEqual(result.binds, [
      { host: "/host/path", container: "/data" },
    ]);
  });

  it("handles named volumes (no leading slash) without flags", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          binds: ["my-volume:/data"],
        }),
      ),
    );
    assert.ok(result);
    assert.deepEqual(result.binds, [{ host: "my-volume", container: "/data" }]);
  });

  it("parses Env entries into a Map keyed by name", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          env: ["PATH=/usr/bin", "MY_FLAG=on", "COUNT=42"],
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.env.get("PATH"), "/usr/bin");
    assert.equal(result.env.get("MY_FLAG"), "on");
    assert.equal(result.env.get("COUNT"), "42");
  });

  it("preserves '=' inside env values", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          env: ["DSN=postgres://user:pw@host/db?sslmode=require"],
        }),
      ),
    );
    assert.ok(result);
    assert.equal(
      result.env.get("DSN"),
      "postgres://user:pw@host/db?sslmode=require",
    );
  });

  it("parses PortBindings into Map<port/proto, PortBinding[]>", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          portBindings: {
            "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "9000" }],
          },
        }),
      ),
    );
    assert.ok(result);
    const bindings = result.portBindings.get("9000/tcp");
    assert.ok(bindings);
    assert.deepEqual(bindings, [{ hostIp: "127.0.0.1", hostPort: 9000 }]);
  });

  it("treats null PortBindings as empty map", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          portBindings: null,
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.portBindings.size, 0);
  });

  it("preserves podman 'slirp4netns' networkMode (canonicalized later in diff)", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "slirp4netns",
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.networkMode, "slirp4netns");
  });

  it("parses a fully-loaded snapshot end-to-end", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "questdb/questdb:9.0.0",
          cmd: ["/app/bin/run.sh"],
          networkMode: "bridge",
          binds: ["/host/data:/data:Z", "my-cfg:/etc/cfg"],
          env: ["JAVA_OPTS=-Xmx2g", "TZ=UTC"],
          portBindings: {
            "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "9000" }],
            "8812/tcp": [{ HostIp: "", HostPort: "8812" }],
          },
        }),
      ),
    );
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

  it("parses an array of extraHosts into a Map<hostname, ip>", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "questdb/questdb:9.0.0",
          networkMode: "bridge",
          extraHosts: [
            "host.containers.internal:host-gateway",
            "other.host:192.168.1.50",
          ],
        }),
      ),
    );
    assert.ok(result);
    assert.equal(
      result.extraHosts.get("host.containers.internal"),
      "host-gateway",
    );
    assert.equal(result.extraHosts.get("other.host"), "192.168.1.50");
    assert.equal(result.extraHosts.size, 2);
  });

  it("returns an empty extraHosts Map when ExtraHosts is null", async () => {
    // Podman/Docker report `null` ExtraHosts when no --add-host was passed.
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "questdb/questdb:9.0.0",
          networkMode: "bridge",
          extraHosts: null,
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.extraHosts.size, 0);
  });

  it("skips extraHosts entries without a colon separator", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "questdb/questdb:9.0.0",
          networkMode: "bridge",
          extraHosts: ["bogus", "good.host:10.0.0.1"],
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.extraHosts.size, 1);
    assert.equal(result.extraHosts.get("good.host"), "10.0.0.1");
  });

  it("parses Config.User into the live user field (docker/rootful podman)", async () => {
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "questdb/questdb:9.0.0",
          networkMode: "bridge",
          user: "1000:1000",
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.user, "1000:1000");
  });

  it("parses HostConfig.Devices, defaulting a missing container path and keeping empty permissions raw", async () => {
    // Podman omits CgroupPermissions ("" here); the diff layer treats
    // that as the rwm default — the parser just reports the raw value.
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          devices: [
            {
              PathOnHost: "/dev/ttyUSB0",
              PathInContainer: "/dev/gps0",
              CgroupPermissions: "rwm",
            },
            { PathOnHost: "/dev/snd/timer", CgroupPermissions: "" },
          ],
        }),
      ),
    );
    assert.ok(result);
    assert.deepEqual(result.devices, [
      {
        pathOnHost: "/dev/ttyUSB0",
        pathInContainer: "/dev/gps0",
        cgroupPermissions: "rwm",
      },
      {
        pathOnHost: "/dev/snd/timer",
        pathInContainer: "/dev/snd/timer",
        cgroupPermissions: "",
      },
    ]);
  });

  it("parses DeviceCgroupRules and GroupAdd, defaulting null to empty arrays", async () => {
    const withValues = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "x:1",
          networkMode: "",
          deviceCgroupRules: ["c 116:* rwm", "c 13:* rwm"],
          groupAdd: ["29", "995"],
        }),
      ),
    );
    assert.ok(withValues);
    assert.deepEqual(withValues.deviceCgroupRules, [
      "c 116:* rwm",
      "c 13:* rwm",
    ]);
    assert.deepEqual(withValues.groupAdd, ["29", "995"]);

    const withNulls = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(buildInspect({ image: "x:1", networkMode: "" })),
    );
    assert.ok(withNulls);
    assert.deepEqual(withNulls.devices, []);
    assert.deepEqual(withNulls.deviceCgroupRules, []);
    assert.deepEqual(withNulls.groupAdd, []);
  });

  it("returns empty user when the container was created without --user", async () => {
    // Containers created before the ownership wiring (or with `user:false`)
    // have an empty Config.User. The diff layer is responsible for
    // deciding whether that's drift; the parser just reports the raw value.
    const result = await getLiveContainerConfig(
      dummyRuntime,
      "x",
      clientWith(
        buildInspect({
          image: "questdb/questdb:9.0.0",
          networkMode: "bridge",
          user: "",
        }),
      ),
    );
    assert.ok(result);
    assert.equal(result.user, "");
  });
});
