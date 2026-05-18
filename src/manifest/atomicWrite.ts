import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const STALE_TMP_MS = 60 * 60 * 1000; // 1 hour

/**
 * Write JSON to a file atomically. The file is either the prior valid
 * contents or the new valid contents — never partially written — even
 * across power loss.
 *
 * Algorithm: write to a unique tmp file in the same directory, fsync
 * the data, then rename onto the target. POSIX `rename` is atomic
 * within a filesystem.
 *
 * The unique tmp suffix (pid + time + random) lets concurrent writes
 * for different targets coexist without collision. fsync is
 * best-effort — wrap in try/catch since some sandboxes don't support
 * it; the rename atomicity is the real guarantee.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  sweepStaleTmpFiles(dir, basename(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  try {
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort
  }
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — leftover tmp is harmless and cleaned on next write
    }
    throw err;
  }
  // Fsync the parent directory so the rename's directory-entry update
  // persists through a crash, not just the file's data blocks. Without
  // this, POSIX rename atomicity holds across power loss but the new
  // name may be missing from the directory after recovery. Best-effort
  // — wrap in try/catch since some sandboxes don't permit fsync on a
  // directory fd.
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // best-effort
  }
}

/**
 * Remove `.tmp.*` files matching `<basename>.tmp.*` that are older
 * than STALE_TMP_MS. These are left behind when a prior process was
 * killed between writeFileSync and renameSync; without cleanup they
 * accumulate in the manifests dir. Best-effort: any I/O error is
 * silently ignored.
 */
function sweepStaleTmpFiles(dir: string, base: string): void {
  const prefix = `${base}.tmp.`;
  const threshold = Date.now() - STALE_TMP_MS;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs < threshold) {
        unlinkSync(full);
      }
    } catch {
      // ignore — file may have been removed by a concurrent writer
    }
  }
}
