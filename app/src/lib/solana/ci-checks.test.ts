import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runSolanaChecks, SOLANA_CHECK_TIMEOUT_MS } from "../../../scripts/solana-checks.mjs";

const runner = new URL("../../../scripts/solana-checks.mjs", import.meta.url);
const solanaDir = fileURLToPath(new URL("../../../../solana/", import.meta.url));
const expected = [
  ["rustup", ["toolchain", "install", "1.97.1", "--profile", "minimal", "--component", "rustfmt", "--component", "clippy"]],
  ["cargo", ["+1.97.1", "fmt", "--all", "--check"]],
  ["cargo", ["+1.97.1", "test", "-p", "launch-pool", "--locked"]],
  ["cargo", ["+1.97.1", "install", "cargo-build-sbf", "--version", "4.2.0", "--locked", "--root", ".tools"]],
  ["bash", ["scripts/check-sbf.sh"]],
  ["cargo", ["+1.97.1", "test", "--workspace", "--features", "svm-tests", "--locked"]],
  ["cargo", ["+1.97.1", "clippy", "--workspace", "--all-targets", "--features", "svm-tests", "--locked", "--", "-D", "warnings"]],
];

function harness(overrides: Record<string, unknown> = {}) {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const options = {
    args: [], env: {}, platform: "linux", now: () => 0,
    stat: () => ({ isFile: () => true, size: 1 }),
    log: (line: string) => logs.push(line),
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return { status: 0, signal: null };
    },
    ...overrides,
  };
  return { calls, logs, run: () => runSolanaChecks(options) };
}

test("Solana runner imports without executing tools, including in CI", () => {
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(runner.href)}); console.log('imported');`], {
    env: { ...process.env, CI: "true", GITHUB_ACTIONS: "true", PATH: "" },
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), "imported");
});

test("explicit runtime invocation preserves every pinned check, sequence and working directory", () => {
  const h = harness();
  assert.deepEqual(h.run(), { status: "passed", checks: 7 });
  assert.deepEqual(h.calls.map(({ command, args }) => [command, args]), expected);
  for (const { options } of h.calls) {
    assert.equal(options.cwd, solanaDir);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, "inherit");
    assert.equal(options.timeout, SOLANA_CHECK_TIMEOUT_MS);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal((options.env as Record<string, string>).SBF_BUILD_BIN, join(solanaDir, ".tools", "bin", "cargo-build-sbf"));
  }
});

test("both generic CI and GitHub Actions execute checks, even when the other flag is false", () => {
  for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }, { CI: "false", GITHUB_ACTIONS: "true" }]) {
    assert.equal(harness({ args: ["--ci"], env }).run().status, "passed");
  }
});

test("ordinary local npm test skips explicitly without probing or executing tools", () => {
  const h = harness({ args: ["--ci"], stat: () => { throw new Error("must not probe"); } });
  assert.deepEqual(h.run(), { status: "skipped", checks: 0 });
  assert.equal(h.calls.length, 0);
  assert.match(h.logs.join("\n"), /skipped outside CI.*test:solana-runtime/);
});

test("unknown flags and ambiguous Windows execution fail instead of skipping required checks", () => {
  for (const args of [["--skip"], ["--ci", "--force"]]) assert.throws(() => harness({ args }).run(), /Usage:/);
  assert.throws(() => harness({ platform: "win32" }).run(), /Use WSL.*Windows build/);
  assert.throws(() => harness({ platform: "win32", args: ["--ci"], env: { CI: "true" } }).run(), /Use WSL/);
});

test("a partial checkout fails before running commands", () => {
  const h = harness({ stat: () => { throw new Error("ENOENT"); } });
  assert.throws(h.run, /full repository checkout/);
  assert.equal(h.calls.length, 0);
});

test("every nonzero, missing-tool, signal and null-status failure stops subsequent checks", () => {
  for (let failure = 0; failure < expected.length; failure++) {
    for (const failed of [
      { status: 1, signal: null },
      { status: null, signal: null, error: { code: "ENOENT" } },
      { status: null, signal: "SIGTERM" },
      { status: null, signal: null },
      { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" } },
    ]) {
      let calls = 0;
      const h = harness({ spawn: () => calls++ === failure ? failed : { status: 0, signal: null } });
      assert.throws(h.run, /failed|could not complete/);
      assert.equal(calls, failure + 1);
    }
  }
});

test("runtime tests never run after a missing or empty ELF", () => {
  for (const size of [0, -1]) {
    const h = harness({ stat: (path: string) => ({ isFile: () => true, size: path.endsWith(".so") ? size : 1 }) });
    assert.throws(h.run, /nonempty launch_pool.so/);
    assert.equal(h.calls.length, 5);
  }
  const missing = harness({ stat: (path: string) => {
    if (path.endsWith(".so")) throw new Error("ENOENT");
    return { isFile: () => true, size: 1 };
  } });
  assert.throws(missing.run, /nonempty launch_pool.so/);
  assert.equal(missing.calls.length, 5);
});

test("all commands share the original 35-minute budget", () => {
  let tick = 0;
  const h = harness({ now: () => tick++ * 1_000 });
  h.run();
  assert.equal(h.calls[0].options.timeout, SOLANA_CHECK_TIMEOUT_MS - 1_000);
  assert.ok(Number(h.calls[6].options.timeout) < Number(h.calls[0].options.timeout));
  let calls = 0;
  const expired = harness({ now: () => calls++ === 0 ? 0 : SOLANA_CHECK_TIMEOUT_MS });
  assert.throws(expired.run, /35-minute budget/);
  assert.equal(expired.calls.length, 0);
});

test("existing npm test retains SDK/model and CI runtime coverage with an explicit local entry point", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts.test, /npm run test:solana\s*&&\s*node scripts\/solana-checks\.mjs --ci/);
  assert.equal(manifest.scripts["test:solana-runtime"], "node scripts/solana-checks.mjs");
  assert.match(manifest.scripts["test:solana"], /tsc --noEmit -p packages\/solana-sdk\/tsconfig.json/);
  assert.match(manifest.scripts["test:solana"], /tsx --test .*packages\/solana-sdk\/tests/);
  assert.match(manifest.scripts["test:solana"], /node --experimental-strip-types --test .*packages\/solana-model/);
});
