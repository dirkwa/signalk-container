import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { UpdateCacheFile, UpdateCheckResult } from "./types.js";

/**
 * Persistent storage for the most recent successful UpdateCheckResult
 * per registration. Survives Signal K restarts so a boat at sea that
 * powers up mid-ocean still sees its last-known-good check rather than
 * "unknown".
 *
 * The interface lets tests inject an in-memory implementation.
 */
export interface UpdateCache {
  load(): Record<string, UpdateCheckResult>;
  save(results: Record<string, UpdateCheckResult>): void;
}

/**
 * File-backed cache. Reads on construction is the caller's job (the
 * service calls load() once on startup); writes happen after each
 * successful check. Failures are non-fatal — a corrupted cache file
 * just means we start fresh on next boot.
 */
export class FileUpdateCache implements UpdateCache {
  constructor(
    private readonly path: string,
    private readonly debug: (msg: string) => void = () => {},
  ) {}

  load(): Record<string, UpdateCheckResult> {
    if (!existsSync(this.path)) {
      this.debug(`[updates] no cache file at ${this.path}`);
      return {};
    }
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as UpdateCacheFile;
      if (
        !parsed ||
        parsed.version !== 1 ||
        typeof parsed.results !== "object"
      ) {
        this.debug(`[updates] cache file shape invalid, starting fresh`);
        return {};
      }
      return parsed.results;
    } catch (err) {
      this.debug(
        `[updates] cache file unreadable (${err instanceof Error ? err.message : err}), starting fresh`,
      );
      return {};
    }
  }

  save(results: Record<string, UpdateCheckResult>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const file: UpdateCacheFile = { version: 1, results };
      writeFileSync(this.path, JSON.stringify(file, null, 2), "utf-8");
    } catch (err) {
      this.debug(
        `[updates] cache write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * In-memory cache, used by tests and as a fallback when the data
 * directory is not writable.
 */
export class MemoryUpdateCache implements UpdateCache {
  private data: Record<string, UpdateCheckResult> = {};

  load(): Record<string, UpdateCheckResult> {
    return { ...this.data };
  }

  save(results: Record<string, UpdateCheckResult>): void {
    this.data = { ...results };
  }
}
