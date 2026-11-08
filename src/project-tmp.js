/**
 * Pure logic for per-project temporary directories.
 *
 * OpenCode core (packages/core/src/instructions/builtins.ts, verified at v2.2.6) tells
 * every model, in the "core/environment" system instruction:
 *
 *   Prefer <tmp> over generic system temporary directories such as /tmp; it is
 *   pre-created and approved for external access.
 *
 * where <tmp> is `path.join(os.tmpdir(), "opencode")`, realpath'd by core
 * (packages/util/src/global-roots.ts). All projects therefore share one directory.
 * This module derives a per-project subdirectory and rewrites that sentence.
 * The plugin wiring lives in ../index.js.
 */
import path from "node:path";
import { crc32 } from "node:zlib";

/** Project id OpenCode assigns to sessions started outside any project. */
const GLOBAL_PROJECT_ID = "global";

/**
 * Directory name for a project: its path relative to `home` with separators replaced
 * by "-", suffixed with the CRC32 of the project id.
 *
 * The path part keeps the name readable; the id hash keeps two projects apart when
 * their path parts collide (e.g. "a-b/c" vs "a/b-c"). Characters outside
 * [A-Za-z0-9._-] become "_". Sessions outside a project share "global".
 *
 * @param {{ id: string, directory: string }} project `Location.Info.project`
 * @param {string} home absolute home directory
 * @returns {string} a single path segment
 */
export function projectSlug(project, home) {
  if (project.id === GLOBAL_PROJECT_ID) return GLOBAL_PROJECT_ID;
  const directory = path.resolve(project.directory);
  const relative = path.relative(home, directory);
  const insideHome = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  let readable;
  if (relative === "") readable = "home";
  else readable = insideHome ? relative : directory;
  const segments = readable.split(path.sep).filter(Boolean);
  const name = segments.join("-").replace(/[^A-Za-z0-9._-]/g, "_") || "root";
  const hash = crc32(project.id).toString(16).padStart(8, "0");
  return `${name}-${hash}`;
}

/** Appended to the rewritten hint line; nothing else ever removes these files. */
export const CLEANUP_HINT =
  "Don't forget to delete temporary files there that you or your subagents created once you are ABSOLUTELY SURE they will not be needed anymore.";

/**
 * Replaces OpenCode's shared temporary directory with `projectTmp` in the core tmp hint
 * and appends {@link CLEANUP_HINT} to that line, mutating `system` in place.
 *
 * Only the exact upstream wording ("Prefer <sharedTmp> over") is matched, so a rewritten
 * line never matches again and repeated calls are no-ops.
 *
 * @param {Array<{ type: string, text: string }>} system `SessionContext.system` parts
 * @param {string} sharedTmp OpenCode's tmp directory, as core renders it
 * @param {string} projectTmp the per-project directory to advertise instead
 * @returns {boolean} whether the hint was found (false also after a previous rewrite)
 */
export function rewriteTmpHint(system, sharedTmp, projectTmp) {
  const needle = `Prefer ${sharedTmp} over`;
  const replacement = `Prefer ${projectTmp} over`;
  let found = false;
  for (const part of system) {
    if (part.type !== "text" || !part.text.includes(needle)) continue;
    part.text = part.text
      .split("\n")
      .map((line) =>
        line.includes(needle) ? `${line.replaceAll(needle, replacement)} ${CLEANUP_HINT}` : line,
      )
      .join("\n");
    found = true;
  }
  return found;
}
