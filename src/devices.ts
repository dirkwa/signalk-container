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
import type { HostDeviceProbeResult } from "./types.js";
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
  /**
   * True when the entry was emitted WITHOUT a local stat confirming the
   * host path exists (see the optimistic branch in
   * `resolveDeviceRequests`). The create path uses this to recognize
   * which binds to drop when the runtime rejects the create because the
   * path is missing on the real host.
   */
  unverified?: boolean;
}

/**
 * One per-entry disposition from `resolveDeviceRequests`, for surfacing
 * through logs and the deployment doctor. `skipped` entries were dropped
 * from the emission; `optimistic` entries were emitted unverified.
 */
export interface DeviceRequestIssue {
  /** The original `ContainerConfig.devices` entry string. */
  entry: string;
  /** Canonical host path the entry parsed to (trailing slashes stripped). */
  hostPath: string;
  disposition: "skipped" | "optimistic";
  /** Human-readable explanation; safe to surface to the operator. */
  reason: string;
}

/**
 * Container label recording device entries that the REAL host rejected at
 * create time (fallback path in `ensureRunning`): the manager could not
 * see the path locally, emitted it optimistically, and the runtime failed
 * the create because the path is missing on the host too. Value is a JSON
 * array of canonical host paths. `diffContainerConfig` reads it back from
 * the live container so the reconcile loop doesn't recreate forever over
 * a bind the host can never satisfy; the exclusion holds only while the
 * manager still cannot see the path (see `filterUnresolvedDeviceEntries`).
 */
export const DEVICES_UNRESOLVED_LABEL = "io.signalk.devices-unresolved";

/** Parse the `DEVICES_UNRESOLVED_LABEL` value; invalid/absent → []. */
export function parseUnresolvedDevicesLabel(
  value: string | undefined,
): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/**
 * Drop device entries recorded as unresolved on the live container — but
 * only while the manager STILL cannot see the host path. The moment the
 * path becomes visible (device plugged in and the path mounted into a
 * containerized manager, or the manager runs bare-metal), the entry is
 * kept, the diff sees the live container lacks it, and the normal drift
 * recreate applies it for real.
 */
export function filterUnresolvedDeviceEntries(
  entries: readonly string[],
  unresolvedHostPaths: readonly string[],
  probe: DeviceHostProbe = currentDeviceProbe,
): string[] {
  if (unresolvedHostPaths.length === 0) return [...entries];
  return entries.filter((entry) => {
    let hostPath: string;
    try {
      hostPath = stripTrailingSlashes(parseDeviceEntry(entry).pathOnHost);
    } catch {
      return true;
    }
    if (!unresolvedHostPaths.includes(hostPath)) return true;
    return probe.stat(hostPath) !== null;
  });
}

/**
 * Drop live node-device entries whose host path is currently absent, for
 * the docker drift comparison. Docker reports `HostConfig.Devices` back
 * through inspect, so a node present at create time but unplugged since
 * (USB serial/GPS dongle pulled) still shows up live while the requested
 * emission — host-probed through `resolveDeviceRequests` — has already
 * dropped it. Comparing the two as-is would fire `devices` drift and
 * recreate the container over the unplug, contradicting the "a missing
 * device must never disturb the container" policy that governs the
 * requested side. Filtering the live side by the same probe restores the
 * symmetry the podman branch gets for free (both its sides are
 * host-probed). Only node devices are subject to this; directory-device
 * binds compare through volumes and are unaffected.
 */
export function presentLiveDeviceNodes(
  liveNodes: readonly DeviceNodeSpec[],
  probe: DeviceHostProbe = currentDeviceProbe,
): DeviceNodeSpec[] {
  return liveNodes.filter((n) => probe.stat(n.pathOnHost) !== null);
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
  /** Per-entry dispositions worth surfacing (skips and unverified emissions). */
  issues: DeviceRequestIssue[];
}

