# Quote-only creator fees

New launches may choose quote-only fees using `QuoteLaunchFactory`, `QuoteFeeHook`, and `QuoteFeeVault`. The original factory and locker source remain unchanged. Existing pools retain their original fee behavior.

## Contracts and settlement

The factory atomically creates an ownerless `LaunchLocker`, a vault, and a hook with permissions `0x20cc`. It predicts its second CREATE child (the vault), mines the hook's CREATE2 address, and checks both actual addresses in its constructor. There is no initializer, admin, mutable fee, upgrade, pause, treasury, or platform allocation.

A launch creates a quote/token pool with **LP fee 0**, tick spacing 200, quote as currency0, and the suite's hook. The creator fee is fixed at launch, from 0 to 30,000 pips (3%). The NFT goes directly to the locker. Recipients are registered in the locker and vault, then swaps are activated. Nobody can initialize another pool with this hook outside the factory. Arc rejects address(0) quotes in both the factory and hook; use the six-decimal USDC ERC-20 address.

For denominator `D = 1,000,000` and creator rate `r`:

| Swap | Quote fee | When charged |
| --- | --- | --- |
| Buy, exact quote input `Q` | floor(Q × r / D) | Before swap; pool receives Q minus fee |
| Sell, exact token input | floor(gross quote output × r / D) | After swap; trader receives output minus fee |
| Buy, exact token output | ceil(pool quote input × r / (D − r)) | After swap; fee is added to quote owed |
| Sell, exact quote output `Q` | ceil(Q × r / (D − r)) | Before swap; pool produces Q plus fee |

For exact output, rounding up covers the configured rate on gross quote. Integer rounding can make dust-sized fees zero. Full specified fills are required in every direction, including zero-fee pools. Price-limit or liquidity-limited partial fills revert the whole swap; the hook's claims and accrual roll back. This avoids charging a specified fee on an unfilled amount, and it means a swap that fills nothing cannot move the price outside the liquidity range. The ordinary Universal Router single-hop exact-input path is supported, and so is the app's multi-hop "Buy with ETH" route (WETH → GITLAWB → TWIG → token) ending in a quote-only pool, where the hook charges the TWIG hop. Call the chain's real V4Quoter with the actual pool key; it includes the hook fee and rolls back all changes.

The hook mints PoolManager ERC-6909 quote claims directly to the vault and records the fee against the launch's pool. The vault keeps one pending total per position and emits no event of its own on a swap; `QuoteSwap.quoteFee` is the accrual record. It never sends funds to recipients during a swap. Each successful swap emits `QuoteSwap(poolId, executor, zeroForOne, exactInput, quoteFee, amount0, amount1)`. Amounts are trader deltas, after the creator fee. `executor` is the router/callback caller; it is not represented as the trader's wallet.

## Collection, credits and burns

Anyone can call `vault.collect(tokenId)` or `collectMany(ids)`. Collection clears only that position's pending fees, burns exactly those vault claims during a guarded PoolManager unlock, and takes the corresponding real quote asset. A balance check rejects an incomplete redemption. Unsolicited quote balances or claims are not distributed as launch revenue.

Recipients and shares are fixed at launch. Up to seven nonzero recipients must sum to 10,000 bps. Empty recipients mean 100% to `0x…dEaD`. Each share floors its allocation; the final recipient receives the remainder. Duplicate recipients are handled by adding their credits and indexing their separate payout events.

Recipient transfers execute in a bounded self-call (200,000 gas). A revert, false return, malformed return, or reentrant collection attempt rolls that transfer back and creates a reserved credit for that recipient and launch. Other recipients can still be paid. `claim(tokenId)` and permissionless `claimFor(tokenId, account)` pay the recorded account; there is no arbitrary destination. A failed claim reverts and preserves the credit. Burn transfers must succeed or the entire collection reverts. Shares are sent to the dead address, not removed from quote total supply.

PoolManager claims back pending fees; real vault balances back reserved credits. Multiple launches sharing one quote cannot collect one another's recorded fees. Collection leaves NFT ownership and liquidity unchanged. The legacy locker remains the immutable custody contract. Its separate LP collection path has no swap LP fees in these zero-LP-fee pools; donations and unrelated transfers are not creator swap fees.

Quotes should be standard, non-rebasing ERC-20s or native ETH. Fee-on-transfer and other nonstandard balance behavior is unsupported. Uniswap protocol fees are controlled by Uniswap's PoolManager and are separate from the creator rate.

## App and indexer

`lp-v1` and `quote-v2` suites coexist. Launch records store factory, locker, fee contract, hook, actual pool fee, creator rate, fee asset mode, and tick spacing. The existing `lp_fee` field remains the displayed trading rate for API compatibility. Trade and first-buy calls use the actual pool key. Quote-only collection uses the vault and its per-position claims; UI totals omit a launched-token fee leg.

