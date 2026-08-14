import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startContainer } from "../containers.js";
import { describeError, RAW_SNIPPET_MAX_LENGTH } from "../errors.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
};

describe("startContainer error surfacing", () => {
  it("carries the raw daemon text in the thrown message and the full raw in the cause", async () => {
    // A device-open failure crun reports with a permission phrasing. The
    // generic "permission" remediation (socket/mount permissions) is
    // misleading for it — the raw crun line is the only diagnosable part,
    // which is exactly what the composed message must carry.
    const daemonText =
      "crun: open `/dev/snd/pcmC0D0p`: Operation not permitted: OCI permission denied";
    const client = makeMockClient({
      containers: {
        "sk-questdb": { start: () => Promise.reject(new Error(daemonText)) },
      },
    });

    await assert.rejects(
      startContainer(podman, "questdb", client),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /Failed to start sk-questdb: Permission denied/);
        assert.ok(
          message.includes(daemonText),
          `message should carry the daemon text, got: ${message}`,
        );
        assert.equal(describeError(err), daemonText);
        return true;
      },
    );
  });

  it("truncates the in-message snippet but keeps the full raw reachable via describeError", async () => {
    const detail = "lower limit exceeds allowed value ".repeat(20).trim();
    const daemonText = `(HTTP code 500) server error - crun: setrlimit failed\n${detail}`;
    const client = makeMockClient({
      containers: {
        "sk-questdb": { start: () => Promise.reject(new Error(daemonText)) },
      },
    });

    await assert.rejects(
      startContainer(podman, "questdb", client),
      (err: unknown) => {
        const message = (err as Error).message;
        const collapsed = daemonText.replace(/\s+/g, " ");
        assert.ok(
          message.includes(`(${collapsed.slice(0, RAW_SNIPPET_MAX_LENGTH)}…)`),
          `message should carry the collapsed, truncated snippet, got: ${message}`,
        );
        assert.ok(!message.includes("\n"), "snippet must be single-line");
        assert.equal(describeError(err), daemonText);
        return true;
      },
    );
  });
});