/**
 * Resolve a `ContainerConfig.devices` list against the current host
 * state. An entry whose host path does not exist (device unplugged) is
 * skipped with a warning — same philosophy as the `ifMissing: "skip"`
 * volume policy: a missing USB device must never prevent container
 * start. An entry that exists but is neither a device node nor a
 * directory is skipped with a warning too (the runtime would reject it
 * at create time).
 *
 * Exception — the optimistic branch: when the manager itself runs inside
 * a container (`runtime.isContainerized`), its filesystem is NOT the
 * filesystem the runtime resolves bind sources against, so "the path
 * does not exist here" proves nothing about the host. A missing path
 * that is a well-known hot-plug directory is then emitted UNVERIFIED
 * (bind + class cgroup rule from `WELL_KNOWN_DIRECTORY_MAJORS` — the
 * exact reason that table exists) and marked `unverified` so the create
 * path can fall back if the real host rejects it. Non-well-known paths
 * stay skipped even when containerized: without a stat there is no way
 * to classify node vs directory, and guessing wrong fails the create on
 * hosts where the device IS present.
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
  const issues: DeviceRequestIssue[] = [];

  for (const entry of devices) {
    const spec = parseDeviceEntry(entry);
    const canonicalHostPath = stripTrailingSlashes(spec.pathOnHost);
    const st = probe.stat(spec.pathOnHost);
    if (st === null) {
      if (
        runtime.isContainerized === true &&
        WELL_KNOWN_DIRECTORY_MAJORS[canonicalHostPath] !== undefined
      ) {
        const reason =
          `Device "${entry}" is not visible from inside the Signal K ` +
          `container; emitting it unverified — the runtime resolves the ` +
          `bind against the real host, where it may exist`;
        warn(reason);
        issues.push({
          entry,
          hostPath: canonicalHostPath,
          disposition: "optimistic",
          reason,
        });
        directoryBinds.push({
          pathOnHost: spec.pathOnHost,
          pathInContainer: spec.pathInContainer,
          unverified: true,
        });
        if (runtime.isRootless !== true) {
          for (const major of directoryDeviceMajors(spec.pathOnHost, probe)) {
            cgroupRules.add(`c ${major}:* rwm`);
          }
        }
        continue;
      }
      const reason = `Skipping device "${entry}": host path ${spec.pathOnHost} does not exist (device unplugged?)`;
      warn(reason);
      issues.push({
        entry,
        hostPath: canonicalHostPath,
        disposition: "skipped",
        reason,
      });
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
    const reason = `Skipping device "${entry}": ${spec.pathOnHost} is neither a device node nor a directory`;
    warn(reason);
    issues.push({
      entry,
      hostPath: canonicalHostPath,
      disposition: "skipped",
      reason,
    });
  }

  return {
    nodes,
    cgroupRules: [...cgroupRules].sort(),
    directoryBinds,
    issues,
  };
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

/**
 * The `groupAdd` group names that `resolveGroupAdd` would drop against
 * the current host `/etc/group` — names the host does not know. Numeric
 * entries and resolvable names never appear. Mirrors the `.issues` shape
 * `resolveDeviceRequests` returns so `ensureRunning` can surface group
 * skips through the same operator channel as device skips; kept as a
 * companion probe (rather than folded into `resolveGroupAdd`'s return)
 * so the resolver's `string[]` signature and its call sites stay stable.
 */
