import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Check } from "typebox/value";
import type {
  ConsumerManifest,
  ContainerConfig,
  ContainerManifestEntry,
  HistoryEntry,
  ResolveResult,
} from "../types.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { ConsumerManifestSchema } from "./schema.js";

const MAX_HISTORY = 20;

/**
 * Allowed pluginId shapes. Validated at `recordResolution` time so
 * that the filename produced by `pathFor` is always safe and
 * reversible. Three accepted forms:
 *   - npm package name:    `signalk-questdb`, `mayara`
 *   - scoped npm package:  `@signalk/foo`
 *   - synthetic fallback:  `container:foo` (used when the caller
 *                          didn't pass `options.pluginId`).
 *
 * Note: hyphens, dots, and underscores are allowed in the segments
 * to match the actual npm package-name grammar; uppercase is not, to
 * match modern npm (which lowercases names on publish).
 */
const SEGMENT = "[a-z0-9][a-z0-9._-]*";
/** Prefix of the id a container is recorded under when no owner is known. */
export const SYNTHETIC_PREFIX = "container:";
const PLUGIN_ID_RE = new RegExp(
  `^(?:${SEGMENT}|@${SEGMENT}/${SEGMENT}|${SYNTHETIC_PREFIX}${SEGMENT})$`,
);

/**
 * Bijective filename encoding for the allowed pluginId set. The only
 * two characters that need transformation are `/` (legal in scoped
 * names) and `:` (legal in the synthetic fallback); both are
 * NTFS-illegal and the `/` would also escape the manifests directory
 * if joined raw. Percent-encoding is reversible and easy to read.
 */
