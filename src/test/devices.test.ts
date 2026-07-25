import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  directoryDeviceMajors,
  majorFromRdev,
  parseDeviceEntry,
  resolveDeviceRequests,
  resolveGroupAdd,
  type DeviceHostProbe,
  type DeviceStatResult,
} from "../devices.js";
import type { ContainerRuntimeInfo } from "../types.js";

const docker: ContainerRuntimeInfo = {
  runtime: "docker",
  version: "27.0.0",
  isPodmanDockerShim: false,
};

const podmanRootless: ContainerRuntimeInfo = {
  runtime: "podman",
  version: "5.4.2",
  isPodmanDockerShim: false,
  isRootless: true,
};

/** Linux dev_t: major in bits 8–19, minor split across bits 0–7 and 20+. */
function rdevOf(major: number, minor: number): number {
  return (minor & 0xff) + major * 0x100 + Math.floor(minor / 0x100) * 0x100000;
}

function node(major: number, minor = 0): DeviceStatResult {
  return { kind: "device-node", rdev: rdevOf(major, minor) };
}

function fakeProbe(spec: {
  stats?: Record<string, DeviceStatResult>;
  dirs?: Record<string, string[]>;
}): DeviceHostProbe {
  return {
    stat: (p) => spec.stats?.[p] ?? null,
    readdir: (p) => spec.dirs?.[p] ?? [],
  };
}

describe("parseDeviceEntry", () => {
  it("defaults containerPath and permissions for a bare path", () => {
    assert.deepEqual(parseDeviceEntry("/dev/ttyUSB0"), {
      pathOnHost: "/dev/ttyUSB0",
      pathInContainer: "/dev/ttyUSB0",
      cgroupPermissions: "rwm",
    });
  });

  it("parses host:container with default permissions", () => {
    assert.deepEqual(parseDeviceEntry("/dev/ttyUSB0:/dev/gps0"), {
      pathOnHost: "/dev/ttyUSB0",
      pathInContainer: "/dev/gps0",
      cgroupPermissions: "rwm",
    });
  });

  it("parses the full host:container:permissions form", () => {
    assert.deepEqual(parseDeviceEntry("/dev/ttyUSB0:/dev/gps0:rw"), {
      pathOnHost: "/dev/ttyUSB0",
      pathInContainer: "/dev/gps0",
      cgroupPermissions: "rw",
    });
  });

  it("treats a two-part entry with a permission set as host:permissions (docker --device semantics)", () => {
    assert.deepEqual(parseDeviceEntry("/dev/ttyUSB0:rw"), {
      pathOnHost: "/dev/ttyUSB0",
      pathInContainer: "/dev/ttyUSB0",
      cgroupPermissions: "rw",
    });
  });

  it("throws on more than three segments", () => {
    assert.throws(
      () => parseDeviceEntry("/dev/a:/dev/b:rw:extra"),
      /Invalid device entry/,
    );
  });

  it("throws on an empty host path", () => {
    assert.throws(() => parseDeviceEntry(":/dev/b"), /Invalid device entry/);
  });

  it("throws on invalid permission letters in the three-part form", () => {
    assert.throws(
      () => parseDeviceEntry("/dev/a:/dev/b:rx"),
      /Invalid device permissions/,
    );
  });
});

describe("majorFromRdev", () => {
  it("extracts the major from bits 8-19", () => {
    assert.equal(majorFromRdev(rdevOf(116, 32)), 116);
    assert.equal(majorFromRdev(rdevOf(13, 64)), 13);
    assert.equal(majorFromRdev(rdevOf(226, 128)), 226);
  });

  it("survives large minors that push rdev past 32 bits", () => {
    // Minor 1048576 lands in the high bits (bit 20 and up), taking the
    // packed rdev past what JS bitwise operators can shift safely.
    assert.equal(majorFromRdev(rdevOf(116, 1_048_576)), 116);
  });
});

