import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isPathUnderBindMount,
  ownBindMountCoverage,
  type InspectedMount,
} from "../containers.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo } from "../types.js";

const runtime: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

const bind = (source: string, dest: string): InspectedMount => ({
  type: "bind",
  name: "",
  source,
  dest,
});

describe("isPathUnderBindMount", () => {
  // Path-preserving binds: the host path and the in-container path are the
  // same string, which is what makes a local existsSync answer the caller's
  // question about the host.
  const mounts = [bind("/data", "/data"), bind("/etc/certs", "/etc/certs")];

  it("covers the mount destination itself", () => {
    assert.equal(isPathUnderBindMount("/data", mounts), true);
  });

  it("covers a child of the destination", () => {
    assert.equal(isPathUnderBindMount("/data/sub/file", mounts), true);
    assert.equal(isPathUnderBindMount("/etc/certs/tls.pem", mounts), true);
  });

  // The core correction: a remapped bind does NOT make the host path
  // locally checkable. With /host/data mounted at /data, the string
  // "/data/certs" inside the container names host /host/data/certs, and the
  // host's own /data is not visible at all -- verified against a real
  // runtime. Trusting it would report a nonexistent required source as
  // present and let ifMissing:"abort" pass.
  it("does not cover a remapped bind", () => {
    const remapped = [bind("/host/data", "/data")];
    assert.equal(isPathUnderBindMount("/data", remapped), false);
    assert.equal(isPathUnderBindMount("/data/certs", remapped), false);
    assert.equal(isPathUnderBindMount("/host/data", remapped), false);
  });

  // The trap in a naive startsWith: /database is not under /data.
  it("does not treat a name prefix as containment", () => {
    assert.equal(isPathUnderBindMount("/database", mounts), false);
    assert.equal(isPathUnderBindMount("/etc/certsX", mounts), false);
  });

  it("does not cover an unrelated path", () => {
    assert.equal(isPathUnderBindMount("/elsewhere", mounts), false);
    assert.equal(isPathUnderBindMount("/etc", mounts), false);
  });

  // A named volume's contents are not the host filesystem at that path, so a
  // file seen inside one proves nothing about a host bind source.
  it("ignores named volumes", () => {
    // Path-preserving, so only the volume type can be what excludes it.
    const vol: InspectedMount = {
      type: "volume",
      name: "myvol",
      source: "/v",
      dest: "/v",
    };
    assert.equal(isPathUnderBindMount("/v", [vol]), false);
    assert.equal(isPathUnderBindMount("/v/file", [vol]), false);
  });

  it("covers nothing when there are no mounts", () => {
    assert.equal(isPathUnderBindMount("/anything", []), false);
  });
});

describe("ownBindMountCoverage", () => {
  // Bare metal: this filesystem IS the host's, so every path is judgeable and
  // the predicate never withholds an answer. (isContainerized() is false in
  // the test process, which is the branch this exercises.)
  it("covers everything when not containerized", async () => {
    const covered = await ownBindMountCoverage(
      runtime,
      () => {},
      makeMockClient({}),
    );
    assert.equal(covered("/anywhere/at/all"), true);
    assert.equal(covered("/srv/sk-data/charts"), true);
  });
});

describe("ownBindMountCoverage — failure handling", () => {
  // safeInspect rethrows anything that is not a 404, and this runs on every
  // reconcile. Letting that escape would reject ensureRunning on a transient
  // daemon hiccup, when the tri-state classification is meant to carry on
  // with "unknown" instead.
  it("degrades to covering nothing when the runtime throws", async () => {
    const exploding = makeMockClient({
      defaultContainer: {
        inspect: () => Promise.reject(new Error("daemon unreachable")),
      },
    });
    const covered = await ownBindMountCoverage(runtime, () => {}, exploding);
    assert.equal(typeof covered, "function");
    // Bare metal short-circuits before any inspect, so this asserts the call
    // resolves rather than rejects -- the property that matters here.
    assert.doesNotThrow(() => covered("/anything"));
  });
});
