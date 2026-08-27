import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyVolumeSources } from "../containers.js";

/**
 * Probe stub used across all tests. `/missing` and `/also-missing`
 * are the only paths that don't exist; everything else does.
 */
function makeProbe(missing: string[] = ["/missing", "/also-missing"]) {
  const missingSet = new Set(missing);
  return (path: string) => !missingSet.has(path);
}

describe("classifyVolumeSources — empty / undefined input", () => {
  it("handles undefined without crashing", () => {
    const r = classifyVolumeSources(undefined, makeProbe());
    assert.deepEqual(r.kept, {});
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.aborted, []);
  });

  it("handles empty object", () => {
    const r = classifyVolumeSources({}, makeProbe());
    assert.deepEqual(r.kept, {});
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.aborted, []);
  });
});

describe("classifyVolumeSources — bare string (today's default)", () => {
  it("keeps a bare string with a present host path", () => {
    const r = classifyVolumeSources({ "/data": "/exists" }, makeProbe());
    assert.deepEqual(r.kept, { "/data": "/exists" });
    assert.equal(r.skipped.length, 0);
    assert.equal(r.aborted.length, 0);
  });

  it("keeps a bare string with a missing host path (auto-create default)", () => {
    const r = classifyVolumeSources({ "/data": "/missing" }, makeProbe());
    assert.deepEqual(r.kept, { "/data": "/missing" });
    assert.equal(r.skipped.length, 0);
    assert.equal(r.aborted.length, 0);
  });
});

describe("classifyVolumeSources — VolumeSpec with ifMissing: 'create'", () => {
  it("keeps a present host path", () => {
    const r = classifyVolumeSources(
      { "/data": { source: "/exists", ifMissing: "create" } },
      makeProbe(),
    );
    assert.deepEqual(r.kept, { "/data": "/exists" });
  });

  it("keeps a missing host path (same as bare-string fallback)", () => {
    const r = classifyVolumeSources(
      { "/data": { source: "/missing", ifMissing: "create" } },
      makeProbe(),
    );
    assert.deepEqual(r.kept, { "/data": "/missing" });
    assert.equal(r.skipped.length, 0);
    assert.equal(r.aborted.length, 0);
  });
});

describe("classifyVolumeSources — VolumeSpec with ifMissing: 'skip'", () => {
  it("keeps a present host path", () => {
    const r = classifyVolumeSources(
      { "/usb": { source: "/exists", ifMissing: "skip" } },
      makeProbe(),
    );
    assert.deepEqual(r.kept, { "/usb": "/exists" });
    assert.equal(r.skipped.length, 0);
  });

  it("skips a missing host path", () => {
    const r = classifyVolumeSources(
      { "/usb": { source: "/missing", ifMissing: "skip" } },
      makeProbe(),
    );
    assert.deepEqual(r.kept, {});
    assert.deepEqual(r.skipped, [
      { containerPath: "/usb", source: "/missing" },
    ]);
    assert.equal(r.aborted.length, 0);
  });
});

describe("classifyVolumeSources — VolumeSpec with ifMissing: 'abort'", () => {
  it("keeps a present host path", () => {
    const r = classifyVolumeSources(
      { "/certs": { source: "/exists", ifMissing: "abort" } },
      makeProbe(),
    );
    assert.deepEqual(r.kept, { "/certs": "/exists" });
    assert.equal(r.aborted.length, 0);
  });

  it("collects an aborted entry for a missing host path", () => {
    const r = classifyVolumeSources(
      { "/certs": { source: "/missing", ifMissing: "abort" } },
      makeProbe(),
    );
    assert.deepEqual(r.kept, {});
    assert.equal(r.skipped.length, 0);
    assert.deepEqual(r.aborted, [
      { containerPath: "/certs", source: "/missing" },
    ]);
  });
});

describe("classifyVolumeSources — named volumes always pass through", () => {
  it("keeps a named volume regardless of ifMissing", () => {
    const r = classifyVolumeSources(
      {
        "/a": "my-volume",
        "/b": { source: "my-other-volume", ifMissing: "skip" },
        "/c": { source: "my-third-volume", ifMissing: "abort" },
      },
      // Probe always returns false — but named volumes shouldn't reach the probe.
      () => false,
    );
    assert.deepEqual(r.kept, {
      "/a": "my-volume",
      "/b": "my-other-volume",
      "/c": "my-third-volume",
    });
    assert.equal(r.skipped.length, 0);
    assert.equal(r.aborted.length, 0);
  });

  it("does not consult the probe for non-/ sources", () => {
    let probeCalls = 0;
    const r = classifyVolumeSources(
      { "/a": "named-vol", "/b": "/exists" },
      (path) => {
        probeCalls++;
        return path === "/exists";
      },
    );
    assert.equal(
      probeCalls,
      1,
      "probe must only be called for host paths starting with /",
    );
    assert.deepEqual(r.kept, { "/a": "named-vol", "/b": "/exists" });
  });
});

