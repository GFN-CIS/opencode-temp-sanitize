/**
 * OpenCode 2 plugin entry: gives each project its own temporary directory under
 * OpenCode's shared one. See README.md for behaviour, src/project-tmp.js for the logic.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectSlug, rewriteTmpHint } from "./src/project-tmp.js";

export default {
  id: "temp-sanitize",
  async setup(ctx) {
    // Core creates this directory before plugins load, so realpath must succeed;
    // core advertises the realpath'd form in the prompt.
    const sharedTmp = fs.realpathSync(path.join(os.tmpdir(), "opencode"));
    const projectTmp = path.join(sharedTmp, projectSlug(ctx.location.project, os.homedir()));
    fs.mkdirSync(projectTmp, { recursive: true });

    const warned = new Set();
    await ctx.session.hook("context", (input) => {
      if (rewriteTmpHint(input.system, sharedTmp, projectTmp)) return;
      if (warned.has(input.sessionID)) return;
      warned.add(input.sessionID);
      // The plugin API exposes no server-side logger; console output reaches the
      // OpenCode log. Not fatal on purpose: a missing hint only means models fall
      // back to the shared directory, which must not break the session.
      console.warn(
        `[temp-sanitize] tmp hint not found in system prompt (session ${input.sessionID}); ` +
          "OpenCode wording may have changed, models will use the shared tmp directory",
      );
    });

    await ctx.shell.hook("create.before", (input) => {
      input.env.TMPDIR = projectTmp;
    });
  },
};
