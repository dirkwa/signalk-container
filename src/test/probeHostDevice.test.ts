import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGroupNames,
  parseProbeOutput,
  probeHostDevice,
  PROBE_SELF_MARKER,
  nameSelfMountedNodes,
  resolveNodeGroups,
  conventionalDeviceGroup,
  deviceDirectoryOf,
  deviceNodeNameOf,
  OVERFLOW_GID,
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

  // Number.parseInt stops at the first non-digit, so "44invalid" would parse
  // as 44. Since the first definition wins, a malformed line ahead of the real
  // one would shadow it and hand groupAdd a name the host does not define.
  it("rejects a gid field that is not entirely digits", () => {
    for (const bad of [
      "bogus:x:44invalid:",
      "neg:x:-5:",
      "space:x: 44:",
      "hex:x:0x2c:",
      "empty:x::",
    ]) {
      assert.equal(parseGroupNames(`${bad}\n`).size, 0, bad);
    }
  });

  it("does not let a malformed line shadow the real group", () => {
    const names = parseGroupNames(
      `bogus:x:${String(VIDEO_GID)}invalid:\nvideo:x:${String(VIDEO_GID)}:dirk\n`,
    );
    assert.equal(names.get(VIDEO_GID), "video");
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
    // Coded: only ENOENT/ENOTDIR prove absence, anything else is unknown.
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      readDir: () => Promise.reject(enoent),
      statPath: () => Promise.reject(enoent),
      readFile: () => Promise.resolve(""),
    });
    assert.deepEqual(result, { exists: false, nodes: [], groups: [] });
  });
});

