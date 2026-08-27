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
  const mounts = [bind("/host/data", "/data"), bind("/host/etc", "/etc/certs")];

  it("covers the mount destination itself", () => {
    assert.equal(isPathUnderBindMount("/data", mounts), true);
  });

  it("covers a child of the destination", () => {
    assert.equal(isPathUnderBindMount("/data/sub/file", mounts), true);
    assert.equal(isPathUnderBindMount("/etc/certs/tls.pem", mounts), true);
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
    const vol: InspectedMount = {
      type: "volume",
      name: "myvol",
      source: "/var/lib/docker/volumes/myvol/_data",
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
