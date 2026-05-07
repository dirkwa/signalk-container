import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveHostPathFromMounts } from "../containers";
import type { InspectedMount } from "../containers";

const bind = (source: string, dest: string): InspectedMount => ({
  type: "bind",
  name: "",
  source,
  dest,
});

const volume = (name: string, dest: string): InspectedMount => ({
  type: "volume",
  name,
  source: `/var/lib/containers/storage/volumes/${name}/_data`,
  dest,
});

describe("resolveHostPathFromMounts", () => {
  describe("bind mounts", () => {
    it("exact-match bind: host path = source, subPath = ''", () => {
      const mounts = [bind("/opt/signalk", "/home/node/.signalk")];
      const r = resolveHostPathFromMounts("/home/node/.signalk", mounts);
      assert.deepEqual(r, { source: "/opt/signalk", subPath: "" });
    });

    it("parent-bind: host path = source + relative, subPath = ''", () => {
      // Typical: -v /opt/signalk:/home/node/.signalk, asking for a child
      const mounts = [bind("/opt/signalk", "/home/node/.signalk")];
      const r = resolveHostPathFromMounts(
        "/home/node/.signalk/charts/foo.zip",
        mounts,
      );
      assert.deepEqual(r, {
        source: "/opt/signalk/charts/foo.zip",
        subPath: "",
      });
    });

    it("longest-prefix wins when nested binds overlap", () => {
      // -v /opt/signalk:/home/node/.signalk
      // -v /custom/charts:/home/node/.signalk/charts
      const mounts = [
        bind("/opt/signalk", "/home/node/.signalk"),
        bind("/custom/charts", "/home/node/.signalk/charts"),
      ];
      const r = resolveHostPathFromMounts(
        "/home/node/.signalk/charts/foo.zip",
        mounts,
      );
      assert.deepEqual(r, { source: "/custom/charts/foo.zip", subPath: "" });
    });

    it("does NOT false-match prefix (/data vs /datafoo)", () => {
      const mounts = [bind("/host/data", "/data")];
      const r = resolveHostPathFromMounts("/datafoo/x", mounts);
      assert.equal(r, null);
    });
  });

  describe("named volumes", () => {
    it("exact-match volume: source = volume name, subPath = ''", () => {
      const mounts = [volume("signalk-data", "/home/node/.signalk")];
      const r = resolveHostPathFromMounts("/home/node/.signalk", mounts);
      assert.deepEqual(r, { source: "signalk-data", subPath: "" });
    });

    it("parent-volume: source = volume name, subPath = relative", () => {
      // Volumes can't be subpath-bound, so consumer mounts the whole
      // volume and navigates to subPath inside it.
      const mounts = [volume("signalk-data", "/home/node/.signalk")];
      const r = resolveHostPathFromMounts(
        "/home/node/.signalk/charts/foo.zip",
        mounts,
      );
      assert.deepEqual(r, {
        source: "signalk-data",
        subPath: "charts/foo.zip",
      });
    });
  });

  describe("no coverage", () => {
    it("returns null when no mount covers the path", () => {
      const mounts = [bind("/opt/signalk", "/home/node/.signalk")];
      const r = resolveHostPathFromMounts("/tmp/somewhere-else", mounts);
      assert.equal(r, null);
    });

    it("returns null for empty mount list", () => {
      const r = resolveHostPathFromMounts("/anything", []);
      assert.equal(r, null);
    });
  });

  describe("mixed bind and volume", () => {
    it("longest-prefix selection ignores type", () => {
      // Bind covers a parent, volume covers the exact child.
      // Longest-prefix should pick the volume.
      const mounts = [
        bind("/opt/signalk", "/home/node/.signalk"),
        volume("charts-vol", "/home/node/.signalk/charts"),
      ];
      const r = resolveHostPathFromMounts(
        "/home/node/.signalk/charts/foo.zip",
        mounts,
      );
      assert.deepEqual(r, {
        source: "charts-vol",
        subPath: "foo.zip",
      });
    });
  });
});
