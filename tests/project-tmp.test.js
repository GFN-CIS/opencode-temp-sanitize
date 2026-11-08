/**
 * Suite: per-project directory naming and the core tmp hint rewrite.
 *
 * Covers src/project-tmp.js::projectSlug and ::rewriteTmpHint as pure functions.
 * Not covered: hook wiring and filesystem effects (tests/plugin.test.js).
 * Run: npm test
 */
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CLEANUP_HINT, projectSlug, rewriteTmpHint } from "../src/project-tmp.js";

const HOME = "/home/user";
const hash = (id) => crc32(id).toString(16).padStart(8, "0");

// Verbatim from OpenCode v2.2.6 packages/core/src/instructions/builtins.ts ("core/environment").
const upstreamHint = (tmp) =>
  `  Prefer ${tmp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`;

const environmentPart = (tmp) => ({
  type: "text",
  text: [
    "<env>",
    "  Working directory: /home/user/projects/example-app",
    upstreamHint(tmp),
    "</env>",
  ].join("\n"),
});

describe("projectSlug", () => {
  it("joins the home-relative path with dashes and appends the id hash", () => {
    // Readable name is the point of the plugin: a user must recognise the project on disk.
    const slug = projectSlug({ id: "abc123", directory: "/home/user/projects/example-app" }, HOME);
    expect(slug).toBe(`projects-example-app-${hash("abc123")}`);
  });

  it("uses the absolute path for projects outside home", () => {
    const slug = projectSlug({ id: "abc123", directory: "/srv/example-app" }, HOME);
    expect(slug).toBe(`srv-example-app-${hash("abc123")}`);
  });

  it("does not treat a sibling directory sharing the home prefix as inside home", () => {
    // "/home/user2" starts with "/home/user" as a string but is not under it.
    const slug = projectSlug({ id: "abc123", directory: "/home/user2/app" }, HOME);
    expect(slug).toBe(`home-user2-app-${hash("abc123")}`);
  });

  it("names a project rooted at home 'home'", () => {
    expect(projectSlug({ id: "abc123", directory: HOME }, HOME)).toBe(`home-${hash("abc123")}`);
  });

  it("puts sessions outside any project into 'global'", () => {
    expect(projectSlug({ id: "global", directory: "/" }, HOME)).toBe("global");
  });

  it("replaces characters unsafe in a path segment", () => {
    const slug = projectSlug({ id: "abc123", directory: "/home/user/проект x" }, HOME);
    expect(slug).toBe(`_______x-${hash("abc123")}`);
  });

  it("separates projects whose readable names collide", () => {
    // "a-b/c" and "a/b-c" flatten to the same name; the id hash must keep them apart.
    const first = projectSlug({ id: "id-one", directory: "/home/user/a-b/c" }, HOME);
    const second = projectSlug({ id: "id-two", directory: "/home/user/a/b-c" }, HOME);
    expect(first).not.toBe(second);
  });

  it("is stable for the same project", () => {
    // Directory must survive restarts, otherwise files are lost between sessions.
    const project = { id: "abc123", directory: "/home/user/projects/example-app" };
    expect(projectSlug(project, HOME)).toBe(projectSlug({ ...project }, HOME));
  });
});

describe("rewriteTmpHint", () => {
  const shared = "/tmp/opencode";
  const own = "/tmp/opencode/projects-example-app-0000beef";

  it("points the upstream hint at the project directory and asks for cleanup", () => {
    const system = [{ type: "text", text: "You are an agent." }, environmentPart(shared)];

    expect(rewriteTmpHint(system, shared, own)).toBe(true);
    const lines = system[1].text.split("\n");
    // Cleanup request sits on the hint line itself so it reads as part of the same rule.
    expect(lines[2]).toBe(`${upstreamHint(own)} ${CLEANUP_HINT}`);
    expect(lines.slice(0, 2)).toEqual(environmentPart(shared).text.split("\n").slice(0, 2));
    expect(lines[3]).toBe("</env>");
    expect(system[0].text).toBe("You are an agent.");
  });

  it("reports a miss and changes nothing when the wording differs", () => {
    // A silent miss would leave models on the shared directory with no signal.
    const text = `Use ${shared} for scratch files.`;
    const system = [{ type: "text", text }];

    expect(rewriteTmpHint(system, shared, own)).toBe(false);
    expect(system[0].text).toBe(text);
  });

  it("does not nest the path or repeat the cleanup request when applied twice", () => {
    const system = [environmentPart(shared)];
    rewriteTmpHint(system, shared, own);
    const once = system[0].text;

    expect(rewriteTmpHint(system, shared, own)).toBe(false);
    expect(system[0].text).toBe(once);
    expect(once.split(CLEANUP_HINT)).toHaveLength(2);
  });

  it("ignores non-text parts", () => {
    const part = { type: "image", text: upstreamHint(shared) };
    expect(rewriteTmpHint([part], shared, own)).toBe(false);
    expect(part.text).toBe(upstreamHint(shared));
  });
});