Core `PoolManager.Swap` deltas and `QuoteSwap` trader deltas are both preserved. The indexer pairs authenticated hook events with core swaps by transaction, pool and occurrence, and checks delta consistency. Missing or inconsistent hook events stop the range for retry. Prices use core sqrt price; displayed trades, candles' volume and aggregate volume use the actual trader's quote amount. Wallet earnings sum `Paid` and `Claimed` events; credits count when paid. Recipient amounts are not estimated from collection totals for quote-only launches.

Fee event position IDs are bound to the emitting fee contract. Receipt and range ingestion use the same apply functions and dedupe keys. Each suite/factory has a cursor, so adding a deployment behind an existing chain cursor backfills its history. The per-chain cursor that `/api/health` reads is the slowest suite's, so a suite that is behind shows as lag. Accrued quote fees are totalled from `QuoteSwap.quoteFee` with each swap; the vault emits no accrual event. The migration labels existing rows as v1 and keeps nullable pool-rate fields compatible with legacy writers during rolling deploys. The poller fills missing v1 contract addresses once from the original deployment registry.

## Deploy and enable

1. Review the contracts and run the checks below.
2. Dry-run `forge script script/DeployQuoteLaunchFactory.s.sol:DeployQuoteLaunchFactory --rpc-url <RPC>`. Set `DEPLOYER_PRIVATE_KEY` through the normal secure local environment. Base, Robinhood and Arc dependencies match the deployment records; other chains require explicit `POOL_MANAGER` and `POSITION_MANAGER`.
3. Inspect the simulated factory, locker, vault, hook, salt, code sizes, and deployer nonce. Broadcast only the reviewed deployment. Changing the deployer nonce or compilation settings requires mining again.
4. Verify all four contracts and immutable dependencies on the chain explorer. Hook constructor arguments are `(poolManager, factory, vault)`; vault arguments are `(poolManager, positionManager, locker, factory, hook)`; locker takes `positionManager`; factory takes `(poolManager, positionManager, permit2, hookSalt)`.
5. Apply `app/db/schema.sql` with the normal migration command. Configure all five `NEXT_PUBLIC_QUOTE_{FACTORY,LOCKER,VAULT,HOOK,DEPLOY_BLOCK}` values (add `_ROBINHOOD` or `_ARC` for those chains). The registry rejects incomplete addresses, zero deployment blocks and incorrect hook permission bits.
6. Keep `NEXT_PUBLIC_QUOTE_LAUNCH_ENABLED` false while indexing and checking the deployment. Set it to true and rebuild to offer launches. Public settings are compiled into the client bundle. Disabling the launch flag still permits indexing and servicing existing quote-only launches. Do not replace a historical suite's addresses with an unrelated deployment.

No new production addresses are invented or deployed by this change. The example environment keeps the new launch option disabled until configured.

## Verification

```sh
cd contracts
forge build --sizes
forge test --match-path test/QuoteFees.t.sol -vv
FORK_TESTS=true forge test --no-match-path test/LaunchFactory.arc.fork.t.sol -vv
FOUNDRY_PROFILE=arc FORK_TESTS=true ARC_FORK_TESTS=true arc-forge test --match-contract 'QuoteFeesArcFork|LaunchFactoryArcFork' -vv
FOUNDRY_BASE=true FORK_TESTS=true B20_FORK_TESTS=true base-forge test --match-test test_fork_coinbaseStockRouterBuySellCollect -vv
script/check-arc-factory.sh
cd ../app
npm run lint
npm run typecheck
npm test
npm run build
```

