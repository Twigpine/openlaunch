import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { APP_VERSION, appCommit, cleanCommit, cleanVersion, releaseUrl } from "./version.ts";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("the version is package.json's, and only a plain major.minor.patch is ever shown", () => {
  assert.equal(APP_VERSION, JSON.parse(read("../../package.json")).version);
  assert.match(String(APP_VERSION), /^\d+\.\d+\.\d+$/);
  for (const bad of [undefined, null, 1, "", "v1.0.0", "1.0", "1.0.0-beta", "1.0.0\n", "1.0.0/../x", "<b>1.0.0</b>"]) assert.equal(cleanVersion(bad), null);
});

test("the commit is echoed only when it is a git id", () => {
  assert.equal(cleanCommit("DF3E410"), "df3e410");
  assert.equal(cleanCommit(` ${"a".repeat(40)}\n`), "a".repeat(40));
  for (const bad of [undefined, "", "abc", "g".repeat(7), "a".repeat(41), "df3e410; rm -rf", "<b>df3e410</b>"]) assert.equal(cleanCommit(bad), null);
  assert.equal(appCommit(""), null, "a build without GIT_SHA has no commit");
  assert.equal(appCommit("df3e410"), "df3e410");
});

test("the release link is the tag's page on the project's GitHub", () => {
  assert.equal(releaseUrl("1.2.3"), "https://github.com/Twigpine/openlaunch/releases/tag/v1.2.3");
});

test("the image is told its commit, the footer links the release, and the deploy script checks both", () => {
  const docker = read("../../Dockerfile");
  assert.equal(docker.match(/^ARG GIT_SHA$/gm)?.length, 1, "one build arg, in the runtime stage");
  assert.match(docker, /GIT_SHA=\$GIT_SHA/);
  const footer = read("../components/Footer.tsx");
  assert.match(footer, /APP_VERSION \? <a href=\{releaseUrl\(APP_VERSION\)\} target="_blank" rel="noopener noreferrer"/);
  const deploy = read("../../scripts/deploy.sh");
  assert.match(deploy, /^set -euo pipefail$/m);
  for (const arg of ["FACTORY", "LOCKER", "FACTORY_ROBINHOOD", "LOCKER_ROBINHOOD", "FACTORY_ARC", "LOCKER_ARC", "FACTORY_ELYSIUM", "LOCKER_ELYSIUM"]) assert.ok(deploy.includes(`NEXT_PUBLIC_LAUNCH_${arg}=`), `passes ${arg}`);
  assert.match(deploy, /--build-arg "GIT_SHA=\$SHA"/);
  // the addresses come only from the deployment records whose hashes match contracts/deployed.lock
  assert.equal(deploy.match(/^[A-Z_]+="\$\(addr (base|robinhood|arc|elysium) Launch(Factory|Locker)\)" \|\| exit 1$/gm)?.length, 8);
  // never a $(...) inside the argument array: there its failure would not stop the script and an empty address would ship
  const args = deploy.slice(deploy.indexOf("BUILD_ARGS=("), deploy.indexOf(")", deploy.indexOf("BUILD_ARGS=(")));
  assert.doesNotMatch(args, /\$\(/);
  assert.doesNotMatch(deploy, /0x[0-9a-fA-F]{40}/, "no address typed into the script");
  assert.match(deploy, /\[ "\$got" = "\$want" \] \|\| die/);
  // it deploys only a clean main equal to origin/main, tagged on GitHub; it never pushes, tags or reads a secret
  assert.match(deploy, /git status --porcelain --untracked-files=all/);
  assert.match(deploy, /git ls-remote origin "refs\/tags\/\$TAG\^\{\}"/);
  assert.doesNotMatch(deploy, /^\s*(git (push|tag)|fly secrets)/m);
});

test("release notes start from the last annotated release, never a stray lightweight tag", () => {
  const notes = read("../../scripts/release-notes.mjs");
  assert.match(notes, /git\("describe", "--abbrev=0", "--match", "v\[0-9\]\*", `\$\{to\}\^`\)/);
  assert.doesNotMatch(notes, /"describe"[^)]*"--tags"/);
});