describe("directoryDeviceMajors", () => {
  it("unions stat'ed node majors with the well-known class major", () => {
    const probe = fakeProbe({
      dirs: { "/dev/snd": ["controlC0", "pcmC0D0p", "by-path"] },
      stats: {
        "/dev/snd": { kind: "directory", rdev: 0 },
        "/dev/snd/controlC0": node(116, 0),
        "/dev/snd/pcmC0D0p": node(116, 16),
        "/dev/snd/by-path": { kind: "directory", rdev: 0 },
      },
    });
    assert.deepEqual(directoryDeviceMajors("/dev/snd", probe), [116]);
  });

  it("falls back to the well-known major for an EMPTY directory (device unplugged)", () => {
    const probe = fakeProbe({ dirs: { "/dev/snd": [] } });
    assert.deepEqual(directoryDeviceMajors("/dev/snd", probe), [116]);
    assert.deepEqual(directoryDeviceMajors("/dev/input", probe), [13]);
    assert.deepEqual(directoryDeviceMajors("/dev/dri", probe), [226]);
  });

  it("matches the well-known map despite a trailing slash", () => {
    const probe = fakeProbe({ dirs: {} });
    assert.deepEqual(directoryDeviceMajors("/dev/snd/", probe), [116]);
  });

  it("returns the sorted stat'ed majors for a directory outside the well-known map", () => {
    const probe = fakeProbe({
      dirs: { "/dev/serial/by-id": ["usb-a", "usb-b"] },
      stats: {
        "/dev/serial/by-id/usb-a": node(188, 0),
        "/dev/serial/by-id/usb-b": node(166, 1),
      },
    });
    assert.deepEqual(
      directoryDeviceMajors("/dev/serial/by-id", probe),
      [166, 188],
    );
  });

  it("returns [] for an empty directory outside the well-known map", () => {
    const probe = fakeProbe({ dirs: { "/dev/custom": [] } });
    assert.deepEqual(directoryDeviceMajors("/dev/custom", probe), []);
  });
});

describe("resolveDeviceRequests", () => {
  it("routes a device node to Devices, with no rules and no binds", () => {
    const probe = fakeProbe({
      stats: { "/dev/ttyUSB0": node(188, 0) },
    });
    const resolved = resolveDeviceRequests(
      ["/dev/ttyUSB0"],
      docker,
      () => {},
      probe,
    );
    assert.deepEqual(resolved.nodes, [
      {
        pathOnHost: "/dev/ttyUSB0",
        pathInContainer: "/dev/ttyUSB0",
        cgroupPermissions: "rwm",
      },
    ]);
    assert.deepEqual(resolved.cgroupRules, []);
    assert.deepEqual(resolved.directoryBinds, []);
  });

  it("routes a directory to a bind plus per-class cgroup rules (rootful)", () => {
    const probe = fakeProbe({
      dirs: { "/dev/snd": ["controlC0"] },
      stats: {
        "/dev/snd": { kind: "directory", rdev: 0 },
        "/dev/snd/controlC0": node(116, 0),
      },
    });
    const resolved = resolveDeviceRequests(
      ["/dev/snd"],
      docker,
      () => {},
      probe,
    );
    assert.deepEqual(resolved.nodes, []);
    assert.deepEqual(resolved.cgroupRules, ["c 116:* rwm"]);
    assert.deepEqual(resolved.directoryBinds, [
      { pathOnHost: "/dev/snd", pathInContainer: "/dev/snd" },
    ]);
  });

  it("emits NO cgroup rules under a rootless runtime (rejected at create there)", () => {
    const probe = fakeProbe({
      dirs: { "/dev/snd": ["controlC0"] },
      stats: {
        "/dev/snd": { kind: "directory", rdev: 0 },
        "/dev/snd/controlC0": node(116, 0),
      },
    });
    const resolved = resolveDeviceRequests(
      ["/dev/snd"],
      podmanRootless,
      () => {},
      probe,
    );
    assert.deepEqual(resolved.cgroupRules, []);
    assert.deepEqual(resolved.directoryBinds, [
      { pathOnHost: "/dev/snd", pathInContainer: "/dev/snd" },
    ]);
  });

  it("skips a missing host path with a warning (unplugged device must not block start)", () => {
    const warnings: string[] = [];
    const resolved = resolveDeviceRequests(
      ["/dev/ttyUSB0"],
      docker,
      (m) => warnings.push(m),
      fakeProbe({}),
    );
    assert.deepEqual(resolved.nodes, []);
    assert.deepEqual(resolved.cgroupRules, []);
    assert.deepEqual(resolved.directoryBinds, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\/dev\/ttyUSB0 does not exist/);
  });

  it("skips a path that is neither a device node nor a directory, with a warning", () => {
    const warnings: string[] = [];
    const resolved = resolveDeviceRequests(
      ["/etc/passwd"],
      docker,
      (m) => warnings.push(m),
      fakeProbe({ stats: { "/etc/passwd": { kind: "other", rdev: 0 } } }),
    );
    assert.deepEqual(resolved.nodes, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /neither a device node nor a directory/);
  });

  it("dedupes cgroup rules across directories sharing a device class", () => {
    const probe = fakeProbe({
      dirs: { "/dev/snd": ["c0"], "/dev/other": ["c1"] },
      stats: {
        "/dev/snd": { kind: "directory", rdev: 0 },
        "/dev/snd/c0": node(116, 0),
        "/dev/other": { kind: "directory", rdev: 0 },
        "/dev/other/c1": node(116, 5),
      },
    });
    const resolved = resolveDeviceRequests(
      ["/dev/snd", "/dev/other"],
      docker,
      () => {},
      probe,
    );
    assert.deepEqual(resolved.cgroupRules, ["c 116:* rwm"]);
    assert.equal(resolved.directoryBinds.length, 2);
  });
});

