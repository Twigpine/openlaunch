# Reproducible build and test handoff

No deployment is performed by these commands. The source contains an undeployed compilation fixture ID. Never expose this fixture as a real Solana launch option. Kevin must bind the reviewed real program ID into source, app configuration and the release manifest before the final build and audit comparison.

## Host checks

From `solana/`:

```sh
cargo fmt --all --check
cargo test -p launch-pool --locked
```

Commit `Cargo.lock`. Host tests exercise curve boundaries, 108,000 sampled transitions, an independently implemented model's vectors, SDK/Rust byte compatibility, generated Anchor dispatch/account constraints, cancellations, fee claims, and buys/sells using the real legacy SPL TransferChecked processor through a limited syscall harness. The harness is explicitly not a validator: it cannot establish SBF stack/compute limits, account-creation prefunding semantics, runtime rent rules, or transaction rollback.

## SBF build, no cluster access

The pinned Anchor crates are `0.31.1`. Their historical Agave `2.1` recommendation is not a production-toolchain recommendation in October 2026. Current Anza documentation says deployment of older SBPF formats will be blocked by SIMD-500 activation. Build explicitly for SBPFv3, not the compiler's v0 default. This program's Solana SDK resolves to 2.3 through the lockfile. Verify all toolchain and cluster-feature compatibility before release. [Anza compiler documentation](https://github.com/anza-xyz/cargo-build-sbf), [4.2.0 release](https://github.com/anza-xyz/cargo-build-sbf/releases/tag/cargo-build-sbf%40v4.2.0)

Install the official build-only command in a repository-local ignored directory:

```sh
cargo install cargo-build-sbf --version 4.2.0 --locked --root .tools
bash scripts/check-sbf.sh
```

Windows PowerShell equivalent:

```powershell
cargo install cargo-build-sbf --version 4.2.0 --locked --root .tools
.tools/bin/cargo-build-sbf.exe --tools-version v1.56 --arch v3 --manifest-path programs/launch_pool/Cargo.toml -- --locked
```

The compiler downloads platform-tools `v1.56` (Rust 1.89) from Anza's releases. Record artifact digests in the final build manifest and independently check the downloaded toolchain provenance. It may generate an ignored local program-keypair file as a build artifact. Do not use that generated fixture for deployment and do not commit keypairs. No script reads wallet configuration, signs transactions, chooses an RPC, or runs `deploy`/`set-upgrade-authority`.

Expected binary: `solana/target/deploy/launch_pool.so`. Collect its SHA-256 and complete compiler log, reject stack-frame/undefined-symbol diagnostics, then reproduce the build on a separate clean machine/container. Source changes, including changing the program ID, invalidate earlier bytecode evidence. Host tests passing is not evidence that this SBF build passes.

Local verification on 10 October 2026: the pinned Windows build completed for `--arch v3`, producing a 373,464-byte fixture binary with SHA-256 `a6159ed6a87ee96257436363b1391de18e88fb8e83195306b8182fe1339fd832`. No stack-frame or undefined-symbol diagnostic was emitted. This is one local build, not independently reproduced production bytecode and not a deployment. The compiler notes that keeping both `cdylib` and `lib` crate outputs prevents its LTO optimization; both are retained so host/library tests use the same crate. Reassess size/compute using the validator tests, not assumed LTO benefits.

## Offline SBF runtime evidence

After building the ELF, run:

```sh
cargo test --workspace --features svm-tests --locked
cargo clippy --workspace --all-targets --features svm-tests --locked -- -D warnings
```

The separate `runtime-tests` crate pins LiteSVM `0.13.1`, with Agave 4.0 dependencies committed in the lockfile. It loads the actual SBPFv3 ELF with the upgradeable loader and linked immutable ProgramData, then runs real System and legacy SPL Token instructions. Ephemeral fixture identities exist only in test memory; there is no RPC, real wallet, persisted signer or deployment.

On 10 October 2026, all 21 host tests and all 9 actual-SBF runtime tests passed on Windows. Runtime coverage includes:

- Complete prepare/activate/buy/sell/claim lifecycle, full supply in custody, mint/freeze authority absence and failed extra mint/freeze attempts.
- Prefunding each of pool, mint, token vault, reserve and fee PDA before account creation.
- Rejected cancellation/activation/initialization replay, retained upgrade authority and unrelated ProgramData.
- Actual transaction rollback after successful activation CPIs or a buy when a subsequent instruction fails.
- Maximum metadata and seven recipients. The maximum preparation packet measured 792 bytes against the 1,232-byte limit; every submitted test transaction checks that limit and runs under runtime compute metering.
- Wrong custody/program/mint accounts, expired execution, donations, holder burns and recipient rent failure isolation.

Observed compute varies with randomly generated PDA bumps: sampled preparation 23k–48k, activation 44k–61k, buy 25k–33k, sell 21k–30k and claim 9,641 units. These are measured fixture ranges, not worst-case proofs or promised network costs. Runtime tests load the compiled binary from `target/deploy`; rebuild after any source change to avoid testing stale bytecode.

## Remaining validator/release rehearsal

Use a compatible SBPFv3 test runtime (Anza documents Solana/Agave 4.0+ for v3 tooling) with a disposable fixture program. Do not reuse the historical Agave 2.1 validator. Pin and record the exact validator version and active feature set in test evidence. [Anchor CLI compatibility](https://www.anchor-lang.com/docs/references/cli)

- Execute prepare, activate, buy, sell, claim and cancel through real transactions, including maximum metadata and seven fee recipients. Measure transaction bytes, compute, stack and heap use.
- Prove activation fails with retained upgrade authority and unrelated ProgramData, succeeds only for its own immutable deployment, atomically mints the entire supply into custody and clears mint authority.
- Prefund every PDA independently before creation: pool, mint, token vault, SOL reserve, fee vault. Preparation/activation must succeed without accepting preowned/reinitialized accounts.
- Exercise cancellation followed by preparation/activation replay, wrong owners/mints/program IDs/signers/seeds, frozen/delegated accounts, duplicate mutable accounts and counterfeit events.
- Verify transaction rollback after a successful first CPI and deliberately failing later CPI, insufficient fee/rent, expired blockhash, slippage race, failed simulation and multiple swaps in one transaction.
- Verify ordinary SPL transfers/burns/donations, fee claims below recipient rent thresholds, off-curve smart wallets and one unusable fee recipient not blocking others. No transfer to a recipient may consume trading reserves.
- Compare final vault balances, fee liabilities, pool sequence, SDK quotes and indexed successful trades. Run finalized-history recovery and independent RPC reconciliation.

The offline runtime suite covers the listed subset, not a full networked-validator or production-wallet rehearsal. Remaining adversarial combinations, long randomized runtime campaigns, final-cluster feature compatibility, rent/compute costs, full indexing, real-wallet failure handling and deployment-bytecode reproduction must be evidenced before release. CI should fail on build/test errors; it must never deploy or revoke authority. Independent protocol security and economic review are still required after automated checks.
