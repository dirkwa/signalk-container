import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  libpodRootless,
  withDeadline,
  type ContainerClient,
} from "../client.js";
import {
  _setInfoRetryDelayForTesting,
  _setInfoTimeoutForTesting,
  probeDaemon,
} from "../runtime.js";

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
  beforeEach(() => {
    _setInfoRetryDelayForTesting(0);
    _setInfoTimeoutForTesting(20);
  });
  afterEach(() => {
    _setInfoRetryDelayForTesting(null);
    _setInfoTimeoutForTesting(null);
  });

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
    assert.equal(c.infoCalls(), 3);
  });

  it("tries /info again when it answers without a rootless reading", async () => {
    let calls = 0;
    const flaky: ProbeClient = {
      info: () => Promise.resolve(++calls < 3 ? {} : { Rootless: true }),
      modem: {
        dial: (_opts, cb) => cb(new Error("socket gone"), null),
        followProgress: () => {},
        demuxStream: () => {},
      },
    };
    assert.equal((await probeDaemon(flaky, "podman")).isRootless, true);
    assert.equal(calls, 3);
  });

  it("takes docker's first answer, whose mapping does not depend on it", async () => {
    const c = client(0, {});
    assert.equal((await probeDaemon(c.client, "docker")).isRootless, null);
    assert.equal(c.infoCalls(), 1);
  });

  it("leaves rootless unknown when neither source answers", async () => {
    const c = client(ALWAYS, null);
    assert.equal((await probeDaemon(c.client, "podman")).isRootless, null);
  });

  it("aborts an /info that never answers and asks /libpod/info", async () => {
    let aborted = 0;
    const silent: ProbeClient = {
      info: (opts) =>
        new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener("abort", () => {
            aborted++;
            reject(new Error("aborted"));
          });
        }),
      modem: {
        dial: (_opts, cb) =>
          cb(null, { host: { security: { rootless: true } } }),
        followProgress: () => {},
        demuxStream: () => {},
      },
    };
    assert.equal((await probeDaemon(silent, "podman")).isRootless, true);
    assert.equal(aborted, 3);
  });

  it("does not ask /libpod/info of docker", async () => {
    const c = client(ALWAYS, null, { host: { security: { rootless: true } } });
    assert.equal((await probeDaemon(c.client, "docker")).isRootless, null);
    assert.equal(c.dialCalls(), 0);
  });
});

describe("libpodRootless", () => {
  it("gives up on a daemon that accepts the call and never answers, and aborts it", async () => {
    let signal: AbortSignal | undefined;
    const silent: Pick<ContainerClient, "modem"> = {
      modem: {
        dial: (opts) => {
          signal = opts.abortSignal;
        },
        followProgress: () => {},
        demuxStream: () => {},
      },
    };
    assert.equal(await libpodRootless(silent, 20), null);
    assert.equal(signal?.aborted, true);
  });
});

describe("withDeadline", () => {
  it("passes an answer that comes in time through", async () => {
    assert.equal(await withDeadline(1000, () => Promise.resolve(7)), 7);
  });

  it("aborts the request and rejects at the deadline", async () => {
    let signal: AbortSignal | undefined;
    await assert.rejects(
      withDeadline(20, (s) => {
        signal = s;
        return new Promise(() => {});
      }),
      /no answer within 20 ms/,
    );
    assert.equal(signal?.aborted, true);
  });

  it("rejects at the deadline even when the request ignores the abort", async () => {
    await assert.rejects(
      withDeadline(20, () => new Promise(() => {})),
      /no answer within 20 ms/,
    );
  });
});
