// node --test .github/scripts/pr-title.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_LENGTH, TYPES, checkTitle } from "./pr-title.mjs";

const script = fileURLToPath(new URL("./pr-title.mjs", import.meta.url));

test("conventional commit titles pass", () => {
  for (const title of [
    "fix(api): bound request bodies",
    "feat: versioned releases and the version in the footer",
    "security(guard): block changes to the release and deploy tooling",
    "feat!: drop the v1 list endpoint",
    "fix(launch/form): retry the receipt",
    "chore: release 1.1.0", // release-please's own pull request title
    "docs(app.readme): releasing",
  ]) assert.deepEqual(checkTitle(title), { ok: true }, title);
});

test("anything else fails, with a reason", () => {
  for (const title of [
    undefined, "", "   ",
    "Filter unsupported extreme starting valuations", // no type
    "Fix(api): capitalised type",
    "fix (api): space before the scope",
    "fix(API): upper-case scope",
    "fix:no space",
    "fix: ",
    "fixes: unknown type",
    "fix: ends with a full stop.",
    "fix: one line\nsecond line",
    "fix: tab\tinside",
    `fix: ${"x".repeat(MAX_LENGTH)}`,
  ]) {
    const result = checkTitle(title);
    assert.equal(result.ok, false, JSON.stringify(title));
    assert.ok(result.reason.length > 0);
  }
});

test("the types are exactly the sections release-please is configured with", () => {
  const config = JSON.parse(readFileSync(new URL("../../release-please-config.json", import.meta.url), "utf8"));
  assert.deepEqual(config["changelog-sections"].map((s) => s.type), TYPES);
});

test("the script reads the title from the environment only, and its exit code says the result", () => {
  const run = (title) => spawnSync(process.execPath, [script, "--", "fix: from argv is ignored"], { env: { PATH: process.env.PATH, ...(title === undefined ? {} : { PR_TITLE: title }) }, encoding: "utf8" });
  assert.equal(run("fix(api): bound request bodies").status, 0);
  assert.equal(run("not a conventional title").status, 1);
  assert.equal(run(undefined).status, 1, "no title in the environment fails, whatever argv says");
  // a title made to look like shell is only ever text here
  const tricky = run("fix: $(touch /tmp/pwned) `id` ; rm -rf /");
  assert.equal(tricky.status, 0);
  assert.match(tricky.stdout, /conventional commit/);
});
