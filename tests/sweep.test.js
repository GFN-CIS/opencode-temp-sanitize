/**
 * Suite: age-based cleanup in src/sweep.js against a real temporary directory tree.
 *
 * Covers which entries are deleted (stale files and symlinks), which survive (fresh
 * files, symlink targets, FIFOs, the sweep root, loose files of the shared directory)
 * and tolerance to entries vanishing mid-scan. Ages are set with utimes relative to a
 * fixed `now`. Not covered: filesystems mounted with noatime (mtime fallback is unit-level).
 * Run: npm test.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProjectDir, MAX_AGE_MS, sweepDir, sweepProjects } from "../src/sweep.js";

const NOW = Date.UTC(2026, 0, 10);
const OLD = new Date(NOW - MAX_AGE_MS - 60_000);
const FRESH = new Date(NOW - 60_000);

let root;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "temp-sanitize-sweep-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function file(rel, time) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x");
  fs.utimesSync(target, time, time);
  return target;
}

describe("sweepDir", () => {
  it("deletes stale files and keeps fresh ones", async () => {
    const stale = file("p/old.log", OLD);
    const fresh = file("p/new.log", FRESH);

    const removed = await sweepDir(path.join(root, "p"), NOW);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(removed).toEqual({ files: 1, dirs: 0 });
  });

  it("keeps a file whose atime is recent even if mtime is old", async () => {
    const target = file("p/read.log", OLD);
    fs.utimesSync(target, FRESH, OLD);

    await sweepDir(path.join(root, "p"), NOW);

    expect(fs.existsSync(target)).toBe(true);
  });

  it("removes a stale symlink without touching its target", async () => {
    // A model may link into the user's tree; following it would delete user data.
    const outside = file("outside/keep.txt", OLD);
    const link = path.join(root, "p", "link");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(path.dirname(outside), link);
    fs.lutimesSync(link, OLD, OLD);

    await sweepDir(path.join(root, "p"), NOW);

    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("prunes emptied subdirectories but keeps the sweep root", async () => {
    file("p/a/b/old.txt", OLD);
    file("p/c/new.txt", FRESH);

    const removed = await sweepDir(path.join(root, "p"), NOW);

    expect(fs.readdirSync(path.join(root, "p"))).toEqual(["c"]);
    expect(removed).toEqual({ files: 1, dirs: 2 });
  });

  it("leaves FIFOs alone", async () => {
    // Sockets and FIFOs may belong to a live process regardless of their timestamps.
    const fifo = path.join(root, "p", "pipe");
    fs.mkdirSync(path.dirname(fifo));
    execFileSync("mkfifo", [fifo]);
    fs.utimesSync(fifo, OLD, OLD);

    await sweepDir(path.join(root, "p"), NOW);

    expect(fs.existsSync(fifo)).toBe(true);
  });

  it("tolerates a missing directory", async () => {
    await expect(sweepDir(path.join(root, "absent"), NOW)).resolves.toEqual({ files: 0, dirs: 0 });
  });

  it("tolerates a file deleted by someone else mid-scan", async () => {
    const target = file("p/racy.txt", OLD);
    const lstat = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation(async (name) => {
      if (name === target) fs.unlinkSync(target);
      return lstat(name);
    });

    await expect(sweepDir(path.join(root, "p"), NOW)).resolves.toEqual({ files: 0, dirs: 0 });
  });
});

describe("sweepProjects", () => {
  it("sweeps project directories only and keeps loose shared entries", async () => {
    // Loose files belong to OpenCode instances without this plugin.
    const projectFile = file("work-app-1a2b3c4d/old.txt", OLD);
    const globalFile = file("global/old.txt", OLD);
    const loose = file("loose.txt", OLD);
    const foreignDir = file("scratch/old.txt", OLD);

    const removed = await sweepProjects(root, NOW);

    expect(fs.existsSync(projectFile)).toBe(false);
    expect(fs.existsSync(globalFile)).toBe(false);
    expect(fs.existsSync(path.join(root, "work-app-1a2b3c4d"))).toBe(true);
    expect(fs.existsSync(loose)).toBe(true);
    expect(fs.existsSync(foreignDir)).toBe(true);
    expect(removed).toEqual({ files: 2, dirs: 0 });
  });
});

describe("isProjectDir", () => {
  it.each([
    ["global", true],
    ["work-app-1a2b3c4d", true],
    [".config-opencode-1ba53005", true],
    ["scratch", false],
    ["app-1A2B3C4D", false],
    ["-1a2b3c4d", false],
  ])("%s -> %s", (name, expected) => {
    expect(isProjectDir(name)).toBe(expected);
  });
});