describe("resolveGroupAdd", () => {
  const etcGroup = () =>
    [
      "root:x:0:",
      "# comment line",
      "audio:x:29:pi",
      "dialout:x:20:pi",
      "malformed-line",
      "video:x:44:",
    ].join("\n");

  it("resolves group names to host GIDs via /etc/group", () => {
    assert.deepEqual(
      resolveGroupAdd(["audio", "dialout"], () => {}, etcGroup),
      ["29", "20"],
    );
  });

  it("passes numeric entries through untouched", () => {
    assert.deepEqual(
      resolveGroupAdd([29, "44"], () => {}, etcGroup),
      ["29", "44"],
    );
  });

  it("skips an unknown name with a warning", () => {
    const warnings: string[] = [];
    assert.deepEqual(
      resolveGroupAdd(
        ["nonexistent", "audio"],
        (m) => warnings.push(m),
        etcGroup,
      ),
      ["29"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no such group/);
  });

  it("treats an unreadable /etc/group as 'no names resolvable' (numerics still pass)", () => {
    const warnings: string[] = [];
    assert.deepEqual(
      resolveGroupAdd(
        ["audio", 29],
        (m) => warnings.push(m),
        () => null,
      ),
      ["29"],
    );
    assert.equal(warnings.length, 1);
  });

  it("dedupes a name and its numeric GID", () => {
    assert.deepEqual(
      resolveGroupAdd(["audio", 29, "29"], () => {}, etcGroup),
      ["29"],
    );
  });

  it("throws on a negative or non-integer numeric entry", () => {
    assert.throws(() => resolveGroupAdd([-1], () => {}, etcGroup), /Invalid/);
    assert.throws(() => resolveGroupAdd([1.5], () => {}, etcGroup), /Invalid/);
  });

  it("returns [] for an empty list without reading /etc/group", () => {
    assert.deepEqual(
      resolveGroupAdd(
        [],
        () => {},
        () => {
          throw new Error("must not be called");
        },
      ),
      [],
    );
  });
});