describe("classifyVolumeSources — mixed map (realistic shape)", () => {
  it("partitions correctly when state dir + USB + cert + named volume coexist", () => {
    const r = classifyVolumeSources(
      {
        "/data": "/var/lib/myapp", // bare-string state dir, missing → still kept (auto-create)
        "/usb": { source: "/missing", ifMissing: "skip" },
        "/certs": { source: "/also-missing", ifMissing: "abort" },
        "/cache": { source: "/exists", ifMissing: "skip" }, // present → kept
        "/named": "my-volume",
      },
      makeProbe(["/var/lib/myapp", "/missing", "/also-missing"]),
    );
    assert.deepEqual(r.kept, {
      "/data": "/var/lib/myapp", // missing but auto-create
      "/cache": "/exists",
      "/named": "my-volume",
    });
    assert.deepEqual(r.skipped, [
      { containerPath: "/usb", source: "/missing" },
    ]);
    assert.deepEqual(r.aborted, [
      { containerPath: "/certs", source: "/also-missing" },
    ]);
  });
});

describe("classifyVolumeSources — relative paths (dot prefix)", () => {
  it("treats relative paths like host paths (probed, policy applied)", () => {
    const r = classifyVolumeSources(
      { "/data": { source: "./local-dir", ifMissing: "skip" } },
      (path) => path !== "./local-dir",
    );
    // ./local-dir starts with `.` so it's a host path; missing → skip.
    assert.deepEqual(r.kept, {});
    assert.deepEqual(r.skipped, [
      { containerPath: "/data", source: "./local-dir" },
    ]);
  });
});

describe("classifyVolumeSources — unverifiable host source", () => {
  const blind = () => "unknown" as const;

  // The reported bug: signalk-container runs inside a container, existsSync
  // checks ITS filesystem, and a real host directory reads as missing. The
  // volume was dropped and the consumer had to fall back to a bare string
  // source, losing the skip policy entirely.
  it("keeps a skip-policy volume whose source cannot be verified", () => {
    const r = classifyVolumeSources(
      { "/charts": { source: "/host/charts", ifMissing: "skip" } },
      blind,
    );
    assert.deepEqual(r.kept, { "/charts": "/host/charts" });
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.unverified, [
      { containerPath: "/charts", source: "/host/charts" },
    ]);
  });

  // `abort` fails closed, unlike skip/create. A missing bind source is not
  // reliably an error at create time -- Docker silently auto-creates an empty
  // directory (verified against a real daemon), podman errors -- so keeping an
  // unverifiable required source would mount an empty directory in place of
  // the certs and start anyway, exactly what the policy exists to prevent.
  it("aborts on a required source it cannot verify", () => {
    const r = classifyVolumeSources(
      { "/certs": { source: "/host/certs", ifMissing: "abort" } },
      blind,
    );
    assert.deepEqual(r.kept, {});
    assert.deepEqual(r.aborted, [
      { containerPath: "/certs", source: "/host/certs" },
    ]);
    // Aborted, not "kept but unverified" -- the two lists are exclusive.
    assert.deepEqual(r.unverified, []);
  });

  // The optimistic keep is for the optional and default policies only.
  it("keeps an unverifiable create-policy source", () => {
    const r = classifyVolumeSources({ "/data": "/host/data" }, blind);
    assert.deepEqual(r.kept, { "/data": "/host/data" });
    assert.deepEqual(r.aborted, []);
    assert.equal(r.unverified.length, 1);
  });

  it("still skips and aborts on a source proven absent", () => {
    const gone = () => false;
    const skip = classifyVolumeSources(
      { "/charts": { source: "/host/charts", ifMissing: "skip" } },
      gone,
    );
    assert.deepEqual(skip.kept, {});
    assert.equal(skip.skipped.length, 1);
    assert.deepEqual(skip.unverified, []);

    const abort = classifyVolumeSources(
      { "/data": { source: "/host/data", ifMissing: "abort" } },
      gone,
    );
    assert.equal(abort.aborted.length, 1);
    assert.deepEqual(abort.unverified, []);
  });

  // A named volume has no host path to check, so it must never reach the probe
  // and never be reported unverified.
  it("does not report a named volume as unverified", () => {
    const r = classifyVolumeSources(
      { "/data": { source: "my-named-volume", ifMissing: "skip" } },
      blind,
    );
    assert.deepEqual(r.kept, { "/data": "my-named-volume" });
    assert.deepEqual(r.unverified, []);
  });

  it("classifies a mixed set independently", () => {
    const r = classifyVolumeSources(
      {
        "/a": { source: "/host/seen", ifMissing: "skip" },
        "/b": { source: "/host/blind", ifMissing: "skip" },
        "/c": { source: "/host/gone", ifMissing: "skip" },
        "/d": { source: "/host/blind-required", ifMissing: "abort" },
      },
      (path) =>
        path === "/host/seen" ? true : path === "/host/gone" ? false : "unknown",
    );
    assert.deepEqual(r.kept, {
      "/a": "/host/seen",
      "/b": "/host/blind",
    });
    assert.deepEqual(r.skipped, [
      { containerPath: "/c", source: "/host/gone" },
    ]);
    assert.deepEqual(r.aborted, [
      { containerPath: "/d", source: "/host/blind-required" },
    ]);
    assert.deepEqual(r.unverified, [
      { containerPath: "/b", source: "/host/blind" },
    ]);
  });

  it("reports no unverified entries for undefined volumes", () => {
    assert.deepEqual(classifyVolumeSources(undefined, blind).unverified, []);
  });
});
