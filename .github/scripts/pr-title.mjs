#!/usr/bin/env node
// Checks that a pull request title is a conventional commit. Pull requests are squash-merged with their title as the
// commit on main, and release-please reads those commits for the version bump and the release notes.
//   PR_TITLE="fix(api): bound request bodies" node .github/scripts/pr-title.mjs
// The title comes from the environment (the workflow sets PR_TITLE from the event), never from the shell.

import { pathToFileURL } from "node:url";

/** Types release-please knows, in the order of release-please-config.json; the hidden ones change no version. */
export const TYPES = ["feat", "fix", "security", "perf", "revert", "refactor", "docs", "test", "build", "ci", "chore", "style"];
export const MAX_LENGTH = 100;

const SHAPE = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9._/-]*\\))?(!)?: (\\S.*)$`);

/** { ok: true } for a conventional commit title, else { ok: false, reason } in plain words. */
export function checkTitle(title) {
  if (typeof title !== "string" || title.trim() === "") return { ok: false, reason: "the title is empty" };
  // control characters (a newline included) would end the commit's subject line early
  if (/[\u0000-\u001f\u007f]/.test(title)) return { ok: false, reason: "the title has a control character or a line break" };
  if (title.length > MAX_LENGTH) return { ok: false, reason: `the title is ${title.length} characters; keep it to ${MAX_LENGTH}` };
  const m = SHAPE.exec(title);
  if (!m) {
    return {
      ok: false,
      reason: `start with a type, an optional (scope) and an optional "!", then ": " and a description, e.g. "fix(api): bound request bodies". Types: ${TYPES.join(", ")}`,
    };
  }
  if (/[.]$/.test(m[4])) return { ok: false, reason: "drop the full stop at the end" };
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkTitle(process.env.PR_TITLE);
  if (result.ok) {
    console.log("pr-title: the title is a conventional commit");
  } else {
    console.log(`pr-title: ${result.reason}`);
    process.exitCode = 1;
  }
}