export function unresolvedGroupNames(
  groupAdd: ReadonlyArray<string | number>,
  readGroups: EtcGroupReader = currentEtcGroupReader,
): string[] {
  const missing: string[] = [];
  let hostGroups: Map<string, number> | undefined;
  for (const entry of groupAdd) {
    if (typeof entry === "number") continue;
    const name = entry.trim();
    if (/^\d+$/.test(name)) continue;
    if (hostGroups === undefined) {
      const content = readGroups();
      hostGroups = content === null ? new Map() : parseEtcGroup(content);
    }
    if (hostGroups.get(name) === undefined && !missing.includes(name)) {
      missing.push(name);
    }
  }
  return missing;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function stripTrailingSlashes(p: string): string {
  let end = p.length;
  while (end > 1 && p[end - 1] === "/") end--;
  return p.slice(0, end);
}


/** Parse an `/etc/group` body into gid -> name. */
export function parseGroupNames(contents: string): Map<number, string> {
  const byGid = new Map<number, string>();
  for (const line of contents.split("\n")) {
    // name:password:gid:members
    const parts = line.split(":");
    const name = parts[0];
    const gidRaw = parts[2];
    if (!name || gidRaw === undefined) continue;
    // Whole-field match only. `Number.parseInt` stops at the first
    // non-digit, so `44invalid` would parse as 44 — and because the first
    // definition wins, a malformed line ahead of the real one would shadow
    // it and hand groupAdd a name the host does not define.
    if (!/^\d+$/.test(gidRaw)) continue;
    const gid = Number.parseInt(gidRaw, 10);
    // First definition wins: /etc/group may alias a gid to several names, and
    // the earlier entry is the canonical one on every distro we care about.
    if (!Number.isNaN(gid) && !byGid.has(gid)) byGid.set(gid, name);
  }
  return byGid;
}

/**
 * Probe a host path for device nodes and the groups that own them.
 *
 * Why this cannot simply `stat()`: when Signal K runs in a container — the
 * common deployment — the plugin's filesystem is that container's, not the
 * host's. `/dev/dri` is absent there even on a machine that has a GPU, so a
 * direct check reports "no device" and the caller silently degrades. Only
 * something with a view of the host can answer, and that is the runtime.
 *
 * Two paths, cheapest first:
 *
 *  1. Not containerized, or the path happens to be bound into this container
 *     (`/dev/snd` often is): read it directly. No container involved.
 *  2. Containerized and the path is not visible: run a throwaway container
 *     with the path bind-mounted read-only and read it from there. `image`
 *     must already be present on the host — this deliberately never pulls,
 *     because a device check should not depend on the network. When no usable
 *     image is available the probe returns null, meaning "unknown", which is
 *     NOT the same as `{ exists: false }`.
 */
export async function probeHostDevice(
  path: string,
  options: {
    containerized: boolean;
    /** Reads a directory on this process's own filesystem. */
    readDir: (p: string) => Promise<string[]>;
    /** Stats a path on this process's own filesystem. */
    statPath: (p: string) => Promise<{ isCharacterDevice: boolean; gid: number }>;
    /** Reads a file on this process's own filesystem. */
    readFile: (p: string) => Promise<string>;
    /** Runs the probe inside a container; null when none can be run. */
    runInContainer?: (
      hostPath: string,
    ) => Promise<{ nodes: string[]; gids: number[]; groupFile: string } | null>;
    debug?: (msg: string) => void;
  },
): Promise<HostDeviceProbeResult | null> {
  const debug = options.debug ?? (() => {});

  const fromLocal = await readDeviceDir(path, options);

  if (!options.containerized) {
    // Bare metal: what this process sees IS the host, so a local read is the
    // final answer either way.
    return fromLocal ?? { exists: false, nodes: [], groups: [] };
  }

  // Containerized: only trust a local read that actually found something. An
  // empty or absent path here says nothing about the host — that is the whole
  // reason this probe exists — so fall through and ask the runtime.
  //
  // Even then, the NAMES it resolved came from this container's /etc/group,
  // which need not agree with the host's: the gids on the nodes are the
  // host's, so a container whose group file numbers them differently would
  // produce a name that means nothing to groupAdd. Prefer the runtime, which
  // reads the host's own group file, and fall back to the local read only when
  // no probe can run.
  if (fromLocal?.exists && !options.runInContainer) return fromLocal;

  if (!options.runInContainer) {
    debug(`probeHostDevice: ${path} not visible here and no probe runner`);
    return null;
  }

  const remote = await options.runInContainer(path);
  if (!remote) {
    debug(`probeHostDevice: could not probe ${path} via the runtime`);
    // A local read still beats nothing — the nodes are real even if the names
    // came from the wrong group file.
    return fromLocal?.exists ? fromLocal : null;
  }

  // The probe ran and found nothing: a definite absence, not "could not tell".
  if (remote.nodes.length === 0) {
    return { exists: false, nodes: [], groups: [] };
  }

  const names = parseGroupNames(remote.groupFile);

  // Under rootless podman every gid read inside the probe comes back as the
  // overflow id, so the numbers carry no information.
  const pairs = remote.nodes.map((node, i) => ({
    node,
    gid: remote.gids[i] ?? OVERFLOW_GID,
  }));
  const groups = resolveNodeGroups(pairs, names);

  // Nothing resolvable — /dev/snd and /dev/input have no convention to fall
  // back on. Answering `exists: true` with no groups would have the caller pass
  // the device through with nothing able to open it, failing silently at
  // runtime. "Unknown" is the honest answer.
  if (groups === null) return null;

  return {
    exists: true,
    nodes: [...remote.nodes].sort(),
    groups,
  };
}

/** Read a device directory on this process's own filesystem. */
async function readDeviceDir(
  devicePath: string,
  options: {
    readDir: (p: string) => Promise<string[]>;
    statPath: (p: string) => Promise<{ isCharacterDevice: boolean; gid: number }>;
    readFile: (p: string) => Promise<string>;
  },
): Promise<HostDeviceProbeResult | null> {
  // A single node (`/dev/dri/card0`) is as valid a thing to ask about as a
  // directory; readdir on one fails with ENOTDIR, which is not "absent".
  try {
    const st = await options.statPath(devicePath);
    if (st.isCharacterDevice) {
      const name = devicePath.slice(devicePath.lastIndexOf("/") + 1);
      let groupFile = "";
      try {
        groupFile = await options.readFile("/etc/group");
      } catch {
        // Unreadable: numeric gid below.
      }
      const groups = resolveNodeGroups(
        [{ node: name, gid: st.gid }],
        parseGroupNames(groupFile),
      );
      if (groups === null) return null;
      return { exists: true, nodes: [name], groups };
    }
  } catch {
    // Not there, or not statable: fall through to the directory attempt.
  }

  const path = devicePath;
  let entries: string[];
  try {
    entries = await options.readDir(path);
  } catch {
    return null;
  }

  // Kept as pairs: a directory can hold a mapped card0 beside an overflow-gid
  // renderD128, and each needs its own group.
  const found: { node: string; gid: number }[] = [];
  for (const entry of entries) {
    try {
      const st = await options.statPath(`${path}/${entry}`);
      // Only character devices are device nodes; skip `by-path/` and friends.
      if (!st.isCharacterDevice) continue;
      found.push({ node: entry, gid: st.gid });
    } catch {
      // Vanished between listing and stat (hot-unplug): ignore it.
    }
  }
  const nodes = found.map((f) => f.node);

  if (nodes.length === 0) return { exists: false, nodes: [], groups: [] };

  let groupFile = "";
  try {
    groupFile = await options.readFile("/etc/group");
  } catch {
    // Unreadable: fall back to numeric gids below.
  }

  const names = parseGroupNames(groupFile);
  // Same per-node rule as a remote read.
  const groups = resolveNodeGroups(found, names);
  if (groups === null) return null;

  return { exists: true, nodes: nodes.sort(), groups };
}

/**
 * The kernel's "this id is not mapped here" gid, reported by a user namespace
 * for any owner outside its range. 65534 (`nobody`) is the value Linux uses.
 */
export const OVERFLOW_GID = 65534;

/**
 * Conventional owning group for a DRM node, by udev naming.
 *
 * Needed because **rootless podman remaps ownership**: a rootless user
 * namespace maps only the subgid range (`dirk:100000:65536` here), so host gid
 * 44 falls outside it and every route into that namespace — a probe container,
 * `--userns=host`, `--userns=keep-id`, even `podman unshare` — reports the
 * overflow gid instead of 44. The numeric owner is simply not knowable from
 * inside.
 *
 * The FILE content is undistorted, though, so a name from udev convention can
 * be confirmed against the host's own /etc/group rather than guessed at.
 */
export function conventionalDrmGroup(node: string): string | null {
  if (node.startsWith("renderD")) return "render";
  if (node.startsWith("card")) return "video";
  return null;
}


/**
 * Resolve the group for each device node individually.
 *
 * Per node rather than over a flat set of gids: a directory can hold a mapped
 * `card0` (gid 44 -> video) beside an overflow-gid `renderD128`, and treating
 * the gids as one list drops whichever rule loses. The consumer would then
 * pass `renderD128` through with no group able to open it.
 *
 * A node whose gid is readable resolves by gid. One reported as the overflow
 * id falls back to udev's convention, kept only when the host defines that
 * name. A node that resolves to neither contributes nothing.
 *
 * @returns the group names, or null when NO node could be resolved — unknown,
 * which is not the same as "no groups needed".
 */
export function resolveNodeGroups(
  pairs: readonly { node: string; gid: number }[],
  names: Map<number, string>,
): string[] | null {
  const known = new Set(names.values());
  const groups = new Set<string>();
  let resolvedAny = false;

  for (const { node, gid } of pairs) {
    if (gid !== OVERFLOW_GID) {
      groups.add(names.get(gid) ?? String(gid));
      resolvedAny = true;
      continue;
    }
    const conventional = conventionalDrmGroup(node);
    if (conventional !== null && known.has(conventional)) {
      groups.add(conventional);
      resolvedAny = true;
    }
  }

  return resolvedAny ? [...groups].sort() : null;
}

/** Where the probed host path is mounted inside the probe container. */
export const PROBE_MOUNT = "/probe";

/**
 * Where the HOST's `/etc/group` is mounted inside the probe container.
 *
 * The gids on host device nodes are the host's, and a probe image does not
 * share them — Alpine has no gid 44, so reading its own group file reported
 * `video` as the bare number "44". The names have to come from the host.
 */
export const PROBE_GROUP_MOUNT = "/probe-group";

/**
 * Stand-in the probe emits when the mount IS the device node.
 *
 * The mount point is named `/probe`, so its basename would name every node
 * "probe"; the caller swaps this for the requested path's real name. A literal
 * marker rather than the path itself, so nothing caller-supplied is ever
 * interpolated into the shell command.
 */
export const PROBE_SELF_MARKER = "__self__";

/**
 * Replace the self-mount marker with the requested path's own name.
 *
 * The probe emits the marker rather than the path so nothing caller-supplied
 * reaches the shell command; the real name is restored here.
 */
export function nameSelfMountedNodes(
  nodes: string[],
  requestedPath: string,
): string[] {
  const name = requestedPath.slice(requestedPath.lastIndexOf("/") + 1);
  return nodes.map((n) => (n === PROBE_SELF_MARKER ? name : n));
}

/**
 * Ceiling on the probe container. Listing a few device nodes is a
 * milliseconds-long job, so a slower one is wedged — and a device check must
 * never hang the plugin that asked for it.
 */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * How long a probe result is reused. Device topology is near-static, and the
 * containerized path costs a container per call, so a short TTL collapses a
 * polling caller's bursts without meaningfully going stale.
 */
export const PROBE_CACHE_MS = 60_000;

/**
 * Parse the probe container's stdout.
 *
 * Format, chosen so it can be produced by a plain `sh` in any base image:
 *   N <name> <gid>      one line per character device found
 *   ---                 separator
 *   <contents of /etc/group>
 *
 * The group file is the HOST's, bind-mounted in — a probe image's own
 * /etc/group does not carry the host's gids (Alpine has no gid 44), which
 * would report `video` as the bare number "44".
 */
export function parseProbeOutput(output: string): {
  nodes: string[];
  gids: number[];
  groupFile: string;
} {
  const [devicePart = "", groupFile = ""] = output.split(/^---$/m, 2);
  const nodes: string[] = [];
  const gids: number[] = [];

  for (const line of devicePart.split("\n")) {
    const match = /^N (\S+) (\d+)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1];
    const gid = Number.parseInt(match[2] ?? "", 10);
    if (name === undefined || Number.isNaN(gid)) continue;
    nodes.push(name);
    gids.push(gid);
  }

  return { nodes, gids, groupFile };
}

/** One cached probe, keyed by path. Holds the in-flight promise, not a result. */
export interface ProbeCacheEntry {
  at: number;
  result: Promise<HostDeviceProbeResult | null>;
}

/**
 * Share one in-flight probe per path, and hold successful answers briefly.
 *
 * The containerized path spawns a container, so a plugin polling a status
 * route would otherwise start one per call, and two concurrent callers would
 * each start their own. A `null` — "could not tell" — is dropped rather than
 * held, so one inconclusive probe does not suppress retries for the whole TTL.
 *
 * Extracted from the manager method so this behaviour is testable without
 * standing up a runtime.
 */
export function cachedProbe(
  cache: Map<string, ProbeCacheEntry>,
  path: string,
  now: number,
  ttlMs: number,
  run: () => Promise<HostDeviceProbeResult | null>,
): Promise<HostDeviceProbeResult | null> {
  for (const [key, entry] of cache) {
    if (now - entry.at >= ttlMs) cache.delete(key);
  }

  const cached = cache.get(path);
  if (cached) return cached.result;

  const pending = run();
  cache.set(path, { at: now, result: pending });
  pending
    .then((r) => {
      if (r === null) cache.delete(path);
    })
    .catch(() => cache.delete(path));
  return pending;
}
