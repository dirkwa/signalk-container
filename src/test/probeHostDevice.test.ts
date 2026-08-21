import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGroupNames,
  parseProbeOutput,
  probeHostDevice,
} from "../devices.js";

const GROUP_FILE = "root:x:0:\nvideo:x:44:dirk\nrender:x:992:\n";

/** Filesystem that behaves like a host with a GPU. */
function localHost(nodes: Record<string, number>) {
  return {
    readDir: (p: string) =>
      p === "/dev/dri"
        ? Promise.resolve(Object.keys(nodes))
        : Promise.reject(new Error("ENOENT")),
    statPath: (p: string) => {
      const gid = nodes[p.slice("/dev/dri/".length)];
      if (gid === undefined) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve({ isCharacterDevice: true, gid });
    },
    readFile: () => Promise.resolve(GROUP_FILE),
  };
}

describe("parseGroupNames", () => {
  it("maps gids to names", () => {
    const names = parseGroupNames(GROUP_FILE);
    assert.equal(names.get(44), "video");
    assert.equal(names.get(992), "render");
  });

  it("keeps the first name when a gid is aliased", () => {
    const names = parseGroupNames("first:x:44:\nsecond:x:44:\n");
    assert.equal(names.get(44), "first");
  });

  it("survives a malformed file", () => {
    assert.equal(parseGroupNames("nonsense\n\n:::\n").size, 0);
  });
});

describe("probeHostDevice (visible locally)", () => {
  it("reports the nodes and their owning group names", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      ...localHost({ card0: 44, renderD128: 992 }),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["card0", "renderD128"],
      groups: ["render", "video"],
    });
  });

  // The dev VM's real layout: card0 owned by video, no renderD128. The
  // upstream opencpn-kiosk compose hardcodes gid 993, which is neither.
  it("handles a host with only card0", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      ...localHost({ card0: 44 }),
    });
    assert.deepEqual(result?.groups, ["video"]);
  });

  it("falls back to the numeric gid when a group has no name", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      ...localHost({ card0: 1234 }),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result?.groups, ["1234"]);
  });

  it("de-duplicates and sorts groups, so groupAdd is drift-stable", async () => {
    const a = await probeHostDevice("/dev/dri", {
      containerized: false,
      ...localHost({ card0: 44, card1: 44, renderD128: 992 }),
    });
    const b = await probeHostDevice("/dev/dri", {
      containerized: false,
      ...localHost({ card0: 44, card1: 44, renderD128: 992 }),
    });
    assert.deepEqual(a?.groups, ["render", "video"]);
    assert.deepEqual(a, b);
  });

  it("ignores entries that are not character devices", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      readDir: () => Promise.resolve(["by-path", "README"]),
      statPath: () => Promise.resolve({ isCharacterDevice: false, gid: 0 }),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result, { exists: false, nodes: [], groups: [] });
  });

  it("reports a definite absence on bare metal", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      readDir: () => Promise.reject(new Error("ENOENT")),
      statPath: () => Promise.reject(new Error("ENOENT")),
      readFile: () => Promise.resolve(""),
    });
    assert.deepEqual(result, { exists: false, nodes: [], groups: [] });
  });
});

