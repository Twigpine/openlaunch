Implementation reference: [full implementation and deployment guide](../contracts/docs/QUOTE_FEES.md). The original plan below is retained for design context.

# Quote asset fees implementation plan

Status: implemented on `codex/quote-only-fees`; see the linked guide for final behavior, verification, and deployment instructions. The planning baseline below was prepared on 3 October 2026 against repository commit `03842b5`, with implementation choices refined during development.

## Objective and scope

Allow a creator to choose fees paid entirely in the pool's quote asset when launching a new token. A USDC pair should earn USDC on both buys and sells; an ETH pair should earn ETH; a stock pair should earn that Stock Token. Fees should continue to go entirely to the fixed beneficiaries or burn allocation chosen at launch.

Implement this as a new contract deployment alongside the current deployment. The launch form selects the appropriate factory. Existing launches continue to use their original contracts, and creators can still choose the current fees-in-both-assets model for new launches. Existing pools cannot acquire a hook or move their permanently locked liquidity.

The recommended design adds a quote fee hook and a separate fee vault, while reusing the existing token and locker source. Each new factory deploys a **fresh locker instance**; the already deployed locker cannot register positions from a new factory.

Keep the existing economic constraints: no platform cut, no creation charge, no owner, no pause, no upgrade path, immutable fee rates and recipients, and permanently locked initial liquidity. The contract accepts creator fee rates from 0 to 30,000 pips; the UI keeps its 0%, 1%, and 3% presets. One pip is one millionth of the fee basis, so 10,000 pips means 1%.

Estimated effort is **8–12 focused engineering days** for the implementation, integration tests, documentation, and deployment tooling. This refines the earlier one-to-two-week estimate. Independent contract review, review findings, and production deployment scheduling are additional. The implementation is being delivered as the full contract, app, indexer and deployment change.

## Reference implementation and current constraints