function encodeForFilename(pluginId: string): string {
  return pluginId.replace(/\//g, "%2F").replace(/:/g, "%3A");
}

function decodeFromFilename(filename: string): string {
  return filename.replace(/%2F/g, "/").replace(/%3A/g, ":");
}

/**
 * Two histories of one container in time order, without the entries both
 * hold, trimmed to the newest MAX_HISTORY.
 */
function mergeHistory(a: HistoryEntry[], b: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  const merged: HistoryEntry[] = [];
  for (const entry of [...a, ...b].sort((x, y) => x.ts.localeCompare(y.ts))) {
    const key = `${entry.ts}|${entry.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.slice(-MAX_HISTORY);
}

/**
 * Persistent per-plugin manifests written to
 * `${dataDir}/signalk-container-manifests/<pluginId>.json`.
 *
 * Schema is enforced via TypeBox: `load()` validates every file it
 * reads and refuses to overwrite invalid or schema-mismatched files
 * (so a future-version file is preserved across downgrades).
 *
 * Writes are atomic (tmp + fsync + rename) and serialized per
 * pluginId so two concurrent `recordResolution` calls for the same
 * plugin can't lose history.
 */
export class ManifestStore {
  private queue = new Map<string, Promise<void>>();

  constructor(
    private readonly baseDir: string,
    private readonly debug: (msg: string) => void = () => {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async get(pluginId: string): Promise<ConsumerManifest | null> {
    // Defence in depth: reject path-traversal and other invalid ids
    // at every public entry point, not just `recordResolution`. The
    // bijective filename encoding makes traversal impossible anyway
    // (`/` is encoded to `%2F`), but throwing here gives consumers a
    // clear error instead of silently returning null.
    if (!PLUGIN_ID_RE.test(pluginId)) {
      throw new Error(
        `Invalid pluginId for manifest: ${JSON.stringify(pluginId)} (must be an npm package name, "@scope/name", or "container:<name>")`,
      );
    }
    const path = this.pathFor(pluginId);
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      this.debug(
        `[manifest] ${pluginId}: parse failed (${err instanceof Error ? err.message : err})`,
      );
      return null;
    }
    if (!Check(ConsumerManifestSchema, parsed)) {
      this.debug(
        `[manifest] ${pluginId}: schema mismatch at ${path}; refusing to use`,
      );
      return null;
    }
    return parsed;
  }

  async list(): Promise<ConsumerManifest[]> {
    if (!existsSync(this.baseDir)) return [];
    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const out: ConsumerManifest[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const pluginId = decodeFromFilename(entry.name.slice(0, -".json".length));
      // A hand-edited or stale filename can decode to something
      // outside the allowlist; skip rather than letting `get()`'s
      // boundary check throw.
      if (!PLUGIN_ID_RE.test(pluginId)) {
        this.debug(
          `[manifest] skipping ${entry.name}: decoded pluginId ${JSON.stringify(pluginId)} fails validation`,
        );
        continue;
      }
      const m = await this.get(pluginId);
      if (m) out.push(m);
    }
    return out;
  }

  async getContainerHistory(containerName: string): Promise<HistoryEntry[]> {
    // Collect every manifest that owns an entry for this containerName.
    // Multiple manifests *can* coexist (e.g. two plugins recording the
    // same container name), and silently returning one would hide the
    // conflict. A synthetic `container:<name>` entry is not one of them
    // for long: its real owner takes it over on the next record.
    const matches: Array<{ pluginId: string; history: HistoryEntry[] }> = [];
    for (const manifest of await this.list()) {
      const entry = manifest.containers[containerName];
      if (entry) {
        matches.push({ pluginId: manifest.pluginId, history: entry.history });
      }
    }
    if (matches.length === 0) return [];
    if (matches.length === 1) return matches[0].history;
    const owners = matches.map((m) => JSON.stringify(m.pluginId)).join(", ");
    throw new Error(
      `Ambiguous container history for ${JSON.stringify(containerName)}: ` +
        `found in ${matches.length} manifests (${owners}). ` +
        `Call \`manifest.get(pluginId)\` directly to disambiguate.`,
    );
  }

  async recordResolution(params: {
    pluginId: string;
    pluginVersion: string;
    containerName: string;
    config: Pick<ContainerConfig, "image" | "tag" | "digest" | "updateChannel">;
    resolved: ResolveResult;
    /**
     * Caller's intent for this record. Optional — when omitted the store
     * auto-detects from the digest transition:
     *   - first ever record for this container → `plugin-install`
     *   - digest changed → `plugin-update`
     *   - digest unchanged → no history entry (idempotent)
     * When provided, an explicit reason is preserved for transitions
     * (`from !== to`); the auto-detected `plugin-install` still wins for
     * the very first record so the history's origin is always honest.
     */
    reason?: HistoryEntry["reason"];
  }): Promise<void> {
    // Validate at the system boundary. Allowed shapes (see PLUGIN_ID_RE):
    // npm package name, scoped npm package, or `container:<name>`.
    // Anything else (path-traversal `../`, control chars, unicode,
    // etc.) is rejected with a clear error instead of silently
    // sharing a filename with another id.
    if (!PLUGIN_ID_RE.test(params.pluginId)) {
      throw new Error(
        `Invalid pluginId for manifest: ${JSON.stringify(params.pluginId)} (must be an npm package name, "@scope/name", or "container:<name>")`,
      );
    }
    // Run after the previous queued operation completes (success or
    // failure). The queue tail stores a fulfilled promise so a single
    // failure doesn't poison subsequent writes; the caller still gets
    // the original rejecting promise, so a `.catch()` on the wrapper
    // side observes the actual error.
    //
    // A real owner's record may take over the synthetic manifest of the
    // same container (see doRecord), so it also waits for, and holds up,
    // writes to that synthetic id.
    const keys = [params.pluginId];
    const syntheticId = this.takeoverCandidate(params);
    if (syntheticId) keys.push(syntheticId);
    const prev = Promise.all(
      keys.map((key) =>
        (this.queue.get(key) ?? Promise.resolve()).catch(() => undefined),
      ),
    );
    const op = prev.then(() => this.doRecord(params));
    const tail = op.catch((err) => {
      this.debug(
        `[manifest] ${params.pluginId}: record failed (${err instanceof Error ? err.message : err})`,
      );
    });
    for (const key of keys) this.queue.set(key, tail);
    return op;
  }

  /**
   * Drop one container's record from a plugin's manifest, for a container
   * that is gone for good. Serialized with that plugin's other writes.
   */
  async forgetContainer(
    pluginId: string,
    containerName: string,
  ): Promise<void> {
    if (!PLUGIN_ID_RE.test(pluginId)) {
      throw new Error(
        `Invalid pluginId for manifest: ${JSON.stringify(pluginId)} (must be an npm package name, "@scope/name", or "container:<name>")`,
      );
    }
    const prev = this.queue.get(pluginId) ?? Promise.resolve();
    const op = prev
      .catch(() => undefined)
      .then(async () => {
        const manifest = await this.get(pluginId);
        if (manifest?.containers[containerName]) {
          this.dropEntry(pluginId, manifest, containerName);
        }
      });
    this.queue.set(
      pluginId,
      op.catch(() => undefined),
    );
    return op;
  }

  /** The synthetic id a real owner's record may take over, if any. */
  private takeoverCandidate(params: {
    pluginId: string;
    containerName: string;
  }): string | null {
    if (params.pluginId.startsWith(SYNTHETIC_PREFIX)) return null;
    const syntheticId = `${SYNTHETIC_PREFIX}${params.containerName}`;
    return PLUGIN_ID_RE.test(syntheticId) ? syntheticId : null;
  }

  private async doRecord(params: {
    pluginId: string;
    pluginVersion: string;
    containerName: string;
    config: Pick<ContainerConfig, "image" | "tag" | "digest" | "updateChannel">;
    resolved: ResolveResult;
    reason?: HistoryEntry["reason"];
  }): Promise<void> {
    const path = this.pathFor(params.pluginId);
    const existingFileExists = existsSync(path);
    const existing = await this.get(params.pluginId);
    if (existingFileExists && !existing) {
      // load() returned null but the file is on disk — schema mismatch
      // or parse failure. Don't overwrite; the user/operator can fix it.
      return;
    }

    // A container recorded before its consumer passed a pluginId lives in
    // the synthetic `container:<name>` manifest. The real owner takes over
    // that entry, history included, so the switch does not read as a fresh
    // install and the container ends up with exactly one owner.
    const syntheticId = this.takeoverCandidate(params);
    const synthetic = syntheticId ? await this.get(syntheticId) : null;
    const adopted = synthetic?.containers[params.containerName];

    const ownEntry = existing?.containers[params.containerName];
    // Both can exist when an older signalk-container recorded the container
    // under each id; keep every recorded transition rather than either side.
    const priorEntry =
      ownEntry && adopted
        ? {
            ...ownEntry,
            history: mergeHistory(adopted.history, ownEntry.history),
          }
        : (ownEntry ?? adopted);
    const from = priorEntry?.resolvedDigest ?? null;
    const to = params.resolved.resolvedDigest;
    const ts = this.now();
    const channel = params.config.updateChannel ?? `tag:${params.config.tag}`;

    // Reason precedence:
    //   - First-ever record: always `plugin-install` (fact, not intent —
    //     it's the origin of the history regardless of what the caller
    //     was doing).
    //   - Digest changed: caller's `reason` if provided (e.g. `user-pull`
    //     from an admin click); otherwise auto-detected `plugin-update`.
    //   - Digest unchanged: idempotent, no history entry. Caller's
    //     `reason` is ignored.
    let reason: HistoryEntry["reason"];
    if (from === null) reason = "plugin-install";
    else if (from !== to) reason = params.reason ?? "plugin-update";
    else reason = params.reason ?? "plugin-install"; // unused — no append below

    const history = [...(priorEntry?.history ?? [])];
    if (from === null || from !== to) {
      history.push({
        ts,
        from,
        to,
        reason,
        triggeredBy: params.pluginVersion,
      });
      while (history.length > MAX_HISTORY) history.shift();
    }

    const entry: ContainerManifestEntry = {
      image: params.config.image,
      declaredTag: params.config.tag,
      declaredDigest: params.config.digest ?? null,
      resolvedDigest: to,
      resolvedAt: ts,
      updateChannel: channel,
      history,
    };

    const manifest: ConsumerManifest = {
      schemaVersion: 1,
      pluginId: params.pluginId,
      pluginVersion: params.pluginVersion,
      registeredAt: existing?.registeredAt ?? ts,
      containers: {
        ...(existing?.containers ?? {}),
        [params.containerName]: entry,
      },
    };
    atomicWriteJson(path, manifest);

    // Only after the real owner's write: a crash in between leaves a
    // duplicate this step removes on the next record, never a lost history.
    if (syntheticId && synthetic && adopted) {
      this.dropEntry(syntheticId, synthetic, params.containerName);
    }
  }

  private dropEntry(
    pluginId: string,
    manifest: ConsumerManifest,
    containerName: string,
  ): void {
    const rest = { ...manifest.containers };
    delete rest[containerName];
    if (Object.keys(rest).length === 0) {
      rmSync(this.pathFor(pluginId), { force: true });
      return;
    }
    atomicWriteJson(this.pathFor(pluginId), { ...manifest, containers: rest });
  }

  private pathFor(pluginId: string): string {
    // Bijective encoding so two distinct allowed pluginIds can never
    // share a filename. The boundary check in `recordResolution`
    // guarantees only `/` and `:` need encoding; other characters are
    // already filesystem-safe. `get()` is also called with pluginIds
    // sourced from `list()`'s filename-decode round-trip, which
    // produces canonical values.
    return join(this.baseDir, `${encodeForFilename(pluginId)}.json`);
  }
}
