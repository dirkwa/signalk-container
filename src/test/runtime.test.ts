import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  detectRuntime,
  hostCpusFromInfo,
  probeHostUser,
  userMappingFlags,
  setDisableUserns,
  isDisableUserns,
  _setCurrentHostIdsForTesting,
  makeLineSplitter,
  isContainerized,
} from "../runtime.js";
import type { ContainerRuntimeInfo } from "../types.js";

// Some sandboxes (notably firejail, which the dirkwa SignalK plugin
// registry harness uses) set `container=firejail` in the test env.
// `isContainerized()` then returns true; clear it so the env-var probe
// doesn't leak into the tests that exercise it explicitly.
let savedContainer: string | undefined;
beforeEach(() => {
  savedContainer = process.env.container;
  delete process.env.container;
});
afterEach(() => {
  if (savedContainer === undefined) delete process.env.container;
  else process.env.container = savedContainer;
});

// `detectRuntime` now resolves a unix socket via `resolveClient()` and
// reads `version()`/`info()` over the dockerode client — there is no
// injectable `ExecFn` seam anymore, so the socket-classification logic
// (podman-vs-docker from `version()`, rootless from `info()`) cannot be
// unit-tested without a live daemon. It is exercised end-to-end by the
// integration suite (src/test/integration/). What we can assert here is
// the contract that holds with or without a runtime present.
describe("detectRuntime", () => {
  it("returns a runtime info object when a socket is reachable, else null", async () => {
    const result = await detectRuntime("auto");
    // If no socket answers (restricted sandbox, Windows runner), null is
    // a valid result and the function must not throw.
    if (result) {
      assert.ok(
        result.runtime === "podman" || result.runtime === "docker",
        `unexpected runtime: ${result.runtime}`,
      );
      assert.ok(typeof result.version === "string");
      assert.ok(typeof result.isPodmanDockerShim === "boolean");
    }
  });

  it("captures hostUser when a runtime is detected on a POSIX platform", async () => {
    const result = await detectRuntime("auto");
    if (!result) return;
    if (typeof process.getuid !== "function") {
      // Windows: hostUser must be null and `User` flags must be
      // suppressed downstream. detectRuntime is the source of that signal.
      assert.equal(result.hostUser, null);
      return;
    }
    assert.ok(result.hostUser);
    assert.equal(result.hostUser.uid, process.getuid());
    assert.equal(result.hostUser.gid, process.getgid!());
  });
});

describe("probeHostUser", () => {
  it("returns uid/gid from process.getuid/getgid on POSIX", () => {
    if (typeof process.getuid !== "function") {
      // Skip on Windows — covered by the null-path test below.
      return;
    }
    const result = probeHostUser();
    assert.ok(result);
    assert.equal(result.uid, process.getuid());
    assert.equal(result.gid, process.getgid!());
  });

  it("returns null when process.getuid is undefined (Windows)", () => {
    // Simulate Windows by stubbing both getters to undefined.
    const origGetuid = process.getuid;
    const origGetgid = process.getgid;
    try {
      (process as { getuid?: () => number }).getuid = undefined;
      (process as { getgid?: () => number }).getgid = undefined;
      assert.equal(probeHostUser(), null);
    } finally {
      process.getuid = origGetuid;
      process.getgid = origGetgid;
    }
  });
});