describe("probeHostDevice (containerized)", () => {
  const invisible = {
    readDir: () => Promise.reject(new Error("ENOENT")),
    statPath: () => Promise.reject(new Error("ENOENT")),
    readFile: () => Promise.resolve(""),
  };

  // The whole point: the Signal K container cannot see /dev/dri even when the
  // host has one, so "not visible here" must never be reported as absent.
  it("returns null (unknown) when it cannot see or probe the path", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
    });
    assert.equal(result, null);
  });

  it("returns null when the probe runner cannot run", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () => Promise.resolve(null),
    });
    assert.equal(result, null);
  });

  // The group file must be the HOST's: the gids on host device nodes are the
  // host's, and a probe image does not share them, so reading the image's own
  // /etc/group reports the bare number instead of the name.
  it("resolves names from the host's group file, not the probe image's", async () => {
    const alpineGroupFile = "root:x:0:root\nbin:x:1:root,bin\n";
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({ nodes: ["card0"], gids: [44], groupFile: GROUP_FILE }),
    });
    assert.deepEqual(result?.groups, ["video"]);

    // Same probe, but handed an image group file with no gid 44: the name is
    // simply unavailable and the gid is reported instead.
    const wrongSource = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0"],
          gids: [44],
          groupFile: alpineGroupFile,
        }),
    });
    assert.deepEqual(wrongSource?.groups, ["44"]);
  });

  // Rootless podman maps only the user's subgid range, so a host gid outside
  // it (44 = video) is reported as the overflow id from every route into the
  // namespace — probe container, --userns=host, keep-id, even podman unshare.
  // The numbers carry no information there; the names must come from udev
  // convention, confirmed against the host's own group file.
  it("falls back to udev naming when gids are userns-remapped", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0", "renderD128"],
          gids: [65534, 65534],
          groupFile: GROUP_FILE,
        }),
    });
    assert.deepEqual(result?.groups, ["render", "video"]);
  });

  it("drops a conventional name the host does not actually define", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0", "renderD128"],
          gids: [65534, 65534],
          // Host with no `render` group at all.
          groupFile: "video:x:44:\n",
        }),
    });
    assert.deepEqual(result?.groups, ["video"]);
  });

  // /dev/snd and /dev/input have no udev naming convention to fall back on.
  // Reporting exists:true with no groups would have the caller pass the device
  // through with nothing to open it — a silent runtime failure. Unknown is honest.
  it("returns unknown for a non-DRM device whose ownership cannot be confirmed", async () => {
    const result = await probeHostDevice("/dev/snd", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: ["controlC0", "pcmC0D0p"],
          gids: [65534, 65534],
          groupFile: "audio:x:29:\n",
        }),
    });
    assert.equal(result, null);
  });

  // The probe ran successfully and simply found nothing — a definite absence.
  // null would claim we could not tell, which is a different thing.
  it("reports a definite absence when the probe finds no nodes", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({ nodes: [], gids: [], groupFile: GROUP_FILE }),
    });
    assert.deepEqual(result, { exists: false, nodes: [], groups: [] });
  });

  it("prefers real gids when they are not remapped (docker)", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({ nodes: ["card0"], gids: [44], groupFile: GROUP_FILE }),
    });
    assert.deepEqual(result?.groups, ["video"]);
  });

  it("reads the host's view through the probe container", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0"],
          gids: [44],
          groupFile: GROUP_FILE,
        }),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["card0"],
      groups: ["video"],
    });
  });

  it("prefers the local read when the path IS visible, without a container", async () => {
    let ran = false;
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...localHost({ card0: 44 }),
      runInContainer: () => {
        ran = true;
        return Promise.resolve(null);
      },
    });
    assert.equal(ran, false, "should not spawn a container when it can just read");
    assert.equal(result?.exists, true);
  });
});

describe("probeHostDevice (single node path)", () => {
  // Asking about /dev/dri/card0 is as reasonable as asking about /dev/dri;
  // readdir on a node fails with ENOTDIR, which is not "absent".
  it("probes a device node directly, not only a directory", async () => {
    const result = await probeHostDevice("/dev/dri/card0", {
      containerized: false,
      readDir: () => Promise.reject(new Error("ENOTDIR")),
      statPath: (p: string) =>
        p === "/dev/dri/card0"
          ? Promise.resolve({ isCharacterDevice: true, gid: 44 })
          : Promise.reject(new Error("ENOENT")),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["card0"],
      groups: ["video"],
    });
  });

  it("still reports absent for a path that is neither node nor directory", async () => {
    const result = await probeHostDevice("/dev/nope", {
      containerized: false,
      readDir: () => Promise.reject(new Error("ENOENT")),
      statPath: () => Promise.reject(new Error("ENOENT")),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result, { exists: false, nodes: [], groups: [] });
  });
});

describe("parseProbeOutput", () => {
  it("parses nodes, gids and the group file", () => {
    const parsed = parseProbeOutput(
      `N card0 44\nN renderD128 992\n---\n${GROUP_FILE}`,
    );
    assert.deepEqual(parsed.nodes, ["card0", "renderD128"]);
    assert.deepEqual(parsed.gids, [44, 992]);
    assert.match(parsed.groupFile, /video:x:44/);
  });

  it("copes with no devices found", () => {
    const parsed = parseProbeOutput(`---\n${GROUP_FILE}`);
    assert.deepEqual(parsed.nodes, []);
    assert.deepEqual(parsed.gids, []);
  });

  it("ignores noise the shell may have emitted", () => {
    const parsed = parseProbeOutput("sh: glob failed\nN card0 44\n---\n");
    assert.deepEqual(parsed.nodes, ["card0"]);
  });
});