describe("bare metal: absent vs unresolved", () => {
  // A device that is there but whose ownership cannot be resolved is not the
  // same as no device. Reporting `exists: false` would have the caller skip
  // passthrough silently instead of surfacing that it could not tell.
  it("reports unknown for a present device with unresolvable ownership", async () => {
    // A directory with no convention rule AND an unreadable gid: nothing left
    // to resolve from.
    const result = await probeHostDevice("/dev/unknownclass", {
      containerized: false,
      readDir: () => Promise.resolve(["widget0"]),
      statPath: (p: string) =>
        p.endsWith("widget0")
          ? Promise.resolve({ isCharacterDevice: true, gid: OVERFLOW_GID })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve("audio:x:29:\n"),
    });
    assert.equal(result, null);
  });

  // A single-node request classifies against its PARENT: "/dev/snd/seq" is not
  // itself in the convention table, "/dev/snd" is.
  it("resolves a single remapped node by its parent directory", async () => {
    const result = await probeHostDevice("/dev/snd/seq", {
      containerized: false,
      readDir: () => Promise.reject(new Error("ENOTDIR")),
      statPath: () => Promise.resolve({ isCharacterDevice: true, gid: OVERFLOW_GID }),
      readFile: () => Promise.resolve("audio:x:29:\n"),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["seq"],
      groups: ["audio"],
    });
  });

  // /dev/snd has no usable node prefix, but the directory itself identifies the
  // class, so a remapped gid still resolves. This is the rootless-podman case.
  it("resolves a remapped /dev/snd node by directory convention", async () => {
    const result = await probeHostDevice("/dev/snd", {
      containerized: false,
      readDir: () => Promise.resolve(["controlC0"]),
      statPath: (p: string) =>
        p.endsWith("controlC0")
          ? Promise.resolve({ isCharacterDevice: true, gid: OVERFLOW_GID })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve("audio:x:29:\n"),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["controlC0"],
      groups: ["audio"],
    });
  });

  // Only ENOENT and ENOTDIR prove absence. EACCES — a hardened host where
  // Signal K's user is outside the device group — means we could not look,
  // which is not the same as looking and finding nothing.
  it("reports unknown when the path cannot be read", async () => {
    for (const code of ["EACCES", "EIO", "EPERM"]) {
      const err = Object.assign(new Error(code), { code });
      const result = await probeHostDevice("/dev/dri", {
        containerized: false,
        readDir: () => Promise.reject(err),
        statPath: () => Promise.reject(err),
        readFile: () => Promise.resolve(GROUP_FILE),
      });
      assert.equal(result, null, code);
    }
  });

  it("reports unknown for a failure with no error code", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      readDir: () => Promise.reject(new Error("something odd")),
      statPath: () => Promise.reject(new Error("something odd")),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.equal(result, null);
  });

  it("still reports a definite absence for a path that is not there", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const result = await probeHostDevice("/dev/nope", {
      containerized: false,
      readDir: () => Promise.reject(enoent),
      statPath: () => Promise.reject(enoent),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result, { exists: false, nodes: [], groups: [] });
  });

  it("still reports a definite absence for a directory holding no devices", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: false,
      readDir: () => Promise.resolve(["by-path", "README"]),
      statPath: () => Promise.resolve({ isCharacterDevice: false, gid: 0 }),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result, { exists: false, nodes: [], groups: [] });
  });

  it("resolves normally when ownership is readable", async () => {
    const result = await probeHostDevice("/dev/snd", {
      containerized: false,
      readDir: () => Promise.resolve(["controlC0"]),
      statPath: (p: string) =>
        p.endsWith("controlC0")
          ? Promise.resolve({ isCharacterDevice: true, gid: 29 })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve("audio:x:29:\n"),
    });
    assert.deepEqual(result?.groups, ["audio"]);
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
          gids: [OVERFLOW_GID, OVERFLOW_GID],
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
          gids: [OVERFLOW_GID, OVERFLOW_GID],
          // Host with no `render` group at all.
          groupFile: "video:x:44:\n",
        }),
    });
    assert.deepEqual(result?.groups, ["video"]);
  });

  // A directory with no convention rule still has nothing to fall back on.
  // Reporting exists:true with no groups would have the caller pass the device
  // through with nothing to open it — a silent runtime failure. Unknown is honest.
  it("returns unknown for a device whose ownership cannot be confirmed", async () => {
    const result = await probeHostDevice("/dev/unknownclass", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: ["widget0", "widget1"],
          gids: [OVERFLOW_GID, OVERFLOW_GID],
          groupFile: "audio:x:29:\n",
        }),
    });
    assert.equal(result, null);
  });

  // The remote counterpart of the single-node case above, and the path that
  // actually needs PROBE_SELF_MARKER: the probe cannot report a real node name
  // for a self-mounted request, so the marker is what identifies "this path IS
  // a node" and sends the class lookup to the parent directory.
  it("resolves a remote single-node request via its parent directory", async () => {
    const result = await probeHostDevice("/dev/snd/seq", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        // The real runner substitutes the marker for the requested path's
        // basename before returning (index.ts, via nameSelfMountedNodes), so
        // this is the shape probeHostDevice actually receives.
        Promise.resolve({
          nodes: ["seq"],
          gids: [OVERFLOW_GID],
          groupFile: "audio:x:29:\n",
        }),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["seq"],
      groups: ["audio"],
    });
  });

  // A raw marker must resolve identically to the substituted form. Left as
  // "__self__" it matches no udev prefix, and /dev/dri has no directory rule
  // by design, so a resolvable renderD128 would come back as unknown.
  it("resolves a raw-marker DRM node request", async () => {
    const result = await probeHostDevice("/dev/dri/renderD128", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: [PROBE_SELF_MARKER],
          gids: [OVERFLOW_GID],
          groupFile: GROUP_FILE,
        }),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["renderD128"],
      groups: ["render"],
    });
  });

  // The unsubstituted form is still accepted, so a runner that returns the
  // raw marker resolves identically.
  it("accepts an unsubstituted self marker from the probe", async () => {
    const result = await probeHostDevice("/dev/snd/seq", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: [PROBE_SELF_MARKER],
          gids: [OVERFLOW_GID],
          groupFile: "audio:x:29:\n",
        }),
    });
    assert.deepEqual(result?.groups, ["audio"]);
  });

  // A one-entry DIRECTORY listing must not be mistaken for a single-node
  // request: /dev/dri holding only card0 is still a directory, and climbing
  // to /dev would lose the class.
  it("does not treat a one-node directory listing as a node request", async () => {
    const result = await probeHostDevice("/dev/dri", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: ["card0"],
          gids: [OVERFLOW_GID],
          groupFile: "video:x:44:\n",
        }),
    });
    assert.deepEqual(result?.groups, ["video"]);
  });

  // The same probe against /dev/snd resolves, because the directory names the
  // class even though the node names carry no prefix.
  it("resolves remapped /dev/snd nodes through the runtime probe", async () => {
    const result = await probeHostDevice("/dev/snd", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: ["controlC0", "pcmC0D0p"],
          gids: [OVERFLOW_GID, OVERFLOW_GID],
          groupFile: "audio:x:29:\n",
        }),
    });
    assert.deepEqual(result?.groups, ["audio"]);
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
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const result = await probeHostDevice("/dev/nope", {
      containerized: false,
      readDir: () => Promise.reject(enoent),
      statPath: () => Promise.reject(enoent),
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
          ? Promise.resolve({ isCharacterDevice: true, gid: OVERFLOW_GID })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve(GROUP_FILE),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["card0"],
      groups: ["video"],
    });
  });

  it("returns unknown for a local device with a remapped gid and no rule", async () => {
    const result = await probeHostDevice("/dev/unknownclass", {
      containerized: true,
      readDir: () => Promise.resolve(["widget0"]),
      statPath: (p: string) =>
        p.endsWith("widget0")
          ? Promise.resolve({ isCharacterDevice: true, gid: OVERFLOW_GID })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve("audio:x:29:\n"),
    });
    assert.equal(result, null);
  });

  it("resolves a local remapped /dev/snd node by directory convention", async () => {
    const result = await probeHostDevice("/dev/snd", {
      containerized: true,
      readDir: () => Promise.resolve(["controlC0"]),
      statPath: (p: string) =>
        p.endsWith("controlC0")
          ? Promise.resolve({ isCharacterDevice: true, gid: OVERFLOW_GID })
          : Promise.reject(new Error("ENOTDIR")),
      readFile: () => Promise.resolve("audio:x:29:\n"),
    });
    assert.deepEqual(result?.groups, ["audio"]);
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
          { node: "renderD128", gid: OVERFLOW_GID },
        ],
        names,
      ),
      ["render", "video"],
    );
  });

  it("drops a conventional name the host does not define", () => {
    assert.deepEqual(
      resolveNodeGroups([{ node: "renderD128", gid: OVERFLOW_GID }], parseGroupNames("video:x:44:\n")),
      null,
    );
  });

  it("returns null when nothing could be resolved", () => {
    assert.equal(resolveNodeGroups([{ node: "controlC0", gid: OVERFLOW_GID }], names), null);
  });

  it("falls back to the numeric gid for an unnamed group", () => {
    assert.deepEqual(resolveNodeGroups([{ node: "card0", gid: 1234 }], names), ["1234"]);
  });
});

