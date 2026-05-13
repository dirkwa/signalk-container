import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePortBindings } from "../containers.js";

describe("parsePortBindings", () => {
  it("parses a typical podman bare-metal entry", () => {
    const json = JSON.stringify({
      "3010/tcp": [{ HostIp: "127.0.0.1", HostPort: "3010" }],
      "53682/tcp": [{ HostIp: "127.0.0.1", HostPort: "53682" }],
    });
    const result = parsePortBindings(json);
    assert.equal(result.size, 2);
    assert.deepEqual(result.get(3010), [
      { hostIp: "127.0.0.1", hostPort: 3010 },
    ]);
    assert.deepEqual(result.get(53682), [
      { hostIp: "127.0.0.1", hostPort: 53682 },
    ]);
  });

  it("captures cache drift: actual host port differs from container port", () => {
    // Reproduces the issue #27 scenario: caller asked for container port 3010
    // but the runtime ended up binding host port 3011 (or vice versa).
    const json = JSON.stringify({
      "3010/tcp": [{ HostIp: "127.0.0.1", HostPort: "3011" }],
    });
    const result = parsePortBindings(json);
    assert.equal(result.get(3010)?.[0]?.hostPort, 3011);
  });

  it("keeps multiple bindings on different host IPs for one container port", () => {
    // 0.0.0.0 + IPv6 on same port — Docker's default for `-p 8080:8080`.
    const json = JSON.stringify({
      "8080/tcp": [
        { HostIp: "0.0.0.0", HostPort: "8080" },
        { HostIp: "::", HostPort: "8080" },
      ],
    });
    const result = parsePortBindings(json);
    assert.equal(result.get(8080)?.length, 2);
  });

  it("ignores UDP and SCTP entries", () => {
    const json = JSON.stringify({
      "3010/tcp": [{ HostIp: "127.0.0.1", HostPort: "3010" }],
      "3010/udp": [{ HostIp: "127.0.0.1", HostPort: "3010" }],
      "3010/sctp": [{ HostIp: "127.0.0.1", HostPort: "3010" }],
    });
    const result = parsePortBindings(json);
    assert.equal(result.size, 1);
    assert.ok(result.has(3010));
  });

  it("ignores entries with no bindings (exposed but not published)", () => {
    // Some images EXPOSE a port without -p; podman emits an empty array.
    const json = JSON.stringify({
      "3010/tcp": [{ HostIp: "127.0.0.1", HostPort: "3010" }],
      "5000/tcp": [],
      "9000/tcp": null,
    });
    const result = parsePortBindings(json);
    assert.equal(result.size, 1);
    assert.ok(result.has(3010));
  });

  it("returns empty map for null / empty / 'null' input", () => {
    assert.equal(parsePortBindings("").size, 0);
    assert.equal(parsePortBindings("null").size, 0);
    // @ts-expect-error — proving runtime tolerance for callers that pass undefined
    assert.equal(parsePortBindings(undefined).size, 0);
  });

  it("returns empty map on malformed JSON", () => {
    assert.equal(parsePortBindings("{not json").size, 0);
    assert.equal(parsePortBindings("[]").size, 0);
    assert.equal(parsePortBindings("42").size, 0);
  });

  it("skips entries with non-numeric or zero host port", () => {
    const json = JSON.stringify({
      "3010/tcp": [
        { HostIp: "127.0.0.1", HostPort: "not-a-number" },
        { HostIp: "127.0.0.1", HostPort: "0" },
        { HostIp: "127.0.0.1", HostPort: "3010" },
      ],
    });
    const result = parsePortBindings(json);
    assert.deepEqual(result.get(3010), [
      { hostIp: "127.0.0.1", hostPort: 3010 },
    ]);
  });

  it("tolerates missing HostIp (defaults to empty string)", () => {
    const json = JSON.stringify({
      "3010/tcp": [{ HostPort: "3010" }],
    });
    const result = parsePortBindings(json);
    assert.deepEqual(result.get(3010), [{ hostIp: "", hostPort: 3010 }]);
  });
});
