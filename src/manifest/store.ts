import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Check } from "typebox/value";
import type { ContainerConfig, ResolveResult } from "../types.js";
import { atomicWriteJson } from "./atomicWrite.js";
import {
  ConsumerManifestSchema,
  type ConsumerManifest,
  type ContainerManifestEntry,
  type HistoryEntry,
} from "./schema.js";

const MAX_HISTORY = 20;

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
      const pluginId = entry.name.slice(0, -".json".length);
      const m = await this.get(pluginId);
      if (m) out.push(m);
    }
    return out;
  }

  async getContainerHistory(containerName: string): Promise<HistoryEntry[]> {
    for (const manifest of await this.list()) {
      const entry = manifest.containers[containerName];
      if (entry) return entry.history;
    }
    return [];
  }

  async recordResolution(params: {
    pluginId: string;
    pluginVersion: string;
    containerName: string;
    config: Pick<ContainerConfig, "image" | "tag" | "digest" | "updateChannel">;
    resolved: ResolveResult;
    reason: HistoryEntry["reason"];
  }): Promise<void> {
    const prev = this.queue.get(params.pluginId) ?? Promise.resolve();
    const next = prev
      .then(() => this.doRecord(params))
      .catch((err) => {
        this.debug(
          `[manifest] ${params.pluginId}: record failed (${err instanceof Error ? err.message : err})`,
        );
      });
    this.queue.set(params.pluginId, next);
    return next;
  }

  private async doRecord(params: {
    pluginId: string;
    pluginVersion: string;
    containerName: string;
    config: Pick<ContainerConfig, "image" | "tag" | "digest" | "updateChannel">;
    resolved: ResolveResult;
    reason: HistoryEntry["reason"];
  }): Promise<void> {
    const path = this.pathFor(params.pluginId);
    const existingFileExists = existsSync(path);
    const existing = await this.get(params.pluginId);
    if (existingFileExists && !existing) {
      // load() returned null but the file is on disk — schema mismatch
      // or parse failure. Don't overwrite; the user/operator can fix it.
      return;
    }

    const priorEntry = existing?.containers[params.containerName];
    const from = priorEntry?.resolvedDigest ?? null;
    const to = params.resolved.resolvedDigest;
    const ts = this.now();
    const channel = params.config.updateChannel ?? `tag:${params.config.tag}`;

    let reason: HistoryEntry["reason"];
    if (from === null) reason = "plugin-install";
    else if (from !== to) reason = "plugin-update";
    else reason = params.reason;

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
  }

  private pathFor(pluginId: string): string {
    return join(this.baseDir, `${pluginId}.json`);
  }
}