The o1 source inspected for this plan is the verified Base Standard suite linked from its [production contract registry](https://docs.o1.exchange/launchpad/reference/production-contracts):

- [LaunchHook and included FeeEscrow source](https://basescan.org/address/0x1f91c998e7c2F4b690D75BDBf6502BDcD6e02AcC#code): `_beforeSwap`, `_afterSwap`, `_feeAmount`, `_quoteCurrencyAndSpecified`, `_requireFullSpecifiedFill`, and escrow redemption are useful references. Both source files carry MIT license headers.
- [Launch factory source](https://basescan.org/address/0x1176122eb77AD6a2339322Cda7C4D7ea9BfA63dC#code): its pool construction uses a zero LP fee and the launch hook.
- [Documented fee behavior](https://docs.o1.exchange/launchpad/trading/fees-referrals): ordinary recipient fees are denominated in the paired asset for both directions.

Adapt the fee calculation and Uniswap claim settlement ideas. Openlaunch's implementation should retain its existing custody model and fixed recipient allocations. Any copied code needs its license notices and an attribution record. Pin the source snapshot and deployed address used during implementation; an explorer page can contain multiple source files and historical suites differ.

Repository constraints that drive this plan:

| Current code | Consequence |
| --- | --- |
| `contracts/src/LaunchFactory.sol` constructs a pool with `fee = lpFee` and a zero hook | A quote-only pool needs a new factory and pool identity. |
| `contracts/src/LaunchLocker.sol` owns the NFT forever and distributes both LP fee assets | Keep that custody source intact; new quote trading fees belong in a separate vault. |
| `contracts/src/LaunchFactoryArc.sol` rejects native quote addresses | Preserve that restriction for the new Arc factory because native and ERC-20 USDC share backing. |
| `app/src/lib/launchpad/config.ts` selects one factory and locker per chain | Add a registry of contract suites and resolve addresses per launch. |
| `app/src/components/launchpad/LaunchForm.tsx` and the token page construct hook-free pool keys | Update both ordinary trades and the optional first buy. |
| `app/src/lib/launchpad/meta.ts` predicts addresses with the chain's current factory | Metadata registration and salt search must use the selected suite. |
| The indexer and UI use `lp_fee` for both pool identity and displayed fee | Separate the actual LP fee from the creator trading fee. |
| `app/src/components/launchpad/FeeChip.tsx` already uses `feeModeOf` for beneficiary/burn classification | Use a separate name for the fee asset choice. |

All repository paths in this plan are relative to `/Users/dev/projects/openlaunch`. New filenames below are proposed implementation targets.

## Product behavior

For a nonzero trading fee, add a choice labeled **Fee assets**:

- **Both pool assets**: current behavior; buys earn quote assets and sells earn launched tokens. Keep this as the initial default.
- **Quote asset only**: show the selected asset symbol, such as “USDC only”; both trade directions earn that asset.

Hide the asset choice at 0% and use the existing factory for zero-fee launches from the UI. The new contracts should still handle a zero fee correctly for direct callers and tests. Changing the quote should update the label. Changing the suite must invalidate any prepared launch transaction, token prediction, or salt-search result.

The recipient choices remain “Burn the fees,” “My wallet,” and custom splits. A quote-only burn sends the quote asset to the dead address when collected. Rates and destinations are fixed at launch.

A buy spending 100 USDC with a 1% creator fee sends 1 USDC to fee accounting and 99 USDC into the pool. A sell producing 100 USDC before the creator fee sends 1 USDC to fee accounting and 99 USDC to the seller. These examples exclude rounding and any separate Uniswap protocol fee. There is no secondary sale of accumulated launch-token fees.

Collection remains permissionless and pays the configured recipients. Failed ordinary payouts become claimable credits. The dashboard distinguishes fees awaiting collection, amounts paid, outstanding credits, and amounts actually burned.

## Contract architecture

### Components

| Component | Responsibility |
| --- | --- |
| New `QuoteLaunchFactory.sol` | Deploy token; register the pool; initialize and seed it; create the permanent position; bind quote fee accounting. |
| New `QuoteLaunchFactoryArc.sol` | Apply the native-quote rejection for Arc through a small specialization of the new factory. |
| Existing `LaunchToken.sol` | Fixed supply and existing metadata behavior. |
| Fresh instance of existing `LaunchLocker.sol` | Own the position NFT permanently using the current code and registration checks. |
| New `QuoteFeeHook.sol` | Apply the fixed fee in currency0, which remains the quote asset; mint matching Uniswap claims to the vault. |
| New `QuoteFeeVault.sol` | Track earned fees separately for each pool, redeem them at collection, split payments, and retain failed payouts for claims. |

The pool uses `fee = 0`, tick spacing 200, and the new hook. The creator fee is a separate stored value. Keep the existing token address ordering, token-only initial position, supply handling, salt scoping, and rounding-dust behavior.

Flow:

1. The factory creates the token and registers the exact pool key and immutable economics.
2. It initializes the pool and mints the position NFT directly to its fresh locker.
3. It registers the position with the locker and vault, then activates the pool for swaps.
4. A swap runs through the hook. The hook creates a quote-denominated Uniswap claim owned by the vault and records the same amount against that pool.
5. Anyone calls `vault.collect(tokenId)`. The vault redeems only that pool's recorded claims and distributes the resulting quote asset.

An ERC-6909 claim is a redeemable balance held inside Uniswap's PoolManager. It lets the hook account for fees without sending assets to arbitrary beneficiary wallets during a swap.

The new locker is custody for the LP position; the vault is the source of quote trading fees. Existing locker behavior for unsolicited transfers or LP donations is separate from hook fee accounting. Do not classify those transfers as quote-only trading fees or sweep them into the vault.

### Hook permissions and registration

Enable only the callbacks required for pool initialization and swap fees: `beforeInitialize`, `beforeSwap`, `afterSwap`, and the two swap return-delta permissions. Derive the permission mask from the pinned Uniswap dependency and validate it in the hook constructor.

Only the immutable factory may register a pool. Registration must validate the hook address, zero LP fee, quote/token ordering, spacing, rate bounds, and uniqueness. Every hook callback must accept calls only from the bound PoolManager. An initialization callback must also require the registered pool and factory initiator. Swap callbacks must reject unregistered or incompletely initialized pools.

The factory remains permissionless to launch through. Registration is an integrity check on pools using this hook, not a restriction on who may launch or trade. Ordinary third-party liquidity additions may remain possible as they are today; all creator fees in this pool still follow the launch's allocation, and its zero LP fee does not reward additional LPs with trading fees. The original position stays locked in the locker.

Keep all beneficiary transfers outside swap callbacks. The vault's hook-only accrual method should perform bounded accounting and emit events, with no beneficiary calls. Ignore arbitrary hook data unless a documented field is introduced later; it must never choose fee recipients or change rates.

## Fee calculation

Use raw asset units and integer arithmetic throughout. Let `D = 1_000_000` and `r` be the configured creator fee in pips. Adapt o1's rounding approach to this denominator; do not mix its basis-point units with Openlaunch pips.

| Swap request | Quote fee | Callback charging the fee | Result |
| --- | --- | --- | --- |
| Exact-input buy, spending `Q` quote | `floor(Q * r / D)` | Before swap, specified-currency delta | Pool receives `Q - fee`; total quote spent is `Q`. |
| Exact-input sell, pool outputs `G` quote | `floor(G * r / D)` | After swap, unspecified-currency delta | Seller receives `G - fee`. |
| Exact-output buy, pool needs `C` quote | `ceil(C * r / (D - r))` | After swap, unspecified-currency delta | Buyer pays `C + fee` for the requested tokens. |
| Exact-output sell, seller requests `N` net quote | `ceil(N * r / (D - r))` | Before swap, specified-currency delta | Pool outputs `N + fee`; seller receives `N`. |

Use full-precision multiplication/division and checked conversions to the signed delta types. Check the adjusted amount as well as the fee for overflow. Test zero, dust-sized amounts, and boundary-sized swaps. There must be exactly one fee charge per swap.

The app continues to offer exact-input swaps. Supporting exact-output correctly in the contracts makes direct Uniswap integrations predictable without adding a new UI flow.

For the first version, require a full fill in both directions and both amount modes. Compare the actual specified-currency pool delta against the requested amount adjusted by any before-swap fee. Revert with a documented `PartialFillUnsupported` error on a partial fill. In particular, a fee reserved before a swap must never survive when the corresponding quoted amount was not consumed. This is an explicit compatibility limit for external routers with tight price limits.

Emit a swap event after successful callback checks that includes the pool ID, callback executor, direction, exact-input/output mode, quote fee, and signed amounts after the hook fee. With quote as currency0, the caller's quote delta is the core swap's `amount0 - quoteFee`; the token delta is unchanged. Verify these fields against real wallet balances in router tests. The executor is a router or callback contract and must not be labeled as the user's wallet.

## Vault accounting and collection

### State and public surface

Use `poolId` as the internal accounting identity. Bind each pool to its quote, token, NFT ID, and recipient list once. Maintain a `tokenId` lookup for the existing collection UX.

Proposed public functions:

- `register(...)`: factory-only binding after NFT ownership has been established.
- `accrue(poolId, amount)`: hook-only addition to pending fees for a registered pool.
- `pendingFees(tokenId)`: uncollected quote amount.
- `collect(tokenId)` and `collectMany(tokenIds)`: redeem and distribute pending fees.
- `claimable(tokenId, account)`: failed payout belonging to this launch and recipient.
- `claim(tokenId)` and `claimFor(tokenId, account)`: pay recorded credits to the recorded recipient.
- `recipientsOf(tokenId)` and the quote/token lookups needed by the app and indexer.

Keep failed credits per launch and recipient. This makes a recovered payout attributable to the correct launch. The vault also needs currency-level reserved totals to prove its real-token backing. V1's aggregate `claim(address currency)` ABI remains supported through a separate app adapter.

### Collection sequence

1. Read this pool's pending amount and clear that accounting before external interactions under a reentrancy guard. A zero amount is a no-op.
2. Unlock the PoolManager, burn exactly that amount of the vault's quote claim, and take exactly that amount of the real quote asset into the vault.
3. Return from the PoolManager callback before paying recipients.
4. Split the redeemed amount using the existing basis-point allocation. The last recipient receives rounding dust.
5. Push ordinary shares. If a transfer fails, retain the funds as that launch's recipient credit. Use robust ERC-20 return-data handling and bounded payout execution, with gas limits verified against supported quote tokens. A failed attempt must roll back the token transfer itself: use an external self-call payout helper restricted to the vault, which reverts on false/malformed returns, and catch that revert before recording a credit. Do not credit an amount after a token transferred it but returned false.
6. Send burn shares to `DEAD`. Match current semantics: if the quote refuses this burn transfer, revert the collection for this launch. Swaps and other launches remain independent; never report a failed transfer as burned.
7. Emit collection, payment, credit, and burn events with pool or token identity. Later claims emit their own events without incrementing collected totals again.

Restrict `unlockCallback` to the PoolManager and an active, internally initiated redemption. Encode only the expected quote and amount, and always take funds into the vault. It must not accept an arbitrary payout destination or liquidity operation. Claims can only pay the account to which the credit belongs.

Preserve the existing expectation of ordinary, non-rebasing quote transfers. A fee-on-transfer or otherwise nonstandard quote needs explicit compatibility work; declaring an arbitrary address as a quote must not be treated as proof that it obeys those accounting assumptions. Check the amount actually received during redemption for the supported assets and fail atomically on a mismatch.

### Accounting invariants

- For each quote currency, the vault's Uniswap claim balance is at least the sum of recorded pending fees across pools using it.
- For each quote currency, the vault's real balance is at least the sum of reserved failed payouts.
- Each collection satisfies `collected = directly paid + newly credited + burned`.
- Each pool satisfies `total accrued = total collected + pending fees`.
- Claiming a credit decreases both the recipient credit and reserved balance by exactly the paid amount.
- No collection can consume another pool's pending fees or another recipient's credit.
- Unsolicited real-token or ERC-6909 transfers do not increase recorded earnings. Track only amounts authorized by the hook; do not distribute `balance - reserved` as pool revenue.

On Arc, allow only the ERC-20 representation of USDC as its USDC quote, and retain native-quote rejection at both factory and hook registration boundaries. Use six-decimal quote units even though native gas accounting uses 18 decimals. Review and test any native `receive` path so the two representations cannot become separate spendable ledgers.

## Factory and deployment work

Implement the new factory without editing the verified v1 source. Give its launch parameters an explicit `creatorFeePips` field. Keep the existing `predictToken`, `findSalt`, and `poolKeyOf` concepts, with a v2 ABI that exposes the complete actual pool key and new deployment addresses.

During launch, normalize an empty beneficiary list into a 100% burn allocation and validate the same seven-recipient limit and 10,000-basis-point sum as today. Register the exact same immutable allocation with the locker and vault. Initialize and seed the pool within one transaction; do not allow it to trade before all bindings exist. Reuse the existing supply limits, zero-quote-deposit checks, allowances cleanup, and token dust burn.

Use a shared new factory implementation with a small Arc specialization rather than creating another pair of large, divergent source copies. Keep the existing v1 Arc source-drift check intact.

Add a deployment script that mines the hook address using the final compiler output and permission mask. Deploy and bind the complete suite in one transaction. A concrete approach is an ordinary CREATE deployment of the factory, whose constructor creates its locker and vault and then the CREATE2 hook:

- Predict the factory from the deployer's nonce and predict the vault from the factory's child-creation order.
- Mine the hook salt using those addresses and the final hook constructor arguments.
- Give the vault the expected immutable hook address, deploy the hook, and assert that every actual address and dependency matches the prediction before the constructor completes.
- Allow necessary forward references during construction, then verify the complete bindings before deployment succeeds. Do not leave an externally callable initializer or persistent deployment privilege.

This prediction is separate from launch-token salt mining. Do not reuse the old deployment script's nonce-zero/same-address assumptions. Record per-chain factory, locker, vault, hook, PoolManager, PositionManager, creation transaction, deployment block, compiler settings, code hashes, and permission mask. Check runtime and init-code size limits early; if constructor composition exceeds them, use an atomic deployment helper with the same completed bindings.

## Data model and indexing

### Contract suite registry

Add `app/src/lib/launchpad/suites.ts` with versioned suite definitions containing:

- Chain, suite ID, contract version, factory, locker, fee contract, hook, and deployment block.
- Fee asset mode: `both` or `quote`.
- ABI/adapter identity and the correct Uniswap dependencies for that chain.
- Whether the application currently offers new launches through this suite.

Retain v1 environment variables as inputs to legacy suite entries. Resolve all reads and writes from the launch's stored suite. Keep the chain-level quote catalog separate. Hiding a suite from new-launch choices must not remove its trading, indexing, or claim support. This is application configuration, not an onchain pause.

### Schema changes

Use additive, idempotent migrations in the existing schema/migration workflow.

For launches, add `suite_id`, `contract_version`, `factory_address`, `locker_address`, `fee_contract_address`, `hook_address`, `pool_fee_pips`, `creator_fee_pips`, `fee_asset_mode`, and actual tick spacing. Backfill v1 rows from the matching chain deployment: zero hook, original LP fee in both rate columns, and mode `both`.

Preserve `lp_fee` temporarily as a documented compatibility field while callers move to the explicit fields. For v2 records it can mirror the user-facing creator rate for old read clients, but must never be used to construct the actual pool key. All transaction-building paths must be upgraded before v2 launches become available.

For fee events, retain the emitter/fee contract, suite, pool ID, token identity, and event kind. Keep the existing `(chain_id, tx_hash, log_index)` idempotency key. Add accrued-quote totals separately from collected, paid, credited, claimed, and burned totals. The v2 launched-token trading-fee totals remain zero.

For swaps, preserve the core PoolManager amounts and add the hook fee and amounts including that fee. Keep existing pool-volume semantics for `volume_quote` so historical comparisons remain coherent; expose actual quote spent/received separately in trade details. Pool price and candles continue to come from core pool price/tick data.

### Event contract

Finalize these event fields alongside the contract tests before writing the indexer adapter:

| Emitter and proposed event | Required information and meaning |
| --- | --- |
| Factory `QuoteLaunched` | Token, NFT ID, launcher, quote, pool ID, start tick, creator fee pips, supply, and metadata URI. Decode with the v2 ABI; do not reinterpret a v1 LP fee field. |
| Hook `QuoteSwap` | Pool ID, executor, direction, exact-input/output mode, quote fee, and signed swap amounts including that fee. Emit once per completed swap, including zero-fee swaps. The quote fee is the accrual record: it increases accrued totals, not paid or collected totals. |
| Vault `Collected` | NFT/pool identity and quote amount redeemed for allocation. |
| Vault `Paid`, `Credited`, `Claimed`, `Burned` | NFT/pool identity, quote currency, amount, and recipient where applicable. Credits record retained funds; claims record their later payment; burns record an actual transfer to `DEAD`. |

Use event identifiers together with the emitting address and chain. Pin topic layouts and conservation relationships in `QuoteFeeEvents.t.sol`. Keep v1 ABI definitions unchanged.

### Indexer changes

1. Decode launch receipts by their verified emitting factory and ABI, then persist the suite and full pool identity. Never accept a client-selected arbitrary fee contract.
2. Read v1 recipients from the locker and v2 recipients from the vault. Make healing jobs and immediate receipt sync use the same resolution.
3. Scan all configured factories and fee contracts. Query shared PoolManager swap logs once for known pools.
4. Index the new hook swap event even for zero-fee swaps. Match it to the corresponding core Swap in the same transaction and pool, in execution order. A transaction may trade the same pool multiple times; a transaction hash alone is insufficient.
5. Keep each trade and its aggregate updates atomic. Persist core and hook data together for v2, or retry when the receipt is incomplete. Do not double-count a fee when collection or a later claim occurs.
6. Qualify NFT lookup keys by chain and PositionManager, and accounting lookups by emitting fee contract and pool. Token IDs are globally unique only within one PositionManager.
7. Retain the chain cursor for shared scans, and add per-suite backfill progress. Adding a suite whose deployment predates the cursor must trigger a bounded replay from its deployment block. Enable launches only after catch-up succeeds.
8. Update system-address/holder exclusions for every suite. Preserve the existing transaction-sender attribution behavior and do not equate the hook executor with the trader.

Keep the current overlap/deduplication behavior and test it for both event families. Full removal of orphaned-chain events would be a separate indexer change if the current implementation does not already support it.

## App integration

### Launch preparation and first buy

Update `LaunchForm.tsx`, `LaunchFeeSettings.tsx`, `metaShared.ts`, `meta.ts`, and the launch metadata route to carry a validated suite ID. Resolve it from server configuration; do not allow callers to provide an arbitrary factory address.

The selected suite must consistently determine prediction, salt search, launch parameters, simulation, event decoding, and the optional first buy. Keep the stable metadata key independent of salt search. Reset the prepared attempt when chain or suite changes so an old predicted token cannot be submitted to a different factory.

Fetch `poolKeyOf(token)` from the launch's factory after the launch, or use a verified full key from its receipt/adapter. Replace the hardcoded zero hook in `firstBuy`. Preserve the existing separate-transaction first buy: a failed buy must still display a successful launch.

### Trading and fee labels

Update the token page and `TradePanel.tsx` to use the stored actual pool key. Pass it through the existing v4 quoter and router encoder. Hook-aware simulation must determine output and slippage protection; do not subtract the creator fee a second time in the browser.

Use `creator_fee_pips` for fee labels and filters, and `pool_fee_pips` for the key. A v2 pool with `pool_fee_pips = 0` and `creator_fee_pips = 10_000` must display a 1% trading fee. Update fee chips, burn/free filters, launch lists, previews, social cards, feeds, and explanatory copy accordingly.

Keep the existing beneficiary classification separate from the new asset mode; rename `feeModeOf` to `feeDestinationOf` if needed. UI labels should describe the chosen asset and rate without exposing deployment versions or hook internals.

### Collection and creator dashboard

Add a small adapter layer for fee reads and transactions:

- V1: existing locker, two fee currencies, existing collection and currency-based claim calls.
- V2: quote vault, `pendingFees(tokenId)`, one fee currency, and launch-specific claim calls.

Use it in `CollectPanel.tsx` and `MeDashboard.tsx`, including simulated collect previews, collection, and pending-credit reads. For quote-only launches, show a single quote amount and the appropriate burn text. Keep old launch pages displaying both assets.

For v2, compute recipient earnings from exact payment and credit events. `Paid + Credited` records earned amounts already allocated; claiming a credit changes its paid status and must not count it as newly earned. Uncollected shares are a separate preview using the same allocation rounding as the vault. The current helper `(collected - burned) * recipientShare` is not suitable for exact per-recipient earnings when a split includes a burn; add a targeted regression if that helper is reused or corrected.

Update the wallet API to return suite and fee information for both creators and fee beneficiaries needed by these views. Verify existing signed metadata edits still authorize the indexed launcher correctly for both suites.

### Documentation and external consumers

Update the README, contract guide, production runbook, agents page, `llms.txt`, rules/about content, and any “no hook” or “both assets” claims to describe both launch modes. Document the new factory/vault ABIs, actual pool-key retrieval, exact-output behavior, and partial-fill restriction. Include attribution for adapted source and the compatibility impact on third-party routers.

## Implementation milestones

The milestones can be reviewed as commits in one feature PR or split into dependent PRs. Keep the v2 launch option unavailable until the complete flow passes its acceptance tests.

| Milestone | Deliverable | Completion evidence | Effort |
| --- | --- | --- | --- |
| 1. Contract implementation | Fee math, hook callbacks, minimal accrual/redemption; real pinned v4 dependencies | Native/ERC-20 buy and sell, exact-output cases, quoter/router compatibility, measured gas and build sizes | 1–2 days |
| 2. Complete contracts | New factories, production vault accounting, immutable deployment wiring, splits/burns/credits | Unit/fuzz/invariant tests and preserved liquidity custody | 2–3 days |
| 3. Suite and data support | Registry, migrations, dual event decoding, catch-up, metadata prediction | Legacy data preserved; both suites replay idempotently; full pool keys match onchain | 1.5–2 days |
| 4. App integration | Asset selector, launch/first buy/trade/collect, earnings and labels | Complete browser flows against local forks, including old launches | 1.5–2 days |
| 5. Release validation | All chain forks, deployment rehearsals, source verification workflow, docs and CI | Reviewable PR with actual check results and deployment manifests | 2–3 days |

The high end includes Arc-specific debugging. Re-estimate after milestone 1 if the installed periphery or chain execution rules require a different settlement path.

## Test plan

### Contract behavior

- Test all four direction/amount combinations in the fee table with native and ERC-20 quotes, including 6-, 8-, and 18-decimal assets.
- Test rates 0, 1%, 3%, arbitrary accepted pips, and rejection above the cap. Test dust fees, integer boundaries, rounding, signed casts, and repeated swaps.
- Compare quote fee, trader net amounts, pool deltas, and vault claim backing. Exercise Uniswap protocol-fee settings separately so a zero LP fee is never assumed to mean zero total cost.
- Force partial fills at price limits and liquidity boundaries. Assert complete rollback, including claims, events, and vault accounting.
- Test an empty beneficiary list, one recipient, seven recipients, partial burns, duplicate recipient addresses, invalid addresses, and incorrect allocation sums. Freeze both allocations and rate after launch.
- Test native recipients that reject ETH, reverting/false-return/malformed-return ERC-20 transfers, reentrancy attempts, and a quote that refuses the dead address. Assert the documented credit or rollback behavior.
- Interleave trades and collections across two pools sharing a quote, and across different quotes. Add unsolicited quote tokens and unsolicited ERC-6909 claims; prove they cannot alter another pool's fees or reserved credits.
- Call collection and claims twice; confirm no double payout. Test `collectMany` and unauthorized register/accrue/callback calls.
- Attempt NFT transfer, approval, liquidity withdrawal, minting extra launch tokens, rate changes, and recipient changes. Confirm that the initial position and economics remain fixed.
- Test factory address prediction, launch salt collisions, hook permission bits, wrong dependency bindings, and atomic deployment rollback.

Suggested new suites: `QuoteFeeMath.t.sol`, `QuoteLaunchFactory.t.sol`, `QuoteFeeHook.t.sol`, `QuoteFeeVault.t.sol`, `QuoteFeeInvariants.t.sol`, and `QuoteFeeEvents.t.sol`.

### Chain integration

- Base: native ETH and USDC through the deployed v4 quoter and Universal Router; cover GITLAWB and a representative B20 stock quote.
- Robinhood: native ETH, USDG, GITLAWB, and a representative Stock Token; preserve stock denomination handling.
- Arc: ERC-20 USDC through the chain's actual router layout using Circle's Arc Foundry runtime. Prove native-quote refusal, six/18-decimal separation, and correct reservation after a blocked payout.
- On each chain, exercise launch → buy → sell → collect → claim when relevant, then show an existing v1 launch can still trade and collect.

Third-party router recognition of a new hook is a separate integration question. The release must verify Openlaunch's supported quoter/router path and document any external routing limitations actually observed.

### App and indexer behavior

- Backfill migrations are repeatable and preserve v1 fee totals and addresses.
- The same chain can index v1 and v2 transactions, repeated scans, out-of-order receipt sync, multiple swaps of one pool per transaction, and delayed suite registration.
- Selecting quote-only uses the same factory for metadata prediction, salt search, simulation, launch receipt decoding, and first buy. Test switching modes and retrying failures.
- Quoted output equals the supported router simulation and respects the wallet's minimum output. Test fee-free and nonzero-fee v2 pools.
- A 1% quote-only launch is never classified as free because its LP fee is zero.
- Dashboard earnings correctly handle a 60% wallet / 40% burn split, unpaid credits, later claims, and a beneficiary who is not the creator.
- Verify complete browser flows on desktop and mobile for each fee mode, including signing rejection, reverted swaps, first-buy failure after a successful launch, and collection retries.

### Required checks

Run the existing contributing checks: application lint, TypeScript checking, unit tests, production build, contract build, existing unit suites, and live forks. Extend `.github/workflows/ci.yml` so the new contract unit/fuzz/invariant suites actually run; its current explicit test paths will not discover new suites automatically. Include the existing event suite and the new event accounting suite.

Record the exact fork blocks, chain toolchain, commands, gas measurements, and failures or skipped checks in the PR. Use Arc Foundry for Arc execution. A passing upstream Forge run is not Arc integration evidence.

## Rollout and recovery

1. Merge additive schema and suite support with existing launches still using v1 by default.
2. Rehearse the new deployment against pinned forks. Verify initialization, immutables, permission bits, bytecode size, and full launch/trade/collection flow.
3. Complete contract review, resolve findings, and rerun affected checks before production deployment.
4. Deploy and verify the Base quote suite first. Register its deployment block, let the indexer catch up, and expose the new choice after deployment checks pass.
5. Repeat the chain-specific process for Robinhood and Arc. Keep the option unavailable on a chain until its own suite is ready.
6. Keep v1 factories and all historical suite entries readable indefinitely. Observe actual receipts and indexed totals from the first new launches before widening availability.

If a new suite has a problem, remove it from the application's new-launch choices and investigate its existing pools. That action does not pause the immutable factory, disable direct launches, recover locked liquidity, or alter fees on already launched tokens. A contract correction requires another deployment and another suite entry. Keep trading and claims accessible wherever the existing contracts can safely support them.

## Acceptance criteria

- A creator can explicitly choose quote-only fees for a new nonzero-fee launch on each enabled chain.
- Both buy and sell trading fees accrue entirely in the configured quote asset, with no conversion swap or platform recipient.
- The fee math, rounding, fill rules, supported currencies, and events match the documented behavior.
- Collection sends exactly the launch's earned quote fees to its fixed recipients or burn destination; failed ordinary payments remain correctly backed and claimable.
- All accounting invariants hold under fuzzing and interleaved pools, collections, and claims.
- The initial liquidity remains permanently locked, and rates/recipients cannot be changed after launch.
- Existing tokens retain working trade, collection, claim, metadata, and dashboard flows.
- Metadata prediction and the first buy work with the actual chosen factory and pool key.
- The app and indexer distinguish LP fees, creator fees, accrued fees, payouts, credits, and burns without double counting.
- Every supported chain has passing integration evidence, verified deployment tooling, and accurate documentation before its quote-only option is enabled.

The first implementation step is milestone 1: prove the four swap cases and quote-claim redemption against the repository's pinned Uniswap dependencies. That settles the main technical uncertainty before the broader app and migration work.
