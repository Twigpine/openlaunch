#!/usr/bin/env bash
# Build only. No RPC, wallet, deployment, key upload or authority mutation.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

build_sbf="${SBF_BUILD_BIN:-.tools/bin/cargo-build-sbf}"
if [[ ! -x "$build_sbf" ]]; then
  printf '%s\n' 'Install locally first: cargo install cargo-build-sbf --version 4.2.0 --locked --root .tools' >&2
  exit 1
fi
tool_version="$($build_sbf --version)"
if [[ "$tool_version" != *'cargo-build-sbf 4.2.0'* ]]; then
  printf '%s\n' 'Expected cargo-build-sbf 4.2.0; review toolchain changes explicitly.' >&2
  exit 1
fi
command -v rg >/dev/null || { printf '%s\n' 'ripgrep is required to reject stack diagnostics.' >&2; exit 1; }
mkdir -p target
"$build_sbf" --tools-version v1.56 --arch v3 --manifest-path programs/launch_pool/Cargo.toml -- --locked 2>&1 | tee target/sbf-build.log
if rg -n -i 'stack offset .*exceed|stack frame size .*exceed|undefined symbol|call depth exceeded' target/sbf-build.log; then
  printf '%s\n' 'SBF diagnostics require review; do not release this binary.' >&2
  exit 1
fi
test -s target/deploy/launch_pool.so
printf '%s\n' 'SBF compilation passed. This is not validator testing, audit approval, or deployment authorization.'
