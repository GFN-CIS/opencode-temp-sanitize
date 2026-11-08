/**
 * Age-based cleanup of project temporary directories.
 *
 * A file is stale when neither its atime nor its mtime moved within `maxAgeMs`.
 * mtime is a fallback for `noatime` mounts, where atime never advances.
 * Only regular files and symlinks are deleted; symlinks are removed themselves and never
 * followed, so a link into the user's tree cannot cause damage outside the tmp directory.
 * Sockets and FIFOs are left alone, since they may belong to a live process.
 * Directories are not judged by age: the scan itself refreshes their atime. They are
 * removed bottom-up once empty, except the directory a sweep starts from.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_AGE_MS = 48 * 60 * 60 * 1000;

const PROJECT_DIR = /^(global|.+-[0-9a-f]{8})$/;

/** Whether a top-level entry name of the shared directory is a project directory. */
export function isProjectDir(name) {
  return PROJECT_DIR.test(name);
}

function isMissing(error) {
  return error.code === "ENOENT";
}

/**
 * Deletes stale files under `dir` and prunes emptied subdirectories.
 * Entries that vanish concurrently (ENOENT) are skipped; other errors propagate.
 *
 * @returns {Promise<{files: number, dirs: number}>} counts of removed entries
 */
export async function sweepDir(dir, now, maxAgeMs = MAX_AGE_MS) {
  const removed = { files: 0, dirs: 0 };
  await walk(dir, now - maxAgeMs, removed, true);
  return removed;
}

async function walk(dir, cutoff, removed, isRoot) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(target, cutoff, removed, false);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await removeIfStale(target, cutoff, removed);
    }
  }
  if (isRoot) return;
  try {
    await fs.rmdir(dir);
    removed.dirs += 1;
  } catch (error) {
    if (!isMissing(error) && error.code !== "ENOTEMPTY") throw error;
  }
}

async function removeIfStale(file, cutoff, removed) {
  try {
    const stat = await fs.lstat(file);
    if (Math.max(stat.atimeMs, stat.mtimeMs) >= cutoff) return;
    await fs.unlink(file);
    removed.files += 1;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Sweeps every project directory directly under `sharedTmp`. Loose entries in
 * `sharedTmp` itself are left alone: they belong to OpenCode instances without this
 * plugin, and their owners decide what to keep.
 */
export async function sweepProjects(sharedTmp, now, maxAgeMs = MAX_AGE_MS) {
  const total = { files: 0, dirs: 0 };
  const entries = await fs.readdir(sharedTmp, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !isProjectDir(entry.name)) continue;
    const removed = await sweepDir(path.join(sharedTmp, entry.name), now, maxAgeMs);
    total.files += removed.files;
    total.dirs += removed.dirs;
  }
  return total;
}
