import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGroupNames,
  parseProbeOutput,
  probeHostDevice,
  PROBE_SELF_MARKER,
  nameSelfMountedNodes,
  resolveNodeGroups,
} from "../devices.js";

/** The gids GROUP_FILE names, so fixtures do not repeat bare numbers. */
const VIDEO_GID = 44;
const RENDER_GID = 992;
const GROUP_FILE = `root:x:0:\nvideo:x:${String(VIDEO_GID)}:dirk\nrender:x:${String(RENDER_GID)}:\n`;

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
    assert.equal(names.get(VIDEO_GID), "video");
    assert.equal(names.get(RENDER_GID), "render");
  });

  it("keeps the first name when a gid is aliased", () => {
    const names = parseGroupNames("first:x:44:\nsecond:x:44:\n");
    assert.equal(names.get(VIDEO_GID), "first");
  });

  it("survives a malformed file", () => {
    assert.equal(parseGroupNames("nonsense\n\n:::\n").size, 0);
  });
});

describe("probeHostDevice (visible locally)", () => {
  it("reports the nodes and their owning group names", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      ...localHost({ card0: VIDEO_GID, renderD128: RENDER_GID }),
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
      ...localHost({ card0: VIDEO_GID }),
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
      ...localHost({ card0: VIDEO_GID, card1: VIDEO_GID, renderD128: RENDER_GID }),
    });
    const b = await probeHostDevice("/dev/dri", {
      containerized: false,
      ...localHost({ card0: VIDEO_GID, card1: VIDEO_GID, renderD128: RENDER_GID }),
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
        Promise.resolve({ nodes: ["card0"], gids: [VIDEO_GID], groupFile: GROUP_FILE }),
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
          gids: [VIDEO_GID],
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
        Promise.resolve({ nodes: ["card0"], gids: [VIDEO_GID], groupFile: GROUP_FILE }),
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
          gids: [VIDEO_GID],
          groupFile: GROUP_FILE,
        }),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["card0"],
      groups: ["video"],
    });
  });

  // A visible local read still goes to the runtime when one is available: the
  // gids on the nodes are the host's, but the names this container would
  // resolve them to come from ITS /etc/group, which need not agree.
  it("prefers host group resolution over a visible local read", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...localHost({ card0: VIDEO_GID }),
      // Container's group file disagrees with the host's about gid 44.
      readFile: () => Promise.resolve(`somethingelse:x:${String(VIDEO_GID)}:\n`),
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0"],
          gids: [VIDEO_GID],
          groupFile: GROUP_FILE,
        }),
    });
    assert.deepEqual(result?.groups, ["video"]);
  });

  it("falls back to the local read when no probe can run", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...localHost({ card0: VIDEO_GID }),
      runInContainer: () => Promise.resolve(null),
    });
    assert.equal(result?.exists, true);
    assert.deepEqual(result?.nodes, ["card0"]);
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
          ? Promise.resolve({ isCharacterDevice: true, gid: VIDEO_GID })
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

describe("probeHostDevice (local read, remapped gids)", () => {
  // A local read can also see overflow gids — a Signal K container with
  // /dev/dri bound through a user namespace. It must behave like the remote
  // path, not report the bare number as a group.
  it("uses the DRM convention when a local gid is remapped", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      readDir: () => Promise.resolve(["card0"]),
      statPath: (p: string) =>
        p.endsWith("card0")
          ? Promise.resolve({ isCharacterDevice: true, gid: 65534 })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["card0"],
      groups: ["video"],
    });
  });

  it("returns unknown for a local non-DRM device with a remapped gid", async () => {
    const result = await probeHostDevice("/dev/snd", {
      containerized: true,
      readDir: () => Promise.resolve(["controlC0"]),
      statPath: (p: string) =>
        p.endsWith("controlC0")
          ? Promise.resolve({ isCharacterDevice: true, gid: 65534 })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve("audio:x:29:\n"),
    });
    assert.equal(result, null);
  });
});

describe("resolveNodeGroups", () => {
  const names = parseGroupNames(GROUP_FILE);

  it("resolves each node by its own gid", () => {
    assert.deepEqual(
      resolveNodeGroups(
        [
          { node: "card0", gid: VIDEO_GID },
          { node: "renderD128", gid: RENDER_GID },
        ],
        names,
      ),
      ["render", "video"],
    );
  });

  it("uses the DRM convention only for the remapped node", () => {
    assert.deepEqual(
      resolveNodeGroups(
        [
          { node: "card0", gid: VIDEO_GID },
          { node: "renderD128", gid: 65534 },
        ],
        names,
      ),
      ["render", "video"],
    );
  });

  it("drops a conventional name the host does not define", () => {
    assert.deepEqual(
      resolveNodeGroups([{ node: "renderD128", gid: 65534 }], parseGroupNames("video:x:44:\n")),
      null,
    );
  });

  it("returns null when nothing could be resolved", () => {
    assert.equal(resolveNodeGroups([{ node: "controlC0", gid: 65534 }], names), null);
  });

  it("falls back to the numeric gid for an unnamed group", () => {
    assert.deepEqual(resolveNodeGroups([{ node: "card0", gid: 1234 }], names), ["1234"]);
  });
});

