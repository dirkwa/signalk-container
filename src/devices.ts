/**
 * Device-access translation for managed containers: `ContainerConfig.devices`
 * (device nodes and hot-plug device directories) and
 * `ContainerConfig.groupAdd` (supplementary groups).
 *
 * Everything here is host-state-dependent (fs stats, `/etc/group`), so the
 * host reads go through injectable probes with module-level test overrides —
 * the same pattern as `_setCurrentHostIdsForTesting` in `runtime.ts`. Both
 * `buildCreateOptions` and `diffContainerConfig` resolve through these
 * helpers so the emitted payload and the drift mirror can never diverge.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ContainerRuntimeInfo } from "./types.js";

/**
 * Character-device majors for well-known hot-plug device directories. A
 * directory entry must emit its device-class cgroup rule even when the
 * directory is EMPTY at container-create time (USB speakerphone unplugged
 * on a boat), otherwise the device stays unusable after a replug until the
 * container is recreated — so the class major cannot be derived from the
 * directory contents alone.
 */
export const WELL_KNOWN_DIRECTORY_MAJORS: Readonly<Record<string, number>> = {
  "/dev/snd": 116, // ALSA sound devices
  "/dev/input": 13, // input event devices (keyboards, rotary encoders, …)
  "/dev/dri": 226, // DRM / GPU render nodes
};

/** Default cgroup permissions for `--device`-style entries. */
const DEFAULT_DEVICE_PERMISSIONS = "rwm";

/** Docker `--device` permission letters: read, write, mknod. */
const DEVICE_PERMISSIONS_RE = /^[rwm]{1,3}$/;

/** What a device-entry host path resolved to on this host. */
export interface DeviceStatResult {
  kind: "device-node" | "directory" | "other";
  /** Raw `st_rdev`; meaningful only for `kind: "device-node"`. */
  rdev: number;
}

/**
 * Host filesystem view used to classify device entries and derive device
 * majors. Tests inject a fake; production uses `fsDeviceProbe`.
 */
export interface DeviceHostProbe {
  /** `stat` the path, following symlinks; `null` when it does not exist. */
  stat(p: string): DeviceStatResult | null;
  /** Directory entry names; empty array when unreadable. */
  readdir(p: string): string[];
}

