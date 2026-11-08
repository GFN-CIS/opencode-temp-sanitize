/**
 * Suite: plugin entry wiring against a fake OpenCode plugin context.
 *
 * Covers index.js: directory creation, the session "context" hook, the shell
 * "create.before" hook and the cleanup started by setup. The fake records hook callbacks and invokes them the way
 * OpenCode does (mutable input object). Not covered: OpenCode's own hook dispatch.
 * Run: npm test. TMPDIR and HOME point at a fresh temporary directory per test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { CLEANUP_HINT } from "../src/project-tmp.js";

let root;
let env;
const cleanups = [];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "temp-sanitize-test-")));
  env = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };
  fs.mkdirSync(path.join(root, "tmp", "opencode"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"));
  process.env.TMPDIR = path.join(root, "tmp");
  process.env.HOME = path.join(root, "home");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function load(project) {
  const hooks = {};
  const register = (domain) => async (name, callback) => {
    hooks[`${domain}.${name}`] = callback;
    return { dispose: async () => undefined };
  };
  const cleanup = await plugin.setup({
    location: { directory: project.directory, project },
    session: { hook: register("session") },
    shell: { hook: register("shell") },
  });
  cleanups.push(cleanup);
  return hooks;
}

const hint = (tmp) =>
  `  Prefer ${tmp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`;

describe("plugin", () => {
  const project = () => ({ id: "abc123", directory: path.join(root, "home", "projects", "app") });

  it("creates the project directory and advertises it to the model", async () => {
    const hooks = await load(project());
    const shared = path.join(root, "tmp", "opencode");
    const [dir] = fs.readdirSync(shared);
    const own = path.join(shared, dir);
    const input = { sessionID: "ses_1", system: [{ type: "text", text: hint(shared) }] };

    hooks["session.context"](input);

    expect(dir).toMatch(/^projects-app-[0-9a-f]{8}$/);
    expect(fs.statSync(own).isDirectory()).toBe(true);
    expect(input.system[0].text).toBe(`${hint(own)} ${CLEANUP_HINT}`);
  });

  it("points TMPDIR of spawned shells at the project directory", async () => {
    const hooks = await load(project());
    const shared = path.join(root, "tmp", "opencode");
    const input = {
      command: "mktemp",
      cwd: "/",
      timeout: 1000,
      shell: "bash",
      env: { PATH: "/bin" },
    };

    hooks["shell.create.before"](input);

    expect(input.env.TMPDIR).toBe(path.join(shared, fs.readdirSync(shared)[0]));
    expect(input.env.PATH).toBe("/bin");
  });

  it("warns once per session when the hint is missing", async () => {
    // Upstream rewording must be visible in logs, but not flood them on every request.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hooks = await load(project());
    const request = (sessionID) => ({ sessionID, system: [{ type: "text", text: "no hint" }] });

    hooks["session.context"](request("ses_1"));
    hooks["session.context"](request("ses_1"));
    hooks["session.context"](request("ses_2"));

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("deletes stale files of the project on setup", async () => {
    const shared = path.join(root, "tmp", "opencode");
    await load(project());
    const own = path.join(shared, fs.readdirSync(shared)[0]);
    const stale = path.join(own, "old.log");
    const fresh = path.join(own, "new.log");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(fresh, "x");
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    await load(project());

    await vi.waitFor(() => expect(fs.existsSync(stale)).toBe(false));
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("logs instead of throwing when cleanup fails", async () => {
    // Cleanup runs from a timer inside the shared OpenCode service; it must not crash it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(fs.promises, "readdir").mockRejectedValue(
      Object.assign(new Error("boom"), { code: "EIO" }),
    );

    await load(project());

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup")));
  });

  it("fails setup when OpenCode's tmp directory does not exist", async () => {
    // Core creates it before plugins load; its absence means a different layout, not a state to paper over.
    fs.rmSync(path.join(root, "tmp", "opencode"), { recursive: true });
    await expect(load(project())).rejects.toThrow();
  });
});
