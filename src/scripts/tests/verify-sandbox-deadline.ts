/**
 * Manual adversarial crash check. Needs SANDBOX_TEST_IMAGE (local trusted digest).
 * Runs the manager in a child, kills it after stdin is submitted, and observes
 * the still-running container independently. Never changes other containers.
 */
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getClient, type ContainerClient } from "../../client.js";
import { detectRuntime } from "../../runtime.js";
import { SandboxExecutor } from "../../sandbox-executor.js";
import { setNamespace } from "../../namespace.js";

const image = process.env.SANDBOX_TEST_IMAGE;
assert.ok(
  image,
  "SANDBOX_TEST_IMAGE must name a trusted, locally installed digest",
);
assert.ok(await detectRuntime("auto"), "No runtime");
const client = getClient();
if (process.argv.includes("--child")) {
  setNamespace("sandboxdeadline");
  const wrapped: ContainerClient = Object.create(client);
  let containerId = "";
  wrapped.createContainer = async (options) => {
    const container = await client.createContainer(options);
    containerId = container.id;
    return container;
  };
  wrapped.modem = Object.create(client.modem);
  wrapped.modem.dial = (options, callback) =>
    client.modem.dial!(options, (error, value) => {
      if (options.path.includes("/attach") && value instanceof Duplex)
        value.once("finish", () => process.send?.({ id: containerId }));
      callback(error, value);
    });
  const result = await new SandboxExecutor(wrapped).run({
    ownerPluginId: "sandbox-deadline-test",
    image,
    runnerPath: "/usr/local/bin/node",
    stdin: Buffer.from(`
      const fs = require("node:fs"), cp = require("node:child_process");
      try { fs.openSync("/proc/1/mem","w"); process.exit(91); } catch {}
      // PID namespace init must survive stop/kill from a descendant.
      process.kill(1,"SIGSTOP"); process.kill(1,"SIGKILL");
      cp.spawn(process.execPath,["-e","while(true){}"],{detached:true,stdio:"ignore"}).unref();
      while(true){}
    `),
  });
  console.error("Manager returned before crash:", result.status);
  process.exit(1);
} else {
  const child = fork(fileURLToPath(import.meta.url), ["--child"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let id: string | undefined;
  try {
    id = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Job was not submitted")),
        8000,
      );
      child.once("message", (message) => {
        clearTimeout(timer);
        if (
          typeof message === "object" &&
          message &&
          "id" in message &&
          typeof message.id === "string"
        )
          resolve(message.id);
        else reject(new Error("Invalid child report"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Manager exited before submission"));
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const container = client.getContainer(id);
    const before = await container.inspect();
    assert.equal(
      before.State.Running,
      true,
      "Job should outlive the crashed manager briefly",
    );
    const completed = await container.wait({
      ...{ abortSignal: AbortSignal.timeout(20_000) },
    });
    const after = await container.inspect();
    const elapsed =
      Date.parse(after.State.FinishedAt) - Date.parse(after.State.StartedAt);
    assert.equal(completed.StatusCode, 137);
    assert.equal(after.State.Running, false);
    assert.equal(after.State.OOMKilled, false);
    assert.ok(
      elapsed >= 14_000 && elapsed < 18_000,
      `Deadline elapsed ${elapsed}ms`,
    );
    console.log(
      `PASS: manager SIGKILL; hostile job and detached descendants stopped after ${elapsed}ms (exit 137, no OOM).`,
    );
  } finally {
    child.kill("SIGKILL");
    if (id) await client.getContainer(id).remove({ force: true, v: true });
  }
}
