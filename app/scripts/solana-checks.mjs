// Build/test only. No RPC, wallet input, deployment, signing or authority operations.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOLANA_DIR = fileURLToPath(new URL("../../solana/", import.meta.url));
export const SOLANA_CHECK_TIMEOUT_MS = 35 * 60 * 1000;

const CHECKS = [
  ["Rust toolchain", "rustup", ["toolchain", "install", "1.97.1", "--profile", "minimal", "--component", "rustfmt", "--component", "clippy"]],
  ["Rust formatting", "cargo", ["+1.97.1", "fmt", "--all", "--check"]],
  ["Rust host tests", "cargo", ["+1.97.1", "test", "-p", "launch-pool", "--locked"]],
  ["Pinned SBF build tool", "cargo", ["+1.97.1", "install", "cargo-build-sbf", "--version", "4.2.0", "--locked", "--root", ".tools"]],
  ["SBFv3 build and diagnostics", "bash", ["scripts/check-sbf.sh"]],
  ["Compiled-program runtime tests", "cargo", ["+1.97.1", "test", "--workspace", "--features", "svm-tests", "--locked"]],
  ["Rust Clippy", "cargo", ["+1.97.1", "clippy", "--workspace", "--all-targets", "--features", "svm-tests", "--locked", "--", "-D", "warnings"]],
];

/** Execute the same required checks locally and from the existing app CI job.
 * Dependencies are injectable for regression tests; the CLI always uses real tools.
 */
export function runSolanaChecks({
  args = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  stat = statSync,
  now = Date.now,
  log = console.log,
} = {}) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--ci")) {
    throw new Error("Usage: node scripts/solana-checks.mjs [--ci]");
  }
  if (args[0] === "--ci" && env.CI !== "true" && env.GITHUB_ACTIONS !== "true") {
    log("Solana Rust/SBF checks skipped outside CI. Run npm run test:solana-runtime explicitly; see solana/BUILD.md for prerequisites.");
    return { status: "skipped", checks: 0 };
  }
  if (platform === "win32") {
    throw new Error("The combined Solana runner requires Linux or macOS with rustup, cargo and Bash on PATH. Use WSL, or the explicit Windows build/runtime commands in solana/BUILD.md; no Git Bash path is guessed.");
  }
  for (const source of ["Cargo.toml", "Cargo.lock", "programs/launch_pool/Cargo.toml", "scripts/check-sbf.sh"]) {
    let present = false;
    try { present = stat(join(SOLANA_DIR, source)).isFile(); } catch { /* Fail closed below. */ }
    if (!present) throw new Error(`Solana checks require the full repository checkout: missing ${source}.`);
  }

  const deadline = now() + SOLANA_CHECK_TIMEOUT_MS;
  const childEnv = { ...env, SBF_BUILD_BIN: join(SOLANA_DIR, ".tools", "bin", "cargo-build-sbf") };
  for (const [label, command, commandArgs] of CHECKS) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Solana checks exceeded the 35-minute budget.");
    log(`Solana checks: ${label}`);
    const result = spawn(command, commandArgs, {
      cwd: SOLANA_DIR,
      env: childEnv,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
      timeout: remaining,
      killSignal: "SIGKILL",
    });
    if (result.error) throw new Error(`${label} could not complete (${result.error.code ?? "spawn error"}). Required tools/checks are never skipped.`);
    if (result.signal || result.status !== 0) {
      throw new Error(`${label} failed (${result.signal ?? `exit ${result.status ?? "unknown"}`}).`);
    }
    if (now() >= deadline) throw new Error("Solana checks exceeded the 35-minute budget.");
    if (command === "bash") {
      let built = false;
      try {
        const elf = stat(join(SOLANA_DIR, "target", "deploy", "launch_pool.so"));
        built = elf.isFile() && elf.size > 0;
      } catch { /* Fail closed below. */ }
      if (!built) throw new Error("SBF build did not produce a nonempty launch_pool.so; runtime tests cannot use missing bytecode.");
    }
  }
  log("Solana host, SBFv3 and offline runtime checks passed. This is not deployment or release approval.");
  return { status: "passed", checks: CHECKS.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runSolanaChecks(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Solana checks failed.");
    process.exitCode = 1;
  }
}
