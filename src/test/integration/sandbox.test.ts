import { it } from "node:test";
import assert from "node:assert/strict";
import { getClient, type ContainerClient } from "../../client.js";
import { detectRuntime } from "../../runtime.js";
import { SandboxExecutor } from "../../sandbox-executor.js";
import type { SandboxJobRequest } from "../../types.js";

async function hasContainerRuntime() {
  if (process.platform === "win32") return null;
  return detectRuntime("auto");
}
// Explicit opt-in: never pull or execute a caller-selected image in portable CI.
const image = process.env.SANDBOX_TEST_IMAGE;
const runtime = image ? await hasContainerRuntime() : null;
const skip =
  !image || !runtime
    ? "Set SANDBOX_TEST_IMAGE to a local trusted digest on a supported Linux runtime"
    : false;
function request(code: string): SandboxJobRequest {
  return {
    ownerPluginId: "sandbox-integration",
    image: image!,
    runnerPath: "/usr/local/bin/node",
    stdin: Buffer.from(code),
  };
}
it("executes after live preflight and confirms removal", { skip }, async () => {
  const result = await new SandboxExecutor().run(request("console.log(1+1)"));
  assert.equal(result.status, "completed");
  assert.equal(Buffer.from(result.output).toString(), "2\n");
  assert.equal(result.cleanup, "removed");
});
it(
  "denies networking, root writes, supervisor access and excess tmpfs writes",
  { skip },
  async () => {
    const result = await new SandboxExecutor().run(
      request(`
    const fs = require("node:fs"), assert = require("node:assert/strict");
    assert.throws(() => fs.openSync("/proc/1/mem", "w"));
    assert.throws(() => fs.writeFileSync("/outside-tmp", "x"));
    assert.throws(() => fs.writeFileSync("/dev/shm/escape", "x"));
    assert.throws(() => fs.writeFileSync("/tmp/too-big", Buffer.alloc(17*1024*1024)), {code:"ENOSPC"});
    const net = require("node:net");
    const socket = net.connect({host:"127.0.0.1",port:9});
    socket.on("error", e => {assert.equal(e.code,"EPERM"); console.log("denied");});
  `),
    );
    assert.equal(
      result.status,
      "completed",
      Buffer.from(result.output).toString(),
    );
    assert.equal(Buffer.from(result.output).toString(), "denied\n");
  },
);
it(
  "terminates newline-free output at the shared byte ceiling",
  { skip },
  async () => {
    const result = await new SandboxExecutor().run(
      request(
        "process.stdout.write(Buffer.alloc(512*1024,65)); setInterval(()=>{},1000)",
      ),
    );
    assert.equal(result.status, "output-limit");
    assert.equal(result.output.length, 256 * 1024);
    assert.equal(result.cleanup, "removed");
  },
);
it(
  "cancels an active job and refuses parallel execution",
  { skip },
  async () => {
    const executor = new SandboxExecutor(),
      controller = new AbortController();
    const running = executor.run(
      request("setInterval(()=>{},1000)"),
      controller.signal,
    );
    const parallel = await executor.run(request("console.log(1)"));
    assert.equal(parallel.status, "busy");
    setTimeout(() => controller.abort(), 500);
    assert.equal((await running).status, "cancelled");
  },
);
it(
  "withholds code when a requested cgroup limit is not applied",
  { skip },
  async () => {
    const client = getClient();
    const weakened: ContainerClient = Object.create(client);
    weakened.createContainer = (options) =>
      client.createContainer({
        ...options,
        HostConfig: {
          ...options.HostConfig,
          Memory: 512 * 1024 * 1024,
          MemorySwap: 512 * 1024 * 1024,
        },
      });
    const result = await new SandboxExecutor(weakened).run(
      request('console.log("CODE WAS RELEASED")'),
    );
    assert.equal(result.status, "isolation-unavailable");
    assert.equal(result.output.length, 0);
    assert.equal(result.cleanup, "removed");
  },
);

it(
  "records OOM evidence from a kernel-enforced memory limit",
  { skip },
  async () => {
    const result = await new SandboxExecutor().run(
      request('Buffer.alloc(512*1024*1024,1); console.log("unexpected")'),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.oomKilled, true);
    assert.equal(result.cleanup, "removed");
  },
);
it(
  "enforces the process ceiling and leaves no state for the next job",
  { skip },
  async () => {
    const executor = new SandboxExecutor();
    const first = await executor.run(
      request(`
    const cp=require("node:child_process"),fs=require("node:fs");
    let denied=0;
    const children=[];
    const done=[];
    for(let i=0;i<40;i++) {
      const child=cp.spawn("/bin/sleep",["2"]);
      children.push(child);
      done.push(new Promise(resolve=>{
        child.once("error",e=>{if(e.code==="EAGAIN")denied++;resolve();});
        child.once("exit",resolve);
      }));
    }
    Promise.all(done).then(()=>{
      require("node:assert/strict").ok(denied>0);
      fs.writeFileSync("/tmp/sentinel","private");
      console.log("limited");
    });
  `),
    );
    assert.equal(
      first.status,
      "completed",
      Buffer.from(first.output).toString(),
    );
    assert.equal(Buffer.from(first.output).toString(), "limited\n");
    const second = await executor.run(
      request('console.log(require("node:fs").existsSync("/tmp/sentinel"))'),
    );
    assert.equal(second.status, "completed");
    assert.equal(Buffer.from(second.output).toString(), "false\n");
  },
);
it(
  "refuses new execution until an uncertain removal is confirmed",
  { skip },
  async () => {
    const client = getClient(),
      wrapped: ContainerClient = Object.create(client);
    let failRemoval = true,
      creates = 0;
    wrapped.createContainer = async (options) => {
      creates++;
      const container = await client.createContainer(options),
        remove = container.remove.bind(container);
      container.remove = async (options) => {
        if (failRemoval) throw new Error("offline");
        return remove(options);
      };
      return container;
    };
    const executor = new SandboxExecutor(wrapped);
    try {
      const first = await executor.run(request('console.log("done")'));
      assert.equal(first.status, "completed");
      assert.equal(first.cleanup, "pending");
      const second = await executor.run(request('console.log("must not run")'));
      assert.equal(second.status, "isolation-unavailable");
      assert.equal(creates, 1);
    } finally {
      failRemoval = false;
    }
    const recovered = await executor.run(request('console.log("recovered")'));
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.cleanup, "removed");
    assert.equal(creates, 2);
  },
);

it(
  "delivers exact input through repeated handshakes and a large stdin write",
  { skip },
  async () => {
    for (let i = 0; i < 6; i++) {
      const code =
        (i === 5 ? "//" + "x".repeat(900 * 1024) + "\n" : "") +
        'console.log("exact-input")';
      const result = await new SandboxExecutor().run(request(code));
      assert.equal(
        result.status,
        "completed",
        Buffer.from(result.output).toString(),
      );
      assert.equal(Buffer.from(result.output).toString(), "exact-input\n");
    }
  },
);
