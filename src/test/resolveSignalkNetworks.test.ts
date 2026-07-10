import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveSignalkNetworks } from "../containers.js";
import { makeMockClient } from "./helpers/mockClient.js";
import type { ContainerRuntimeInfo } from "../types.js";

// resolveSignalkNetworks classifies the SignalK container's own networking
// for the signalkAccessiblePorts strategy: `null` = bare-metal semantics
// (publish on 127.0.0.1), `[]` = default bridge only (netns-join fallback),
// `string[]` = user-defined networks to attach to. A host-networked SignalK
// container must classify as bare-metal, NOT as "bridge only" — the netns
// join is wrong there and on Docker the create is rejected outright (#188).

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

const SELF_ID = "issue188-signalk";

function selfInspect(
  networkMode: string,
  networks: Record<string, object>,
): Record<string, unknown> {
  return {
    Id: SELF_ID,
    HostConfig: { NetworkMode: networkMode },
    NetworkSettings: { Networks: networks },
  };
}

// Force isContainerized() true and pin self-id detection to the env
// override so no cgroup/mountinfo parsing runs on the test host.
let savedContainer: string | undefined;
let savedSelfId: string | undefined;
beforeEach(() => {
  savedContainer = process.env.container;
  savedSelfId = process.env.SIGNALK_CONTAINER_ID;
  process.env.container = "oci";
  process.env.SIGNALK_CONTAINER_ID = SELF_ID;
});
afterEach(() => {
  if (savedContainer === undefined) delete process.env.container;
  else process.env.container = savedContainer;
  if (savedSelfId === undefined) delete process.env.SIGNALK_CONTAINER_ID;
  else process.env.SIGNALK_CONTAINER_ID = savedSelfId;
});

describe("resolveSignalkNetworks", () => {
  it("returns null when SignalK itself is host-networked", async () => {
    const client = makeMockClient({
      containers: {
        [SELF_ID]: { inspect: selfInspect("host", { host: {} }) },
      },
    });
    const result = await resolveSignalkNetworks(docker, () => {}, client);
    assert.equal(result, null);
  });

  it("returns [] when SignalK is only on the default bridge", async () => {
    const client = makeMockClient({
      containers: {
        [SELF_ID]: { inspect: selfInspect("bridge", { bridge: {} }) },
      },
    });
    const result = await resolveSignalkNetworks(docker, () => {}, client);
    assert.deepEqual(result, []);
  });

  it("returns user-defined network names", async () => {
    const client = makeMockClient({
      containers: {
        [SELF_ID]: {
          inspect: selfInspect("marine_default", { marine_default: {} }),
        },
      },
    });
    const result = await resolveSignalkNetworks(docker, () => {}, client);
    assert.deepEqual(result, ["marine_default"]);
  });

  it("drops default networks but keeps user-defined ones on mixed attachment", async () => {
    const client = makeMockClient({
      containers: {
        [SELF_ID]: {
          inspect: selfInspect("bridge", { bridge: {}, marine_default: {} }),
        },
      },
    });
    const result = await resolveSignalkNetworks(docker, () => {}, client);
    assert.deepEqual(result, ["marine_default"]);
  });

  it("returns null when the self-container inspect fails", async () => {
    const client = makeMockClient({});
    const result = await resolveSignalkNetworks(docker, () => {}, client);
    assert.equal(result, null);
  });
});
