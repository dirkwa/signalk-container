import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { libpodRootless, type ContainerClient } from "../client.js";
import { _setInfoRetryDelayForTesting, probeDaemon } from "../runtime.js";

/**
 * The rootless reading decides every managed container's user mapping, so a
 * read that fails while podman is busy must not leave it unknown when the
 * daemon could still answer.
 */

type ProbeClient = Pick<ContainerClient, "info" | "modem">;

/** A client whose `/info` fails `failures` times before answering `info`, and
 *  whose `/libpod/info` answers `libpod` (an error when null). */
function client(
  failures: number,
  info: unknown,
  libpod: unknown = null,
): { client: ProbeClient; infoCalls: () => number; dialCalls: () => number } {
  let infoCalls = 0;
  let dialCalls = 0;
  return {
    client: {
      info: () => {
        infoCalls++;
        return infoCalls <= failures
          ? Promise.reject(new Error("socket hang up"))
          : Promise.resolve(info);
      },
      modem: {
        dial: (_opts, cb) => {
          dialCalls++;
          if (libpod === null) cb(new Error("socket gone"), null);
          else cb(null, libpod);
        },
        followProgress: () => {},
        demuxStream: () => {},
      },
    },
    infoCalls: () => infoCalls,
    dialCalls: () => dialCalls,
  };
}

const ALWAYS = Number.MAX_SAFE_INTEGER;

describe("probeDaemon", () => {
  beforeEach(() => _setInfoRetryDelayForTesting(0));
  afterEach(() => _setInfoRetryDelayForTesting(null));

  it("reads rootless from /info", async () => {
    const c = client(0, { Rootless: true, NCPU: 4 });
    const result = await probeDaemon(c.client, "podman");
    assert.equal(result.isRootless, true);
    assert.equal(result.info.NCPU, 4);
    assert.equal(c.dialCalls(), 0);
  });

  it("tries /info again when a call fails", async () => {
    const c = client(2, { Rootless: true });
    assert.equal((await probeDaemon(c.client, "podman")).isRootless, true);
    assert.equal(c.infoCalls(), 3);
  });

  it("asks /libpod/info when /info cannot be read on podman", async () => {
    const c = client(ALWAYS, null, { host: { security: { rootless: true } } });
    const result = await probeDaemon(c.client, "podman");
    assert.equal(result.isRootless, true);
    assert.deepEqual(result.info, {});
  });

  it("asks /libpod/info when /info answers without a rootless reading", async () => {
    const c = client(0, {}, { host: { security: { rootless: false } } });
    assert.equal((await probeDaemon(c.client, "podman")).isRootless, false);
  });

  it("leaves rootless unknown when neither source answers", async () => {
    const c = client(ALWAYS, null);
    assert.equal((await probeDaemon(c.client, "podman")).isRootless, null);
  });

  it("does not ask /libpod/info of docker", async () => {
    const c = client(ALWAYS, null, { host: { security: { rootless: true } } });
    assert.equal((await probeDaemon(c.client, "docker")).isRootless, null);
    assert.equal(c.dialCalls(), 0);
  });
});

describe("libpodRootless", () => {
  it("gives up on a daemon that accepts the call and never answers", async () => {
    const silent: Pick<ContainerClient, "modem"> = {
      modem: {
        dial: () => {},
        followProgress: () => {},
        demuxStream: () => {},
      },
    };
    assert.equal(await libpodRootless(silent, 20), null);
  });
});