describe("mixed node ownership", () => {
  // A directory can hold a mapped card0 beside an overflow-gid renderD128.
  // Resolving over a flat list of gids dropped whichever rule lost, so the
  // consumer got `video` alone and could not open the render node.
  it("keeps a group for each node when the remote gids are mixed", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      readDir: () => Promise.reject(new Error("ENOENT")),
      statPath: () => Promise.reject(new Error("ENOENT")),
      readFile: () => Promise.resolve(""),
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0", "renderD128"],
          gids: [VIDEO_GID, 65534],
          groupFile: GROUP_FILE,
        }),
    });
    assert.deepEqual(result?.groups, ["render", "video"]);
  });

  it("keeps a group for each node when the local gids are mixed", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      readDir: (p: string) =>
        p === "/dev/dri"
          ? Promise.resolve(["card0", "renderD128"])
          : Promise.reject(new Error("ENOTDIR")),
      statPath: (p: string) => {
        if (p === "/dev/dri") {
          return Promise.resolve({ isCharacterDevice: false, gid: 0 });
        }
        return Promise.resolve({
          isCharacterDevice: true,
          gid: p.endsWith("card0") ? VIDEO_GID : 65534,
        });
      },
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result?.groups, ["render", "video"]);
  });

  it("still resolves when every node is remapped", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      readDir: () => Promise.reject(new Error("ENOENT")),
      statPath: () => Promise.reject(new Error("ENOENT")),
      readFile: () => Promise.resolve(""),
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0", "renderD128"],
          gids: [65534, 65534],
          groupFile: GROUP_FILE,
        }),
    });
    assert.deepEqual(result?.groups, ["render", "video"]);
  });

  it("resolves the mapped node when the other cannot be resolved at all", async () => {
    // controlC0 has no DRM convention; card0 still yields its group.
    const result = await probeHostDevice("/dev/mixed", {
      containerized: true,
      readDir: () => Promise.reject(new Error("ENOENT")),
      statPath: () => Promise.reject(new Error("ENOENT")),
      readFile: () => Promise.resolve(""),
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0", "controlC0"],
          gids: [VIDEO_GID, 65534],
          groupFile: GROUP_FILE,
        }),
    });
    assert.deepEqual(result?.groups, ["video"]);
  });
});

describe("containerized fall-through", () => {
  // The point of the probe: a path that is empty or absent inside the Signal K
  // container says nothing about the host, so it must not short-circuit.
  it("asks the runtime when a local read finds nothing", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      readDir: () => Promise.resolve([]),
      statPath: () => Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve(GROUP_FILE),
      runInContainer: () =>
        Promise.resolve({ nodes: ["card0"], gids: [VIDEO_GID], groupFile: GROUP_FILE }),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["card0"],
      groups: ["video"],
    });
  });

  it("keeps a local read when the runtime cannot answer", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      readDir: () => Promise.resolve(["card0"]),
      statPath: (p: string) =>
        p.endsWith("card0")
          ? Promise.resolve({ isCharacterDevice: true, gid: VIDEO_GID })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve(GROUP_FILE),
      runInContainer: () => Promise.resolve(null),
    });
    assert.equal(result?.exists, true);
    assert.deepEqual(result?.nodes, ["card0"]);
  });

  it("still reports a definite absence on bare metal", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      readDir: () => Promise.resolve([]),
      statPath: () => Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result, { exists: false, nodes: [], groups: [] });
  });
});

describe("self-mount marker", () => {
  // A node mount lands at the constant mount point, so the probe emits a
  // marker and the caller substitutes the requested path's own name. Keeping
  // the path out of the emitted command is why the marker exists.
  it("parses the marker so the caller can substitute the node name", () => {
    const parsed = parseProbeOutput(`N ${PROBE_SELF_MARKER} 44\n---\n${GROUP_FILE}`);
    assert.deepEqual(parsed.nodes, [PROBE_SELF_MARKER]);
    assert.deepEqual(
      nameSelfMountedNodes(parsed.nodes, "/dev/dri/card0"),
      ["card0"],
    );
  });

  it("leaves names that are not the marker alone", () => {
    assert.deepEqual(
      nameSelfMountedNodes(["card0", "renderD128"], "/dev/dri"),
      ["card0", "renderD128"],
    );
  });
});

describe("parseProbeOutput", () => {
  it("parses nodes, gids and the group file", () => {
    const parsed = parseProbeOutput(
      `N card0 ${String(VIDEO_GID)}\nN renderD128 992\n---\n${GROUP_FILE}`,
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
    const parsed = parseProbeOutput(`sh: glob failed\nN card0 ${String(VIDEO_GID)}\n---\n`);
    assert.deepEqual(parsed.nodes, ["card0"]);
  });
});
