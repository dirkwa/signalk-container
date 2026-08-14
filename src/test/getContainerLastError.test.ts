import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getContainerLastError, LAST_ERROR_MAX_CHARS } from "../containers.js";
import { makeMockClient } from "./helpers/mockClient.js";

describe("getContainerLastError", () => {
  it("returns the trimmed .State.Error text", async () => {
    // Real-world shape: crun rejecting a start on a host whose hard
    // nofile ceiling is below the requested ulimit.
    const client = makeMockClient({
      containers: {
        "sk-x": {
          inspect: {
            State: {
              Status: "created",
              Error:
                "crun: setrlimit `RLIMIT_NOFILE`: Operation not permitted: OCI permission denied\n",
            },
          },
        },
      },
    });
    const result = await getContainerLastError("x", client);
    assert.equal(
      result,
      "crun: setrlimit `RLIMIT_NOFILE`: Operation not permitted: OCI permission denied",
    );
  });

  it("returns undefined when the container does not exist (inspect 404)", async () => {
    const client = makeMockClient({});
    const result = await getContainerLastError("ghost", client);
    assert.equal(result, undefined);
  });

  it("returns undefined when the runtime recorded no error (empty string)", async () => {
    // Both runtimes report Error: "" for a healthy container — that is
    // the steady state, not an error worth surfacing.
    const client = makeMockClient({
      containers: {
        "sk-x": { inspect: { State: { Status: "running", Error: "" } } },
      },
    });
    const result = await getContainerLastError("x", client);
    assert.equal(result, undefined);
  });

  it("returns undefined for whitespace-only error text", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": { inspect: { State: { Status: "created", Error: "  \n" } } },
      },
    });
    const result = await getContainerLastError("x", client);
    assert.equal(result, undefined);
  });

  it("returns undefined when State carries no Error field", async () => {
    const client = makeMockClient({
      containers: {
        "sk-x": { inspect: { State: { Status: "created" } } },
      },
    });
    const result = await getContainerLastError("x", client);
    assert.equal(result, undefined);
  });

  it("truncates runaway error text at LAST_ERROR_MAX_CHARS", async () => {
    // Some OCI failure modes embed the full runtime spec in the message.
    const long = "boom ".repeat(1000).trim();
    const client = makeMockClient({
      containers: {
        "sk-x": { inspect: { State: { Status: "created", Error: long } } },
      },
    });
    const result = await getContainerLastError("x", client);
    assert.ok(result);
    assert.equal(result.length, LAST_ERROR_MAX_CHARS + 1);
    assert.ok(result.endsWith("…"));
    assert.equal(result.slice(0, -1), long.slice(0, LAST_ERROR_MAX_CHARS));
  });

  it("prefixes the container name with sk- automatically", async () => {
    // Only the "sk-foo" key is mocked; an unprefixed lookup would 404.
    const client = makeMockClient({
      containers: {
        "sk-foo": {
          inspect: { State: { Status: "created", Error: "start failed" } },
        },
      },
    });
    const result = await getContainerLastError("foo", client);
    assert.equal(result, "start failed");
  });
});