describe("conventionalDeviceGroup", () => {
  it("keeps the DRM node-prefix rules", () => {
    assert.equal(conventionalDeviceGroup("renderD128"), "render");
    assert.equal(conventionalDeviceGroup("card0"), "video");
  });

  it("resolves /dev/snd and /dev/input by directory", () => {
    // These nodes share no prefix with each other -- the whole reason the
    // directory rule exists.
    assert.equal(conventionalDeviceGroup("seq", "/dev/snd"), "audio");
    assert.equal(conventionalDeviceGroup("timer", "/dev/snd"), "audio");
    assert.equal(conventionalDeviceGroup("pcmC0D0p", "/dev/snd"), "audio");
    assert.equal(conventionalDeviceGroup("event0", "/dev/input"), "input");
    assert.equal(conventionalDeviceGroup("js0", "/dev/input"), "input");
    assert.equal(conventionalDeviceGroup("mice", "/dev/input"), "input");
  });

  it("tolerates a trailing slash on the directory", () => {
    assert.equal(conventionalDeviceGroup("seq", "/dev/snd/"), "audio");
  });

  it("does not give /dev/dri a directory-wide answer", () => {
    // card* and renderD* differ; one answer for the directory would be wrong
    // for half its nodes.
    assert.equal(conventionalDeviceGroup("unknown0", "/dev/dri"), null);
  });

  it("lets the node prefix win over the directory", () => {
    assert.equal(conventionalDeviceGroup("renderD128", "/dev/snd"), "render");
  });

  it("returns null for an unknown directory", () => {
    assert.equal(conventionalDeviceGroup("ttyUSB0", "/dev/serial"), null);
    assert.equal(conventionalDeviceGroup("seq"), null);
  });
});

describe("deviceDirectoryOf", () => {
  it("passes a directory request through unchanged", () => {
    assert.equal(deviceDirectoryOf("/dev/snd"), "/dev/snd");
    assert.equal(deviceDirectoryOf("/dev/snd/"), "/dev/snd");
  });

  it("climbs to the parent for a single-node request", () => {
    assert.equal(deviceDirectoryOf("/dev/snd/seq", true), "/dev/snd");
    assert.equal(deviceDirectoryOf("/dev/input/event0", true), "/dev/input");
  });

  it("does not climb past the root", () => {
    assert.equal(deviceDirectoryOf("/snd", true), "/snd");
    assert.equal(deviceDirectoryOf("snd", true), "snd");
  });
});

