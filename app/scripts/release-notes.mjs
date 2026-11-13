#!/usr/bin/env node
/**
 * Draft GitHub release notes for the next version from the merged pull requests since the last release. Offline: it reads
 * only this checkout's git history (no network, no token) and prints Markdown to stdout. A maintainer writes the summary
 * above the list and publishes the release on GitHub.
 *
 *   node app/scripts/release-notes.mjs                 # since the newest annotated v* tag before HEAD
 *   node app/scripts/release-notes.mjs --from cf21523  # since a given commit (the first release has no tag to start from)
 */
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
// a ref from the command line goes to git as one argument, and only if it looks like a ref (no options, no spaces)
const ref = (value, what) => {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/^~-]*$/.test(value)) throw new Error(`${what}: not a git ref: ${value}`);
  return value;
};

const to = ref(arg("to"), "--to") ?? "HEAD";
let from = ref(arg("from"), "--from");
if (!from) {
  try {
    // annotated tags only (no --tags): a release is an annotated tag, and a stray lightweight v* tag must never become the
    // starting point, or the notes would silently drop every pull request between the real release and that tag
    from = git("describe", "--abbrev=0", "--match", "v[0-9]*", `${to}^`);
  } catch {
    throw new Error("no earlier annotated v* tag: pass --from <commit> for the first release");
  }
}
const version = JSON.parse(git("show", `${to}:app/package.json`)).version;

// GitHub's merge commits: "Merge pull request #N from owner/branch", then a blank line, then the pull request's title
const log = git("log", "--merges", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", `${from}..${to}`);
const items = [];
for (const entry of log.split("\x1e")) {
  const [, subject = "", body = ""] = entry.trim().split("\x1f");
  const m = /^Merge pull request #(\d+) from ([A-Za-z0-9-]+)\//.exec(subject);
  if (!m) continue;
  const title = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "(no title)";
  // credit outside contributors by their GitHub login; the project's own branches need no mention
  const credit = m[2] === "Twigpine" ? "" : ` by @${m[2]}`;
  items.push(`- ${title} (#${m[1]}${credit})`);
}

const lines = [
  `## openlaunch v${version}`,
  "",
  "<!-- A short summary for users: what changed on the site and in the API. -->",
  "",
  "### Merged pull requests",
  ...(items.length ? items.reverse() : ["- (none)"]),
  "",
  `Full diff: https://github.com/Twigpine/openlaunch/compare/${from}...v${version}`,
];
process.stdout.write(`${lines.join("\n")}\n`);