Arc's tests require [Circle's Arc Foundry](https://github.com/circlefin/arc-foundry/releases) runtime; ordinary Foundry skips the new Arc tests unless explicitly enabled. Base and Robinhood tests exercise the deployed Universal Routers, quoters, Permit2 and PoolManagers with ETH/USDC/USDG buys, sells, collection and burns. Local tests cover all four directions with 6-, 8- and 18-decimal quotes, exact output, partial-fill rollback, payout failure and claims, gas-consuming recipients, false-return tokens, reentrancy, pool isolation, allocation rounding and separate protocol fees. Interleaved-pool fuzz tests check claim backing, credit reserves and accrued/collected conservation after every operation.

Additional live tests cover GITLAWB on both chains and Robinhood AAPL. Coinbase B20 stocks require [Base's native-precompile Foundry runtime](https://github.com/base/base-anvil), with the separate `B20_FORK_TESTS` opt-in. Ordinary Foundry cannot execute a B20 token's `decimals()` or balance/transfer calls; that runtime failure is not a fee-hook result.

For the DB integration check, start a disposable PostgreSQL instance and an empty database, then run from `app`:

```sh
QUOTE_TEST_DATABASE_URL=postgres://postgres:<test-password>@127.0.0.1:55432/<empty-test-db> \
  node --conditions=react-server --import tsx scripts/quote-indexer-check.mts
```

It applies the real schema twice, uses the real DB and indexer with deterministic RPC receipts, and verifies deduplication, core/trader amounts, fee attribution across suites sharing an NFT ID, credit/claim earnings, legacy identities and late-suite backfill. CI runs this check against a disposable PostgreSQL service.

### Implementation verification — 3 October 2026

- Full ordinary Foundry regression: **95 passed**. The three native-runtime cases skipped in that run passed separately: Arc's two quote tests and the B20 stock test.
- Circle Arc Foundry: **11 passed**, including nine existing Arc tests and two quote-only tests. Base's Foundry: **1 B20 stock test passed**. Combined contract coverage: **107 passing tests**, with 256 iterations for each of the three local fuzz tests.
- App: type checking, lint, and production build passed; **764 tests passed**, with ten existing optional live Relay checks skipped.
- Real PostgreSQL integration passed, including schema replay, receipt replay, suite/NFT isolation, trader deltas, paid earnings, and legacy/cursor migration. The fee asset selector was checked in the browser with no console errors.
- Atomic deployment was simulated and executed on a disposable Base fork; the transaction succeeded and all four contracts' code and immutable dependencies were read back and checked. Actual deployment gas was **7,144,882**. Production deployment remains a separate operation.

Runtime sizes in bytes: hook **5,261**, vault **6,240**, factory **14,752**. Factory init code is **34,262** bytes. Both runtime and init-code limits are respected. Solidity 0.8.26, Cancun, IR compilation, optimizer 200 runs; dependency submodule pins are unchanged.

Toolchains: ordinary Foundry 1.8.3 (`cae51ad458`), Circle Arc Foundry release `v0.8.0-2` (`d497bee`), Base Foundry `98e7839c65f64aee9627b69a9b98b79afaeb1fae`. The two native runtimes were downloaded from their official releases and their published SHA256 hashes were verified. Fork snapshots during the final runs: Base 52,137,309; Robinhood 79,414,368–79,414,414; Arc 24,115,804; B20 Base 52,137,228. These were latest-head runs, so later runs may use newer blocks.

### Review follow-up — 5 October 2026

After review the vault no longer keeps a per-quote `pendingClaims` total or emits `FeeAccrued`; neither was read on-chain. The hook is unchanged apart from a comment. The sizes, deployment gas and native-runtime results above predate this change; the figures below replace them.

- Ordinary Foundry with fork suites off: **84 passed**, 24 skipped. `QuoteFees.t.sol` has 28 tests, including a new one pinning that a sell which fills nothing reverts and leaves the price unchanged.
- `FORK_TESTS=true forge test --match-path test/QuoteFees.fork.t.sol` on Base and Robinhood: **9 passed**. The two Arc tests and the B20 stock test were skipped and still need their native runtimes.
- Runtime sizes in bytes: vault **6,047** (was 6,240); hook (5,261) and factory (14,752) unchanged. Factory init code is **34,069** bytes.
- App: type checking, lint and the production build (with CI's environment) passed; **768 tests passed**, with the ten optional live checks skipped.
- PostgreSQL 16 integration check passed on a disposable local container. `scripts/rebuild-launch-totals.sql`, run on the data it indexed, found no drift and kept the indexer's totals.
- `DeployQuoteLaunchFactory` ran on a local anvil fork of Base (block 52,242,300) from a fresh deployer. All four contracts landed at the predicted addresses; their 16 immutable dependencies and the hook's `0x20cc` permission bits were read back and matched. Deployment gas was **7,103,135**.
- Circle Arc Foundry `v0.8.0-2` (`forge 1.7.1-dev`): **11 passed**, the two quote-only Arc tests and the nine existing Arc tests, forked from Arc's latest head. The aarch64 Linux build ran in an `ubuntu:24.04` container; its SHA-256 matched Circle's published `.sha256` file and GitHub's asset digest. The macOS build needs Homebrew's `libusb`.
- After merging `main` (which added the ETH route): `test_fork_ethRouteBuysTwigQuotedLaunchInOneCall` buys a TWIG-quoted quote-only launch with 0.01 ETH through the real Universal Router in one call. The quoter's `quoteExactInput` over the three-hop path matched the tokens received exactly, the vault accrued `feeAmount(twigIn, 10000)` where `twigIn` is hop 1's GITLAWB output wrapped 1:1, and `collect` paid the recipient in TWIG. Base fork suite: **5 passed** with the B20 test skipped.
- Not re-run: the B20 stock test. On 6 October 2026 the `foundry_nightly_darwin_arm64.tar.gz` asset under Base's commit-pinned tag `nightly-98e7839c…` was replaced (SHA-256 now `7b4f41db…`, previously `39c8e7e7…`), and GitHub returned no build attestation for either version. The replacement was not run.

## Reference and attribution

The settlement design was informed by o1's MIT-licensed, verified [LaunchHook/FeeEscrow source on Base](https://basescan.org/address/0x1f91c998e7c2F4b690D75BDBf6502BDcD6e02AcC#code), linked from its [production registry](https://docs.o1.exchange/launchpad/reference/production-contracts). This implementation uses this repository's pinned v4 interfaces and pips, fixed recipients, and an immutable NFT locker. It excludes o1's mutable controllers, referral splits and buybacks.