export const fsDeviceProbe: DeviceHostProbe = {
  stat(p: string): DeviceStatResult | null {
    try {
      const st = statSync(p);
      if (st.isCharacterDevice() || st.isBlockDevice()) {
        return { kind: "device-node", rdev: st.rdev };
      }
      return { kind: st.isDirectory() ? "directory" : "other", rdev: 0 };
    } catch {
      return null;
    }
  },
  readdir(p: string): string[] {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

let currentDeviceProbe: DeviceHostProbe = fsDeviceProbe;

/**
 * Test-only override for the device host probe, mirroring
 * `_setCurrentHostIdsForTesting`. Pass `null` to restore the real
 * filesystem probe.
 */
export function _setDeviceProbeForTesting(probe: DeviceHostProbe | null): void {
  currentDeviceProbe = probe ?? fsDeviceProbe;
}

/**
 * Extract the device major from a raw `st_rdev`. Linux packs the major
 * into bits 8–19 (`(rdev >> 8) & 0xfff`); written in arithmetic form
 * because `st_rdev` is not bounded to 32 bits and JS bitwise operators
 * truncate.
 */
export function majorFromRdev(rdev: number): number {
  return Math.floor(rdev / 0x100) % 0x1000;
}

/** One parsed `hostPath[:containerPath[:permissions]]` device entry. */
export interface DeviceNodeSpec {
  pathOnHost: string;
  pathInContainer: string;
  cgroupPermissions: string;
}

/**
 * Parse one `ContainerConfig.devices` entry using docker `--device`
 * semantics: `hostPath[:containerPath[:permissions]]`, where a two-part
 * entry whose second segment is a valid permission set (`r`/`w`/`m`
 * letters) means "same path in-container with these permissions".
 * Throws on malformed input — a bad entry is a consumer-plugin bug and
 * should fail loudly at `ensureRunning` time, unlike a merely-unplugged
 * device (see `resolveDeviceRequests`).
 */
export function parseDeviceEntry(entry: string): DeviceNodeSpec {
  const parts = entry.split(":");
  if (parts.length > 3 || parts[0] === "") {
    throw new Error(
      `Invalid device entry "${entry}": expected hostPath[:containerPath[:permissions]]`,
    );
  }
  if (parts.length === 3) {
    if (!DEVICE_PERMISSIONS_RE.test(parts[2])) {
      throw new Error(
        `Invalid device permissions "${parts[2]}" in "${entry}": expected a combination of r, w, m`,
      );
    }
    return {
      pathOnHost: parts[0],
      pathInContainer: parts[1],
      cgroupPermissions: parts[2],
    };
  }
  if (parts.length === 2) {
    return DEVICE_PERMISSIONS_RE.test(parts[1])
      ? {
          pathOnHost: parts[0],
          pathInContainer: parts[0],
          cgroupPermissions: parts[1],
        }
      : {
          pathOnHost: parts[0],
          pathInContainer: parts[1],
          cgroupPermissions: DEFAULT_DEVICE_PERMISSIONS,
        };
  }
  return {
    pathOnHost: entry,
    pathInContainer: entry,
    cgroupPermissions: DEFAULT_DEVICE_PERMISSIONS,
  };
}

/**
 * Device majors to open up for a hot-plug device directory: the union of
 * the majors of the device nodes currently inside it and the well-known
 * class major for the directory (so an empty directory still yields its
 * class rule). Sorted ascending for deterministic emission.
 */
export function directoryDeviceMajors(
  dirPath: string,
  probe: DeviceHostProbe = currentDeviceProbe,
): number[] {
  const majors = new Set<number>();
  const wellKnown = WELL_KNOWN_DIRECTORY_MAJORS[stripTrailingSlashes(dirPath)];
  if (wellKnown !== undefined) majors.add(wellKnown);
  for (const name of probe.readdir(dirPath)) {
    const st = probe.stat(path.posix.join(dirPath, name));
    if (st?.kind === "device-node") majors.add(majorFromRdev(st.rdev));
  }
  return [...majors].sort((a, b) => a - b);
}

/** A hot-plug device-directory bind (host path mounted into the container). */
export interface DeviceDirectoryBind {
  pathOnHost: string;
  pathInContainer: string;
}

/**
 * The create-payload fragments a `ContainerConfig.devices` list resolves
 * to on this host, given the runtime:
 *
 *   - `nodes` → `HostConfig.Devices` (static device nodes; applied at
 *     create time, so a node replaced by a replug needs a recreate)
 *   - `cgroupRules` → `HostConfig.DeviceCgroupRules` (`c <major>:* rwm`
 *     per device class of each directory entry)
 *   - `directoryBinds` → extra `HostConfig.Binds` entries (the hot-plug
 *     directory itself, so nodes appearing after a replug are visible)
 *
 * `cgroupRules` is always empty under a rootless runtime: the device
 * cgroup controller is not delegated to unprivileged users and rootless
 * podman rejects the field at container create ("device cgroup rules are
 * not supported in rootless mode or in a user namespace" — verified live
 * on podman 5.4.2). Rootless device access is instead gated by plain file
 * permissions on the bound nodes, which is what `groupAdd` +
 * keep-original-groups solve.
 */
export interface ResolvedDeviceRequests {
  nodes: DeviceNodeSpec[];
  cgroupRules: string[];
  directoryBinds: DeviceDirectoryBind[];
}

/**
 * Resolve a `ContainerConfig.devices` list against the current host
 * state. An entry whose host path does not exist (device unplugged) is
 * skipped with a warning — same philosophy as the `ifMissing: "skip"`
 * volume policy: a missing USB device must never prevent container
 * start. An entry that exists but is neither a device node nor a
 * directory is skipped with a warning too (the runtime would reject it
 * at create time).
 */
export function resolveDeviceRequests(
  devices: readonly string[],
  runtime: ContainerRuntimeInfo,
  warn: (msg: string) => void = () => {},
  probe: DeviceHostProbe = currentDeviceProbe,
): ResolvedDeviceRequests {
  const nodes: DeviceNodeSpec[] = [];
  const cgroupRules = new Set<string>();
  const directoryBinds: DeviceDirectoryBind[] = [];

  for (const entry of devices) {
    const spec = parseDeviceEntry(entry);
    const st = probe.stat(spec.pathOnHost);
    if (st === null) {
      warn(
        `Skipping device "${entry}": host path ${spec.pathOnHost} does not exist (device unplugged?)`,
      );
      continue;
    }
    if (st.kind === "device-node") {
      nodes.push(spec);
      continue;
    }
    if (st.kind === "directory") {
      directoryBinds.push({
        pathOnHost: spec.pathOnHost,
        pathInContainer: spec.pathInContainer,
      });
      if (runtime.isRootless !== true) {
        for (const major of directoryDeviceMajors(spec.pathOnHost, probe)) {
          cgroupRules.add(`c ${major}:* rwm`);
        }
      }
      continue;
    }
    warn(
      `Skipping device "${entry}": ${spec.pathOnHost} is neither a device node nor a directory`,
    );
  }

  return { nodes, cgroupRules: [...cgroupRules].sort(), directoryBinds };
}

/**
 * OCI annotation that makes crun keep the container process's original
 * (host) supplementary groups instead of dropping them when it sets up
 * the user namespace. This is the load-bearing half of rootless-podman
 * device access: under rootless, device nodes carry their HOST owner and
 * group (e.g. `root:audio` for `/dev/snd/*`), the userns leaves both
 * unmapped, and any GID passed via `GroupAdd` maps to a meaningless
 * subordinate GID — so the only way the container process can pass the
 * kernel's permission check on the node is to keep the calling user's
 * own host groups. Verified live on rootless podman 5.4.2: with the
 * annotation a keep-id container reads `/dev/snd/timer`; without it the
 * same read fails with EACCES.
 *
 * Note this is deliberately NOT the CLI's `--group-add keep-groups`
 * sugar: over the docker-compat create API podman treats a literal
 * `keep-groups` in `HostConfig.GroupAdd` as a group *name* and fails the
 * container at start ("Unable to find group keep-groups"). The
 * annotation is the API-level spelling. Docker must never receive it
 * (it's crun-specific; runtimes without support ignore annotations, so
 * an old podman degrades to "groups dropped" rather than an error).
 */
export const KEEP_ORIGINAL_GROUPS_ANNOTATION = "run.oci.keep_original_groups";

/** `/etc/group` reader; `null` when unreadable (non-Linux). */
export type EtcGroupReader = () => string | null;

const readEtcGroup: EtcGroupReader = () => {
  try {
    return readFileSync("/etc/group", "utf8");
  } catch {
    return null;
  }
};

let currentEtcGroupReader: EtcGroupReader = readEtcGroup;

/**
 * Test-only override for the `/etc/group` reader. Pass `null` to restore
 * the real file read.
 */
export function _setEtcGroupReaderForTesting(
  reader: EtcGroupReader | null,
): void {
  currentEtcGroupReader = reader ?? readEtcGroup;
}

/** Parse `/etc/group` content into a name → GID map. */
function parseEtcGroup(content: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of content.split("\n")) {
    // Format: `name:password:gid:members`.
    const fields = line.split(":");
    if (fields.length < 3 || fields[0] === "" || fields[0].startsWith("#")) {
      continue;
    }
    const gid = Number(fields[2]);
    if (Number.isInteger(gid) && gid >= 0) out.set(fields[0], gid);
  }
  return out;
}

/**
 * Resolve a `ContainerConfig.groupAdd` list to the numeric-GID strings
 * the runtime should receive in `HostConfig.GroupAdd`.
 *
 * Group NAMES are resolved against the HOST's `/etc/group`, never passed
 * through: docker and podman resolve a name against the CONTAINER
 * image's `/etc/group`, where `audio` may be a different GID than on the
 * host (or absent) — and it is the host GID that the kernel checks when
 * the container process opens a host device node. A name the host does
 * not know is skipped with a warning. Numeric entries (numbers or digit
 * strings) pass through untouched. Duplicates are dropped.
 */
export function resolveGroupAdd(
  groupAdd: ReadonlyArray<string | number>,
  warn: (msg: string) => void = () => {},
  readGroups: EtcGroupReader = currentEtcGroupReader,
): string[] {
  const out: string[] = [];
  let hostGroups: Map<string, number> | undefined;
  for (const entry of groupAdd) {
    if (typeof entry === "number") {
      if (!Number.isInteger(entry) || entry < 0) {
        throw new Error(
          `Invalid groupAdd entry ${String(entry)}: expected a non-negative integer GID or a group name`,
        );
      }
      pushUnique(out, String(entry));
      continue;
    }
    const name = entry.trim();
    if (/^\d+$/.test(name)) {
      pushUnique(out, name);
      continue;
    }
    if (hostGroups === undefined) {
      const content = readGroups();
      hostGroups = content === null ? new Map() : parseEtcGroup(content);
    }
    const gid = hostGroups.get(name);
    if (gid === undefined) {
      warn(
        `Skipping groupAdd entry "${name}": no such group in the host's /etc/group`,
      );
      continue;
    }
    pushUnique(out, String(gid));
  }
  return out;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function stripTrailingSlashes(p: string): string {
  let end = p.length;
  while (end > 1 && p[end - 1] === "/") end--;
  return p.slice(0, end);
}
