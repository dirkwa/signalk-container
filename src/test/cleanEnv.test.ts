import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _setPathExistsForTesting, cleanEnv } from "../runtime.js";

/**
 * Mutate `process.env` (and optionally `process.getuid`) around a
 * single test, restoring everything regardless of outcome. Mirrors
 * the `withEnv` helper in selfDeployment.test.ts but also handles
 * deleting keys.
 */
function withProcessEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
  uid?: number | "remove",
  pathExistsStub?: (path: string) => boolean,
): T {
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) savedEnv[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const savedGetUid = process.getuid;
  if (uid === "remove") {
    delete (process as { getuid?: unknown }).getuid;
  } else if (typeof uid === "number") {
    (process as { getuid: () => number }).getuid = () => uid;
  }
  if (pathExistsStub) _setPathExistsForTesting(pathExistsStub);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    (process as { getuid?: () => number }).getuid = savedGetUid;
    if (pathExistsStub) _setPathExistsForTesting(null);
  }
}

describe("cleanEnv", () => {
  it("strips LISTEN_* keys (systemd socket-activation leftovers)", () => {
    withProcessEnv(
      {
        LISTEN_FDS: "1",
        LISTEN_PID: "1234",
        LISTEN_FDNAMES: "signalk.socket",
        UNRELATED: "kept",
      },
      () => {
        const env = cleanEnv();
        assert.equal(env.LISTEN_FDS, undefined);
        assert.equal(env.LISTEN_PID, undefined);
        assert.equal(env.LISTEN_FDNAMES, undefined);
        assert.equal(env.UNRELATED, "kept");
      },
    );
  });

  it("backfills XDG_RUNTIME_DIR from process.getuid() when missing AND /run/user/<uid> exists", () => {
    // Reproduces the Signal-K-as-system-service case: systemd starts
    // SK under `User=signalk` but does NOT propagate the user's
    // XDG_RUNTIME_DIR. Without backfill, every podman invocation
    // can't find its rootless socket and returns ambiguous info.
    withProcessEnv(
      { XDG_RUNTIME_DIR: undefined },
      () => {
        const env = cleanEnv();
        assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1011");
      },
      1011,
      () => true,
    );
  });

  it("does not backfill XDG_RUNTIME_DIR when /run/user/<uid> is absent", () => {
    // Universal-installer in-container topology: only the host
    // docker socket is bind-mounted; `/run/user` does not exist
    // inside the container. A backfill that points at a missing
    // directory breaks `podman --remote --url <socket> info` —
    // podman lstat's XDG_RUNTIME_DIR at startup before honouring
    // `--url`, so the docker-shim promotion path stays on the
    // docker binary and consumer plugins emitting podman flags
    // like `--userns=keep-id:uid=X,gid=Y` fail at the docker CLI.
    withProcessEnv(
      { XDG_RUNTIME_DIR: undefined },
      () => {
        const env = cleanEnv();
        assert.equal(env.XDG_RUNTIME_DIR, undefined);
      },
      1011,
      () => false,
    );
  });

  it("does not override XDG_RUNTIME_DIR when it was already set", () => {
    // Bare-metal / user-scope-service / interactive invocations
    // already have it. Leave whatever the operator (or systemd
    // user manager) configured.
    withProcessEnv(
      { XDG_RUNTIME_DIR: "/custom/runtime" },
      () => {
        const env = cleanEnv();
        assert.equal(env.XDG_RUNTIME_DIR, "/custom/runtime");
      },
      1011,
      () => false,
    );
  });

  it("does not backfill on platforms without process.getuid (Windows)", () => {
    // Windows has no UID concept; process.getuid is undefined.
    // Backfilling `/run/user/...` would point at a path that's
    // meaningless on Windows AND would surface as a real env var
    // to the spawned podman process, confusing it. Leave it alone.
    withProcessEnv(
      { XDG_RUNTIME_DIR: undefined },
      () => {
        const env = cleanEnv();
        assert.equal(env.XDG_RUNTIME_DIR, undefined);
      },
      "remove",
    );
  });
});
