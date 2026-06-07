import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getContainerState } from "../containers.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const dummyRuntime: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

describe("getContainerState", () => {
  it("returns 'missing' when the container does not exist (inspect 404)", async () => {
    // No entry in `containers` and no `defaultContainer` → inspect throws
    // a 404, which the production code maps to "missing".
    const client = makeMockClient({});
    const result = await getContainerState(dummyRuntime, "ghost", client);
    assert.equal(result, "missing");
  });

  it("returns 'running' when Status=running, Running=true, Pid>0 (happy case)", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "running", Running: true, Pid: 12345 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("returns 'stopped' when Status=exited, Running=false, Pid=0", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "exited", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("returns 'running' when only Status says running (Running=false, Pid=0)", async () => {
    // Defensive: one data source is enough to trust "running".
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "running", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("returns 'running' when Status lies but Running=true (rootless podman transient state flap)", async () => {
    // This is the exact observed failure mode on Dirk's VM:
    // `State.Status` returns "stopped" for an actually-running container,
    // briefly and intermittently, under concurrent inspect load. But
    // Running=true and Pid>0 are correct. Our OR logic catches it.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "stopped", Running: true, Pid: 54321 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("returns 'running' when only Pid is positive (Running unavailable, Status wrong)", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "stopped", Running: false, Pid: 12345 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("returns 'stopped' for a genuinely stopped container with 'stopped' status", async () => {
    // Covers the path where Status is literally "stopped" (vs "exited"
    // which is the more common podman state for a clean stop). Both
    // should map to our "stopped" state.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "stopped", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("returns 'stopped' for 'created' state (container exists, never started)", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "created", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("uppercase/mixed-case Status is normalized before comparison", async () => {
    // Status is lowercased + trimmed before comparison, so a runtime that
    // reports "Running" still maps to "running".
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "Running", Running: false, Pid: 0 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "running");
  });

  it("prefixes the container name with sk- automatically", async () => {
    // Only the "sk-foo" key is mocked; an unprefixed lookup would 404.
    const client = makeMockClient({
      containers: {
        "sk-foo": {
          inspect: { State: { Status: "running", Running: true, Pid: 1 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "foo", client);
    assert.equal(result, "running");
  });

  it("does not double-prefix when the name already starts with sk-", async () => {
    const client = makeMockClient({
      containers: {
        "sk-foo": {
          inspect: { State: { Status: "running", Running: true, Pid: 1 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "sk-foo", client);
    assert.equal(result, "running");
  });

  it("returns 'stopped' for an absent State object", async () => {
    // Defensive: if inspect somehow returns no State, we don't want a
    // false "running". (false positive is worse than false negative here
    // — but note the tradeoff: ensureRunning's "already running" fast
    // path would then do a redundant start attempt, which is safe).
    const client = makeMockClient({
      containers: { "sk-x": { inspect: {} } },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("returns 'stopped' for non-numeric Pid", async () => {
    // Pid field has garbage; Status=exited, Running=false. Should be stopped.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: { Status: "exited", Running: false, Pid: "notanumber" },
          },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });

  it("negative Pid is treated as not-running", async () => {
    // Paranoid: some runtimes might use -1 to mean "no process".
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: { State: { Status: "exited", Running: false, Pid: -1 } },
        },
      },
    });
    const result = await getContainerState(dummyRuntime, "x", client);
    assert.equal(result, "stopped");
  });
});
