// The workflow files and the lock check keep the properties the pull request guard depends on.
//   node --test .github/scripts/workflows.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OWNERS, RULES, activeSvg, lintNpmLock, parseLock } from "./pr-guard.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = `${root}.github/workflows/`;
const workflows = Object.fromEntries(readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).map((name) => [name, readFileSync(dir + name, "utf8")]));
/** Lines that are not comments, with their trailing comments kept (a pinned action names its release there). */
const lines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line));
const guard = workflows["pr-guard.yml"];
/** Every shell command a workflow runs: `run: command`, or the lines of a `run: |` block. */
function commands(text) {
  const out = [];
  const all = lines(text);
  for (let i = 0; i < all.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(all[i]);
    if (!m) continue;
    if (!/^[|>][+-]?$/.test(m[2])) { out.push(m[2]); continue; }
    for (i++; i < all.length && (all[i].trim() === "" || all[i].search(/\S/) > m[1].length); i++) if (all[i].trim()) out.push(all[i].trim());
    i--;
  }
  return out;
}

test("the two workflows exist", () => {
  assert.deepEqual(Object.keys(workflows).sort(), ["ci.yml", "pr-guard.yml"]);
});

test("every action is pinned to a full commit SHA, with its release in a comment", () => {
  let seen = 0;
  for (const [name, text] of Object.entries(workflows)) {
    for (const line of lines(text)) {
      const uses = /^\s*(?:-\s+)?uses:\s*(.+)$/.exec(line)?.[1];
      if (uses === undefined) continue;
      seen++;
      assert.match(uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}: ${uses}`);
    }
  }
  assert.ok(seen >= 6);
});

test("only the guard runs in the base repository's context on outside input", () => {
  for (const [name, text] of Object.entries(workflows)) {
    const privileged = /\b(pull_request_target|workflow_run|issue_comment|pull_request_review(_comment)?|discussion(_comment)?|issues)\s*:/.test(lines(text).join("\n"));
    assert.equal(privileged, name === "pr-guard.yml", name);
  }
});

test("no workflow asks for a write permission, and none reads a secret", () => {
  for (const [name, text] of Object.entries(workflows)) {
    const body = lines(text).join("\n");
    assert.match(body, /^permissions:/m, `${name} sets permissions at the top`);
    assert.doesNotMatch(body, /:\s*write\b|write-all/, name);
    assert.doesNotMatch(body, /\bsecrets\.|\bsecrets\[/, name);
  }
});

test("the guard job is named pr-guard, the name the branch rules require", () => {
  assert.match(guard, /^jobs:\n {2}pr-guard:\n {4}name: pr-guard$/m);
  assert.match(guard, /^permissions: \{\}$/m);
  assert.match(guard, /^ {4}permissions:\n {6}contents: read( #.*)?\n {6}pull-requests: read( #.*)?\n {4}steps:$/m, "the job's whole grant: two reads");
  assert.match(guard, /branches: \[main\]/);
});

test("the guard starts when a pull request is opened, pushed to or reopened, and on nothing else", () => {
  const on = /^on:\n((?: .*\n)+)/m.exec(lines(guard).join("\n"))[1].trimEnd().split("\n").map((line) => line.replace(/\s+#.*$/, ""));
  // a review does not start it: pull_request_review would run the pull request's copy of the workflow, not main's
  assert.deepEqual(on, ["  pull_request_target:", "    branches: [main]", "    types: [opened, synchronize, reopened]"]);
  // the script tells a push, which names its pusher, from the other two by the event's action
  assert.match(guard, /^ {10}EVENT_ACTION: \$\{\{ github\.event\.action \}\}$/m);
  assert.match(guard, /^ {10}EVENT_AFTER: \$\{\{ github\.event\.after \}\}$/m);
  assert.match(guard, /^ {10}EVENT_SENDER: \$\{\{ github\.event\.sender\.login \}\}$/m);
});

test("the guard workflow is, line for line, the one that was reviewed", () => {
  // The tests around this one read the file with patterns, and a pattern can be written around: a command continued on
  // the next line, a quoted key, a step in braces. So the whole file is pinned too, comments and the action's commit
  // aside. Changing the workflow means changing this list in the same pull request.
  const text = lines(guard).map((line) => line.replace(/\s+#.*$/, "").replace(/@[0-9a-f]{40}$/, "@<pinned>")).filter((line) => line.trim() !== "");
  assert.deepEqual(text, [
    "name: pr-guard",
    "on:",
    "  pull_request_target:",
    "    branches: [main]",
    "    types: [opened, synchronize, reopened]",
    "permissions: {}",
    "concurrency:",
    "  group: pr-guard-${{ github.event.pull_request.number }}",
    "  cancel-in-progress: true",
    "jobs:",
    "  pr-guard:",
    "    name: pr-guard",
    "    runs-on: ubuntu-24.04",
    "    timeout-minutes: 10",
    "    permissions:",
    "      contents: read",
    "      pull-requests: read",
    "    steps:",
    "      - name: check out main (trusted)",
    "        uses: actions/checkout@<pinned>",
    "        with:",
    "          fetch-depth: 0",
    "          persist-credentials: false",
    "      - name: fetch the pull request as data",
    "        env:",
    "          PR_NUMBER: ${{ github.event.pull_request.number }}",
    "          HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    "        run: |",
    '          git fetch --quiet --no-tags --no-recurse-submodules origin "+refs/pull/${PR_NUMBER}/head:refs/pr-guard/head"',
    '          git cat-file -e "${HEAD_SHA}^{commit}"',
    "      - name: guard",
    "        env:",
    "          GUARD_BASE: HEAD",
    "          GUARD_HEAD: ${{ github.event.pull_request.head.sha }}",
    "          PR_NUMBER: ${{ github.event.pull_request.number }}",
    "          PR_AUTHOR: ${{ github.event.pull_request.user.login }}",
    "          EVENT_ACTION: ${{ github.event.action }}",
    "          EVENT_AFTER: ${{ github.event.after }}",
    "          EVENT_SENDER: ${{ github.event.sender.login }}",
    "          GITHUB_TOKEN: ${{ github.token }}",
    "        run: node .github/scripts/pr-guard.mjs",
  ]);
});

test("the guard never checks out or runs the pull request", () => {
  const body = lines(guard).join("\n");
  // the one action is the checkout, and it stays on the base commit: no ref, no credentials left behind
  assert.deepEqual(body.match(/^\s*(?:-\s+)?uses:\s*[^@\s]+/gm).map((uses) => uses.trim()), ["uses: actions/checkout"]);
  assert.doesNotMatch(body, /^\s*(ref|repository|submodules|token|ssh-key|shell|container|services):/m);
  assert.match(body, /persist-credentials: false/);
  // nothing is installed or built. These are the complete commands, so nothing can be appended to one of them: the
  // head commit is fetched and looked up, never checked out, and the script that runs is the one from this checkout
  assert.deepEqual(commands(guard), [
    'git fetch --quiet --no-tags --no-recurse-submodules origin "+refs/pull/${PR_NUMBER}/head:refs/pr-guard/head"',
    'git cat-file -e "${HEAD_SHA}^{commit}"',
    "node .github/scripts/pr-guard.mjs",
  ]);
  assert.doesNotMatch(body, /\b(npm|npx|yarn|pnpm|bun|pip|forge|curl|wget|bash|sh -c)\b/);
});

test("the commands of a workflow are read whole, so an appended one is seen", () => {
  const appended = guard.replace('git cat-file -e "${HEAD_SHA}^{commit}"', 'git cat-file -e "${HEAD_SHA}^{commit}"; git checkout refs/pr-guard/head');
  assert.notEqual(appended, guard);
  assert.ok(commands(appended).includes('git cat-file -e "${HEAD_SHA}^{commit}"; git checkout refs/pr-guard/head'));
  assert.deepEqual(commands("steps:\n  - run: one && two\n  - run: >-\n      three\n      four\n  - name: x\n"), ["one && two", "three", "four"]);
});

test("no checkout leaves the job's token behind for the steps that follow", () => {
  let seen = 0;
  for (const [name, text] of Object.entries(workflows)) {
    const all = lines(text);
    all.forEach((line, i) => {
      const at = line.search(/uses: actions\/checkout@/);
      if (at < 0) return;
      seen++;
      // the setting has to sit in this checkout's own `with:` block, not in the next step's
      assert.equal(all[i + 1], `${" ".repeat(at)}with:`, `${name}: the checkout has no settings`);
      const settings = [];
      for (let j = i + 2; j < all.length && all[j].search(/\S/) > at; j++) settings.push(all[j].trim());
      assert.ok(settings.includes("persist-credentials: false"), `${name}: ${line.trim()}`);
    });
  }
  assert.equal(seen, 5, "every checkout in both workflows");
});

test("pull request data reaches the guard's shell only through environment variables", () => {
  for (const line of lines(guard)) {
    if (!line.includes("${{")) continue;
    assert.match(line, /^\s+(group|[A-Z][A-Z0-9_]*): .*\$\{\{ [\w.]+ \}\}$/, line.trim());
  }
  // the head commit is read by its SHA from the event, not by a branch name the author controls
  assert.match(guard, /GUARD_HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.doesNotMatch(guard, /head\.ref|head_ref|head\.label|pull_request\.title|pull_request\.body/);
});

test("ci never uses pull_request_target and runs the lock check and the guard's tests", () => {
  const ci = workflows["ci.yml"];
  assert.match(ci, /^ {2}pull_request:$/m);
  assert.match(ci, /run: script\/check-deployed-sources\.sh/);
  assert.match(ci, /run: script\/check-arc-factory\.sh/);
  assert.match(ci, /run: node --test \.github\/scripts\/pr-guard\.test\.mjs \.github\/scripts\/workflows\.test\.mjs/);
  assert.match(ci, /foundry-toolchain@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+version: v\d+\.\d+\.\d+/, "the Foundry version is pinned");
});

test("code owners and the guard name the same people, and cover the guarded paths", () => {
  const owners = readFileSync(`${root}.github/CODEOWNERS`, "utf8");
  const rules = owners.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(/\s+/));
  for (const [path, ...names] of rules) assert.deepEqual(names, OWNERS.map((login) => `@${login}`), path);
  for (const path of ["/contracts/", "/.github/", "/app/package.json", "/app/package-lock.json"]) assert.ok(rules.some(([p]) => p === path), path);
});

test("the lock names files that exist, and every deployed source is in it", () => {
  const lock = readFileSync(`${root}contracts/deployed.lock`, "utf8");
  // every line is a comment or an entry in the one shape the script writes, the script checks and the guard reads
  for (const line of lock.split("\n")) assert.match(line, /^(#.*|)$|^(sha256 [0-9a-f]{64}|gitlink [0-9a-f]{40}) {2}\S+$/, line);
  const entries = lock.split("\n").filter((line) => /^(sha256|gitlink) /.test(line)).map((line) => line.split(/\s+/));
  assert.ok(entries.length >= 13);
  for (const [, , path] of entries) assert.ok(parseLock(lock).has(path), `the guard reads ${path}`);
  for (const [kind, value, path] of entries) {
    // the guard compares these with a pull request's paths letter for letter: from the root, with no "./" or ".."
    assert.doesNotMatch(path, /^\/|(^|\/)\.\.?(\/|$)/, path);
    assert.match(value, kind === "sha256" ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/, path);
    if (kind === "sha256") assert.doesNotThrow(() => readFileSync(root + path), path);
  }
  const locked = new Set(entries.map(([, , path]) => path));
  for (const path of ["contracts/src/LaunchFactory.sol", "contracts/src/LaunchFactoryArc.sol", "contracts/src/LaunchLocker.sol", "contracts/src/LaunchToken.sol", "contracts/foundry.toml", "contracts/remappings.txt", ".gitmodules", "contracts/lib/forge-std", "contracts/lib/v4-periphery"]) {
    assert.ok(locked.has(path), path);
  }
});

test("the lock check fails when a deployed file, a library pin or a file inside a library has changed", () => {
  const repo = mkdtempSync(join(tmpdir(), "deployed-lock-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  const script = join(repo, "contracts/script/check-deployed-sources.sh");
  const run = (...args) => spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
  try {
    // a repository shaped like this one: a deployed source, and a library checked out as a repository of its own
    const kit = join(repo, "contracts/lib/kit");
    mkdirSync(join(repo, "contracts/script"), { recursive: true });
    mkdirSync(join(repo, "contracts/src"), { recursive: true });
    mkdirSync(kit, { recursive: true });
    copyFileSync(`${root}contracts/script/check-deployed-sources.sh`, script);
    writeFileSync(join(repo, "contracts/src/Token.sol"), "contract Token {}\n");
    writeFileSync(join(repo, "contracts/deployed.lock"), "# deployed sources\n");
    writeFileSync(join(kit, "Kit.sol"), "library Kit {}\n");
    git(kit, "init", "-q", "-b", "main");
    git(kit, "add", "-A");
    git(kit, "commit", "-q", "-m", "kit");
    const pin = git(kit, "rev-parse", "HEAD");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");

    assert.equal(run().status, 1, "an empty lock checks nothing, so it fails");
    // a file git does not track cannot be locked: a fresh checkout would not have it
    writeFileSync(join(repo, "contracts/src/Draft.sol"), "contract Draft {}\n");
    const untracked = run("--update", "contracts/src/Draft.sol");
    assert.equal(untracked.status, 1);
    assert.match(untracked.stderr, /^cannot lock contracts\/src\/Draft\.sol: not one file or submodule that git tracks in this repository/m);
    assert.equal(readFileSync(join(repo, "contracts/deployed.lock"), "utf8"), "# deployed sources\n", "the lock is left as it was");
    rmSync(join(repo, "contracts/src/Draft.sol"));
    assert.equal(run("--update", "contracts").status, 1, "a folder is not one file");
    // a path with a space cannot be written as an entry that the check and the guard would read back
    writeFileSync(join(repo, "contracts/src/My Token.sol"), "contract MyToken {}\n");
    git(repo, "add", "contracts/src/My Token.sol");
    const spaced = run("--update", "contracts/src/My Token.sol");
    assert.equal(spaced.status, 1);
    assert.match(spaced.stderr, /^cannot lock contracts\/src\/My Token\.sol: a path with a space in it cannot be an entry of the lock/m);
    assert.equal(readFileSync(join(repo, "contracts/deployed.lock"), "utf8"), "# deployed sources\n", "the lock is left as it was");
    git(repo, "rm", "-q", "-f", "contracts/src/My Token.sol");
    // however the path is typed, the lock holds it as git spells it from the root
    assert.equal(run("--update", "./contracts/src/../src/Token.sol", "contracts/lib/kit").status, 0);
    assert.match(readFileSync(join(repo, "contracts/deployed.lock"), "utf8"), new RegExp(`^sha256 [0-9a-f]{64}  contracts/src/Token\\.sol\\ngitlink ${pin}  contracts/lib/kit$`, "m"));
    const clean = run();
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /^ok: 2 deployed contract files and library pins match/);

    // a locked file that is here but that git no longer tracks would be missing from a fresh checkout
    git(repo, "rm", "-q", "--cached", "contracts/src/Token.sol");
    const dropped = run();
    assert.equal(dropped.status, 1);
    assert.match(dropped.stdout, /^DRIFT {2}contracts\/src\/Token\.sol: the file is here, but git does not track it$/m);
    git(repo, "add", "contracts/src/Token.sol");
    assert.equal(run().status, 0);

    // a library file edited in place: the pin and the checked-out commit still match, the bytes that compile do not
    appendFileSync(join(kit, "Kit.sol"), "// edited\n");
    const edited = run();
    assert.equal(edited.status, 1);
    assert.match(edited.stdout, /^DRIFT {2}contracts\/lib\/kit: files differ from the pinned commit/m);
    git(kit, "checkout", "-q", "--", ".");
    assert.equal(run().status, 0);

    // a file added beside the library's own, also when the reader's git is set not to mention such files
    git(kit, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(kit, "remappings.txt"), "kit/=elsewhere/\n");
    assert.match(run().stdout, /^DRIFT {2}contracts\/lib\/kit: files differ from the pinned commit/m);
    rmSync(join(kit, "remappings.txt"));

    // the library moved to another commit
    git(kit, "commit", "-q", "--allow-empty", "-m", "later");
    assert.match(run().stdout, /^DRIFT {2}contracts\/lib\/kit: checked out at [0-9a-f]{12}…, pinned at [0-9a-f]{12}…/m);
    git(kit, "reset", "-q", "--hard", pin);
    assert.equal(run().status, 0);

    // a library whose state cannot be read is not a clean one
    appendFileSync(join(kit, "Kit.sol"), "// edited\n");
    writeFileSync(join(kit, ".git/index"), "not an index");
    const unreadable = run();
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stdout, /^DRIFT {2}contracts\/lib\/kit: files differ from the pinned commit, or could not be compared with it/m);
    rmSync(join(kit, ".git/index"));
    git(kit, "reset", "-q", "--hard", pin);
    assert.equal(run().status, 0);

    // the lock's last line counts with or without its newline
    const lock = join(repo, "contracts/deployed.lock");
    const entries = readFileSync(lock, "utf8");
    writeFileSync(lock, entries.trimEnd());
    assert.match(run().stdout, /^ok: 2 deployed contract files and library pins match/);
    // a line the guard would not read as an entry is not quietly checked here either
    for (const odd of [entries.replace("sha256 ", "  sha256 "), entries.replace(/ {2}contracts\/src/, "\tcontracts/src"), `${entries}sha256 ${"0".repeat(64)}  contracts/src/My Token.sol\n`]) {
      writeFileSync(lock, odd);
      const refused = run();
      assert.equal(refused.status, 1);
      assert.match(refused.stdout, /^DRIFT {2}contracts\/deployed\.lock has a line that is not an entry: /m);
    }
    writeFileSync(lock, entries);
    assert.equal(run().status, 0);

    // a deployed source edited
    const token = join(repo, "contracts/src/Token.sol");
    appendFileSync(token, "// edited\n");
    const drift = run();
    assert.equal(drift.status, 1);
    assert.match(drift.stdout, /^DRIFT {2}contracts\/src\/Token\.sol: locked sha256 /m);
    writeFileSync(token, "contract Token {}\n");
    assert.equal(run().status, 0);

    // library files with the repository taken away from under them
    rmSync(join(kit, ".git"), { recursive: true });
    assert.match(run().stdout, /^DRIFT {2}contracts\/lib\/kit: holds files, but is not a checkout of the pinned commit/m);
    // a library that is not checked out at all has nothing to compile, so there is nothing to compare
    rmSync(join(kit, "Kit.sol"));
    assert.equal(run().status, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the SVGs this repository serves pass the check the guard applies to new ones", () => {
  const found = ["app/public", "app/src/app", "brand"].flatMap((folder) => readdirSync(root + folder, { recursive: true }).filter((name) => /\.svg$/i.test(name)).map((name) => `${folder}/${name}`));
  assert.ok(found.length >= 5, "the brand and icon files");
  for (const path of found) assert.equal(activeSvg(readFileSync(root + path, "utf8")), null, path);
});

test("CONTRIBUTING names every rule of the guard, under the outcome the guard gives it", () => {
  const guide = readFileSync(`${root}CONTRIBUTING.md`, "utf8");
  const lists = {
    block: /^- \*\*Blocked\.\*\*([\s\S]*?)^- \*\*Needs a maintainer's approval\.\*\*/m.exec(guide)[1],
    review: /^- \*\*Needs a maintainer's approval\.\*\*([\s\S]*?)\n\n(?=\S)/m.exec(guide)[1],
  };
  for (const [tier, text] of Object.entries(lists)) {
    // each point opens with the names of the rules it describes: "  - `rule`, `other-rule`: what it is"
    const named = [...text.matchAll(/^ {2}- ((?:`[a-z-]+`(?:, )?)+):/gm)].flatMap((point) => point[1].match(/[a-z-]+/g));
    const rules = Object.keys(RULES).filter((rule) => RULES[rule].tier === tier);
    assert.deepEqual([...named].sort(), rules.sort(), `the ${tier} list`);
  }
  // what the guard locks beyond the paths the lock file lists is spelled out
  for (const path of ["contracts/script/check-deployed-sources.sh", "contracts/script/check-arc-factory.sh", ".gitmodules", "contracts/lib/", ".gitattributes"]) assert.ok(guide.includes(`\`${path}\``), path);
});

test("the repository's own lockfile passes the guard's check of every entry", () => {
  const lock = readFileSync(`${root}app/package-lock.json`, "utf8");
  assert.ok(Object.keys(JSON.parse(lock).packages).length > 300);
  // compared with itself nothing is added or changed, so anything but this one line is an entry the guard refuses
  assert.deepEqual(lintNpmLock("app/package-lock.json", lock, lock), [{ rule: "dependencies", path: "app/package-lock.json", detail: "lockfile metadata changed", line: null }]);
});
