# Solana implementation and release handoff

Status: **review candidate, not a mainnet release**. The workspace stays separate at `/solana`, with `SOLANA_ENABLED=0` and an unapproved, empty deployment manifest. Existing Base, Robinhood and Arc execution, authentication and database schemas are unchanged.

## Implemented

- Original token/SOL pool program: prepare, activate, cancel preparation, buy, sell and claim fixed beneficiary fees. No LP withdrawal, active-pool admin, fee setter, migration or emergency rescue instruction.
- Fixed 1-billion supply, 6 decimals, legacy SPL Token; activation places the full supply in custody and removes mint authority. Activation rejects a retained program upgrade authority. Trading reserves and beneficiary fees are separate accounts.
- Exact-integer SDK quotes, account/PDA/authority validation, binary-compatible instruction builders, packet-size checks, simulation, signed-message verification and signature-based finality recovery.
- Separate Wallet Standard workspace with explicit launch/trade/claim review. Signed transaction identity is journaled before broadcast; uncertain submissions are reconciled, never automatically replaced. Browser storage and Web Locks support are required for signing.
- Bounded, confirmed-event history and five-minute candles from this program's own swaps. This is a **recent window**, not lifetime volume, a full indexer or an aggregator listing.
- Feature-gated RPC and history endpoints; pinned Rust/SDK lockfiles, build-only CI and a read-only deployed-bytecode verifier.

## Local evidence

See [BUILD.md](../solana/BUILD.md) for exact toolchain versions, fixture hash, commands, compute observations and limitations. The current fixture passed 21 Rust host tests and 9 compiled-SBPFv3 LiteSVM tests. The SDK and independent economic model have separate regression suites. The app's lint, TypeScript, unit tests and production build are checked separately; CI must also pass for the final PR commit.

Offline VM tests use ephemeral identities and real System/SPL Token processors, not funded network wallets. No public-cluster deployment or authority operation has been performed. The checked-in fixture program ID is deliberately refused by app configuration and the release verifier.

## Reproduce without deploying

From `app/`:

```sh
npm ci --no-audit --no-fund
npm run lint
npx tsc --noEmit -p .
npm test
npx tsc --noEmit -p packages/solana-sdk/tsconfig.json
npx tsx --test packages/solana-sdk/tests/*.test.ts
node --experimental-strip-types --test ../packages/solana-model/*.test.mjs
npm run build
```

From `solana/`, use the pinned build and VM commands in [BUILD.md](../solana/BUILD.md). Rebuild the ELF before runtime tests after every program change. Changing the program ID also changes the reviewed binary; the fixture hash is not production evidence.

For app inspection with default configuration, run `npm run dev` in `app/` and visit `/solana`. It displays the release gates and cannot sign or accept funds. To test real devnet flows later, an operator must first supply a reviewed, immutable devnet deployment and configure `SOLANA_ENABLED=1`, `SOLANA_CLUSTER=devnet`, `SOLANA_DEVNET_PROGRAM_ID` and an HTTPS `SOLANA_RPC_URL`. Do not mislabel a mainnet RPC as devnet; the server verifies genesis identity.

## Required before Kevin deploys a production candidate

- [ ] Approve the exact economic specification: supply/decimals, fee tiers, rounding, fixed recipients, virtual reserve bounds, real exit-liquidity examples and lack of pause/rescue. The current 1 to 1,000,000 SOL initial-valuation bounds are mechanical limits, not an economic safety certification.
- [ ] Independent protocol security and economic review of the final source, with findings closed and reports published. Include long randomized runtime campaigns, account aliasing, donations/burns, prefunded PDAs, rent failures and dependency/loader assumptions.
- [ ] Select and securely control the real program identity outside this repository. Bind it consistently into the program and reviewed deployment metadata, then commit and rebuild. Never commit keypairs or credentials.
- [ ] Independently reproduce the reviewed binary with recorded toolchain provenance, exact source commit and SHA-256. Check current target-cluster runtime features, dependencies, compute and rent behavior.
- [ ] Rehearse deployment, immutability and full lifecycle on a disposable devnet identity. Activation intentionally cannot proceed while an upgrade authority remains. Never revoke the production authority merely to test whether code works.
- [ ] Real desktop/mobile wallet matrix: connect, switch/disconnect, reject, expired review, simulation error, tab/navigation races, multi-tab locking, RPC timeout after send, reload recovery, finalized failure and successful launch/buy/sell/claim. No user-funded mainnet test is automated here.

## Required product and operations work before broad mainnet rollout

- [ ] Durable paginated discovery and history. Current discovery lists active pools only (status-byte filter, addresses without data, so roughly 18,000 fit under the 4 MiB RPC response cap) and reads data for at most 50, in address order rather than by activity. Recent history reads at most 100 signatures, refetching only transactions it has not already cached. Neither is a production-scale indexer.
- [ ] Finalized checkpoint/reorg recovery, backfill and independent account reconciliation; full holder/transfer indexing before showing holder counts, lifetime volume or complete history.
- [ ] RPC provider quotas, edge-level rate limiting and monitoring. Current per-IP and process-wide budgets are a backstop, not a distributed abuse-control system. Account-provider outages must not cause automatic financial retries.
- [ ] Approve immutable metadata hosting/hash policy. Canonical name/symbol/URI live in the pool; no Metaplex metadata mirror is supplied, so third-party wallets may show the mint address rather than branded token metadata.
- [ ] Keep Solana separate until chain-aware discovery, address handling and product integration are verified. Existing EVM profile/post authentication does not authenticate Solana wallets; that integration is not implemented in this candidate.
- [ ] Publish risk disclosure, verified recovery instructions and an incident plan without a pause or rescue switch. Frontend rollback cannot recover funds from a flawed immutable program.
- [ ] Independently arrange any explorer/wallet/aggregator discovery. No Meteora, Jupiter, GeckoTerminal or DEX Screener listing is implied by this program.

## Production deployment and read-only verification

Kevin performs deployment and any authority removal manually, under separate approval and after the preceding review gates. This repository's CI and scripts do not deploy, sign with operator keys, or revoke authorities.

Prepare a candidate manifest using the schema in `app/src/lib/solana/deployment.json`: actual program/ProgramData, mainnet genesis, source commit, reviewed binary hash and review report URLs. Keep `releaseApproved: false` until final evidence is checked. From `app/`, set `SOLANA_VERIFY_RPC_URL` privately, then run:

```sh
npx tsx packages/solana-sdk/scripts/verify-manifest.ts <candidate-manifest.json> <reviewed-launch-pool.so>
```

This read-only command checks the cluster, linked immutable launch and legacy Token program accounts, exact ELF bytes and hash, and emits a finalized observation slot. It does not create an audit or approve release. Repeat against an independent trusted RPC and retain both reports with the build attestation.

Only after review and rehearsal should maintainers commit the populated manifest with `releaseApproved: true` and enable `SOLANA_ENABLED=1`, `SOLANA_CLUSTER=mainnet-beta`, and an HTTPS `SOLANA_RPC_URL`. An environment flag alone cannot bypass the incomplete manifest. Keep API credentials server-side; there is no server signing key.

## Rollback boundaries

Set `SOLANA_ENABLED=0` to close this website's Solana entry points. Preserve signed-transaction records and show recovery guidance before any public shutdown. This does not stop the immutable on-chain program, revoke unused wallet signatures, change pool terms, withdraw liquidity or undo trades. A protocol fix requires a new reviewed program ID for future pools; existing pools cannot be migrated by an admin.