describe("userMappingFlags", () => {
  // userMappingFlags returns a dockerode createContainer payload fragment,
  // not CLI flags: `{ HostConfig: { UsernsMode } }` for rootless podman,
  // `{ User }` for docker / rootful podman, `{}` for opt-out / Windows.
  const podmanRootless: ContainerRuntimeInfo = {
    runtime: "podman",
    version: "5.4.2",
    isPodmanDockerShim: false,
    isRootless: true,
  };
  const podmanRootful: ContainerRuntimeInfo = {
    runtime: "podman",
    version: "5.4.2",
    isPodmanDockerShim: false,
    isRootless: false,
  };
  const docker: ContainerRuntimeInfo = {
    runtime: "docker",
    version: "29.5.2",
    isPodmanDockerShim: false,
  };

  const hostIds = () => ({ uid: 1000, gid: 1000 });

  it("emits keep-id UsernsMode for rootless podman, defaulting in-image to 0", () => {
    const result = userMappingFlags(podmanRootless, undefined, hostIds);
    assert.deepEqual(result, {
      HostConfig: { UsernsMode: "keep-id:uid=0,gid=0" },
    });
  });

  it("honours an explicit in-image uid/gid in the keep-id mapping", () => {
    const result = userMappingFlags(
      podmanRootless,
      { inImageUid: 1001, inImageGid: 1001 },
      hostIds,
    );
    assert.deepEqual(result, {
      HostConfig: { UsernsMode: "keep-id:uid=1001,gid=1001" },
    });
  });

  it("emits host-caller User for docker when no user declared", () => {
    const result = userMappingFlags(docker, undefined, hostIds);
    assert.deepEqual(result, { User: "1000:1000" });
  });

  it("emits in-image User for docker when a user object is declared", () => {
    const result = userMappingFlags(
      docker,
      { inImageUid: 1001, inImageGid: 1001 },
      hostIds,
    );
    assert.deepEqual(result, { User: "1001:1001" });
  });

  it("uses the User path (not keep-id) for rootful podman", () => {
    // keep-id is meaningless without a user namespace; rootful podman
    // takes the docker-shaped `User` branch.
    const result = userMappingFlags(podmanRootful, undefined, hostIds);
    assert.deepEqual(result, { User: "1000:1000" });
  });

  it("emits no mapping when user === false (opt-out)", () => {
    assert.deepEqual(userMappingFlags(podmanRootless, false, hostIds), {});
    assert.deepEqual(userMappingFlags(docker, false, hostIds), {});
  });

  it("emits no mapping when host ids are null (Windows)", () => {
    const noHost = () => null;
    assert.deepEqual(userMappingFlags(docker, undefined, noHost), {});
    assert.deepEqual(userMappingFlags(podmanRootless, undefined, noHost), {});
  });

  it("throws on a negative in-image uid", () => {
    assert.throws(
      () => userMappingFlags(podmanRootless, { inImageUid: -1 }, hostIds),
      /non-negative integer/,
    );
  });

  it("throws on a non-integer in-image gid", () => {
    assert.throws(
      () => userMappingFlags(docker, { inImageGid: 1.5 }, hostIds),
      /non-negative integer/,
    );
  });

  it("suppresses keep-id for rootless podman when userns remap is disabled", () => {
    setDisableUserns(true);
    try {
      assert.deepEqual(
        userMappingFlags(podmanRootless, undefined, hostIds),
        {},
      );
      // Docker / rootful are unaffected by the toggle.
      assert.deepEqual(userMappingFlags(docker, undefined, hostIds), {
        User: "1000:1000",
      });
    } finally {
      setDisableUserns(false);
    }
  });

  it("uses the module-level host id resolver via _setCurrentHostIdsForTesting", () => {
    _setCurrentHostIdsForTesting(() => ({ uid: 4242, gid: 4343 }));
    try {
      // No explicit resolver arg → falls back to the module-level one.
      const result = userMappingFlags(docker, undefined);
      assert.deepEqual(result, { User: "4242:4343" });
    } finally {
      _setCurrentHostIdsForTesting(null);
    }
  });
});

describe("setDisableUserns / isDisableUserns", () => {
  afterEach(() => setDisableUserns(false));

  it("defaults to false", () => {
    assert.equal(isDisableUserns(), false);
  });

  it("reflects a true toggle", () => {
    setDisableUserns(true);
    assert.equal(isDisableUserns(), true);
  });

  it("coerces non-boolean truthy input to false (strict === true gate)", () => {
    setDisableUserns(1 as unknown as boolean);
    assert.equal(isDisableUserns(), false);
  });

  it("resets back to false", () => {
    setDisableUserns(true);
    setDisableUserns(false);
    assert.equal(isDisableUserns(), false);
  });
});

describe("makeLineSplitter", () => {
  it("emits complete lines and buffers a trailing partial", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("alpha\nbeta\npartial");
    assert.deepEqual(lines, ["alpha", "beta"]);
    s.flush();
    assert.deepEqual(lines, ["alpha", "beta", "partial"]);
  });

  it("joins a line split across two chunks", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("hel");
    s.push("lo\n");
    assert.deepEqual(lines, ["hello"]);
  });

  it("treats bare \\r as a line terminator (progress repaints)", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("10%\r20%\r30%\n");
    assert.deepEqual(lines, ["10%", "20%", "30%"]);
  });

  it("handles \\r\\n without emitting empty lines", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("one\r\ntwo\r\n");
    assert.deepEqual(lines, ["one", "two"]);
  });

  it("drops empty lines", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("\n\nx\n\n");
    assert.deepEqual(lines, ["x"]);
  });

  it("flush is a no-op when the buffer is empty", () => {
    const lines: string[] = [];
    const s = makeLineSplitter((l) => lines.push(l));
    s.push("done\n");
    s.flush();
    assert.deepEqual(lines, ["done"]);
  });
});

describe("isContainerized", () => {
  it("returns true when the container env var is set", () => {
    const saved = process.env.container;
    process.env.container = "podman";
    try {
      assert.equal(isContainerized(), true);
    } finally {
      if (saved === undefined) delete process.env.container;
      else process.env.container = saved;
    }
  });

  it("returns a boolean when the container env var is absent", () => {
    // beforeEach already deletes process.env.container. The result then
    // reflects the /.dockerenv and /run/.containerenv filesystem probes,
    // which we don't control on CI; assert the contract (a boolean), not
    // a fixed value.
    delete process.env.container;
    assert.equal(typeof isContainerized(), "boolean");
  });
});

describe("hostCpusFromInfo", () => {
  it("reads NCPU from the daemon's /info", () => {
    assert.equal(hostCpusFromInfo({ NCPU: 1 }), 1);
    assert.equal(hostCpusFromInfo({ NCPU: 8 }), 8);
  });

  it("returns null when NCPU is absent or not a positive number", () => {
    assert.equal(hostCpusFromInfo({}), null);
    assert.equal(hostCpusFromInfo({ NCPU: 0 }), null);
    assert.equal(hostCpusFromInfo({ NCPU: -2 }), null);
    assert.equal(hostCpusFromInfo({ NCPU: Number.NaN }), null);
    assert.equal(hostCpusFromInfo({ NCPU: "4" as unknown as number }), null);
  });
});
