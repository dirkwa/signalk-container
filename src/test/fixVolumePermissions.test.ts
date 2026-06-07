import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { removeContainer } from "../containers.js";
import type { ContainerClient } from "../client.js";
import type { ContainerRuntimeInfo } from "../types.js";
import { makeMockClient } from "./helpers/mockClient.js";

const podman: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
};

const FULL_NAME = "sk-backup-server";

interface ExecCall {
  cmd: string[];
}

/**
 * Build a `ContainerClient` that drives `removeContainer` through
 * `fixVolumePermissions`: a running (or stopped) container with the given
 * bind `Mounts`, then stop + remove. `container.exec` is intercepted so the
 * find/chmod argv the production code issues can be asserted.
 *
 * @param opts.running   whether `State` reports the container as running
 * @param opts.mounts    bind-mount destinations inside the container
 * @returns the client plus the recorded exec calls and `calls` map
 */
function makeClient(opts: { running?: boolean; mounts?: string[] }): {
  client: ContainerClient;
  execCalls: ExecCall[];
  calls: Map<string, unknown[]>;
} {
  const running = opts.running ?? true;
  const mounts = opts.mounts ?? ["/signalk-data", "/host-media"];
  const execCalls: ExecCall[] = [];
  const calls = new Map<string, unknown[]>();

  const base = makeMockClient({
    containers: {
      [FULL_NAME]: {
        inspect: {
          State: {
            Status: running ? "running" : "exited",
            Running: running,
            Pid: running ? 12345 : 0,
          },
          Mounts: mounts.map((dest) => ({
            Type: "bind",
            Destination: dest,
          })),
        },
      },
    },
    calls,
  });

  // Wrap getContainer to intercept `exec` (the mock helper's stub returns
  // `{}`, which lacks the dockerode exec object shape `runExec` needs).
  const client = {
    ...base,
    getContainer(id: string) {
      const c = base.getContainer(id);
      return {
        ...c,
        exec: (execOpts: { Cmd: string[] }) => {
          execCalls.push({ cmd: [...execOpts.Cmd] });
          return Promise.resolve({
            start: () => {
              const stream = new PassThrough();
              stream.end(Buffer.from(""));
              return Promise.resolve(stream);
            },
            inspect: () => Promise.resolve({ ExitCode: 0 }),
          });
        },
      };
    },
  } as unknown as ContainerClient;

  return { client, execCalls, calls };
}

describe("fixVolumePermissions", () => {
  it("uses `find -type d` so only directory modes are widened, not files", async () => {
    const { client, execCalls, calls } = makeClient({});
    await removeContainer(podman, "backup-server", client);

    const chmodCall = execCalls.find((c) => c.cmd.includes("find"));
    assert.ok(
      chmodCall,
      `expected a find exec call; got: ${execCalls.map((c) => c.cmd.join(" ")).join(" | ")}`,
    );

    // The find invocation must restrict to directories. Without
    // `-type d`, file modes get widened blanket-style, which exposes
    // private keys, OAuth tokens, etc. in mounts that contain them.
    assert.ok(
      chmodCall.cmd.includes("-type") &&
        chmodCall.cmd[chmodCall.cmd.indexOf("-type") + 1] === "d",
      `expected -type d in find invocation; got: ${chmodCall.cmd.join(" ")}`,
    );

    // The chmod operand must be `o+rwx` (lowercase x — dirs only, no
    // X-promotion to files). Files keep their original mode.
    const chmodIdx = chmodCall.cmd.indexOf("chmod");
    assert.ok(chmodIdx > -1, "expected chmod after find -exec");
    assert.equal(
      chmodCall.cmd[chmodIdx + 1],
      "o+rwx",
      `expected chmod o+rwx (dirs); got: ${chmodCall.cmd[chmodIdx + 1]}`,
    );

    // Regression guard: must NEVER fall back to recursive `chmod -R o+rwX`.
    // That form widens file modes including SSL keys / credential files
    // that the container may have written into the bind mount.
    const recursiveChmod = execCalls.find(
      (c) => c.cmd.includes("chmod") && c.cmd.includes("-R"),
    );
    assert.equal(
      recursiveChmod,
      undefined,
      `chmod -R o+rwX must not be used (widens file modes); got: ${recursiveChmod?.cmd.join(" ")}`,
    );

    // The destructive primitive must still remove the container.
    assert.ok(calls.get("remove"), "expected the container to be removed");
  });

  it("passes every bind-mount destination as a find argument", async () => {
    const { client, execCalls } = makeClient({
      mounts: ["/signalk-data", "/host-media", "/host-mnt"],
    });
    await removeContainer(podman, "backup-server", client);

    const findCall = execCalls.find((c) => c.cmd.includes("find"));
    assert.ok(findCall, "expected find call");
    for (const mount of ["/signalk-data", "/host-media", "/host-mnt"]) {
      assert.ok(
        findCall.cmd.includes(mount),
        `expected mount ${mount} in find args; got: ${findCall.cmd.join(" ")}`,
      );
    }
  });

  it("skips the chmod entirely when the container has no bind mounts", async () => {
    const { client, execCalls, calls } = makeClient({ mounts: [] });
    await removeContainer(podman, "backup-server", client);

    const findCall = execCalls.find((c) => c.cmd.includes("find"));
    assert.equal(
      findCall,
      undefined,
      `no bind mounts ⇒ no chmod; got: ${findCall?.cmd.join(" ")}`,
    );
    assert.ok(calls.get("remove"), "expected the container to be removed");
  });

  it("skips the chmod when the container is not running", async () => {
    const { client, execCalls, calls } = makeClient({ running: false });
    await removeContainer(podman, "backup-server", client);

    const findCall = execCalls.find((c) => c.cmd.includes("find"));
    assert.equal(
      findCall,
      undefined,
      `stopped container ⇒ no chmod; got: ${findCall?.cmd.join(" ")}`,
    );
    assert.ok(calls.get("remove"), "expected the container to be removed");
  });
});
