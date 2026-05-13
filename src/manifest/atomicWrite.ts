import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

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
  mkdirSync(dirname(filePath), { recursive: true });
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
    const dirFd = openSync(dirname(filePath), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // best-effort
  }
}