describe("trailing slash on a single-node request", () => {
  const invisible = {
    readDir: () => Promise.reject(new Error("ENOENT")),
    statPath: () => Promise.reject(new Error("ENOENT")),
    readFile: () => Promise.resolve(""),
  };

  // "/dev/snd/seq/" takes everything after the last "/" -- the empty string --
  // unless trailing slashes are stripped first. That named the node "" and
  // turned a resolvable request into unknown.
  it("names the node the same with or without a trailing slash", () => {
    assert.equal(deviceNodeNameOf("/dev/snd/seq"), "seq");
    assert.equal(deviceNodeNameOf("/dev/snd/seq/"), "seq");
    assert.equal(deviceNodeNameOf("/dev/snd/seq//"), "seq");
  });

  it("substitutes the marker for a trailing-slash path", () => {
    assert.deepEqual(
      nameSelfMountedNodes([PROBE_SELF_MARKER], "/dev/snd/seq/"),
      ["seq"],
    );
  });

  it("resolves a trailing-slash node through the runtime probe", async () => {
    const result = await probeHostDevice("/dev/snd/seq/", {
      containerized: true,
      ...invisible,
      runInContainer: () =>
        Promise.resolve({
          nodes: [PROBE_SELF_MARKER],
          gids: [OVERFLOW_GID],
          groupFile: "audio:x:29:\n",
        }),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["seq"],
      groups: ["audio"],
    });
  });

  it("resolves a trailing-slash node on a local read", async () => {
    const result = await probeHostDevice("/dev/snd/seq/", {
      containerized: false,
      readDir: () =>
        Promise.reject(Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" })),
      statPath: () =>
        Promise.resolve({ isCharacterDevice: true, gid: OVERFLOW_GID }),
      readFile: () => Promise.resolve("audio:x:29:\n"),
    });
    assert.deepEqual(result, {
      exists: true,
      nodes: ["seq"],
      groups: ["audio"],
    });
  });
});

describe("audio and input group convention", () => {
  const AUDIO_GID = 29;
  const INPUT_GID = 996;
  const hostGroups = parseGroupNames(
    `audio:x:${String(AUDIO_GID)}:\ninput:x:${String(INPUT_GID)}:\n`,
  );

  it("resolves overflow-gid /dev/snd nodes to audio", () => {
    // Exactly the rootless-podman case: every gid reads back as the overflow
    // id, so only the convention can answer.
    assert.deepEqual(
      resolveNodeGroups(
        [
          { node: "seq", gid: OVERFLOW_GID },
          { node: "timer", gid: OVERFLOW_GID },
        ],
        hostGroups,
        "/dev/snd",
      ),
      ["audio"],
    );
  });

  it("resolves overflow-gid /dev/input nodes to input", () => {
    assert.deepEqual(
      resolveNodeGroups(
        [
          { node: "event0", gid: OVERFLOW_GID },
          { node: "js0", gid: OVERFLOW_GID },
        ],
        hostGroups,
        "/dev/input",
      ),
      ["input"],
    );
  });

  it("still drops a name the host does not define", () => {
    // A host with no `input` group must not be told to add one.
    assert.equal(
      resolveNodeGroups(
        [{ node: "event0", gid: OVERFLOW_GID }],
        parseGroupNames(`audio:x:${String(AUDIO_GID)}:\n`),
        "/dev/input",
      ),
      null,
    );
  });

  it("prefers a readable gid over the convention", () => {
    // Deliberately contradictory: a node in /dev/snd (convention says audio)
    // whose gid is readable and says input. A readable gid is fact, the
    // convention only a fallback, so the gid must win -- and picking a gid
    // that disagrees is the only way to tell the two apart.
    assert.deepEqual(
      resolveNodeGroups(
        [{ node: "seq", gid: INPUT_GID }],
        hostGroups,
        "/dev/snd",
      ),
      ["input"],
    );
  });

  it("returns null without a directory", () => {
    // A prefix-less node cannot resolve on its own: `seq` matches no udev
    // prefix rule, and without the containing directory there is no class to
    // look up.
    assert.equal(
      resolveNodeGroups([{ node: "seq", gid: OVERFLOW_GID }], hostGroups),
      null,
    );
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
          gids: [VIDEO_GID, OVERFLOW_GID],
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
          gid: p.endsWith("card0") ? VIDEO_GID : OVERFLOW_GID,
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
          gids: [OVERFLOW_GID, OVERFLOW_GID],
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
          gids: [VIDEO_GID, OVERFLOW_GID],
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
