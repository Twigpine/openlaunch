# Native Solana mainnet integration

Superseded on 10 October 2026 by [the original immutable launch-pool plan](SOLANA_IMMUTABLE_POOL_PLAN.md). This document is retained as the evaluated Meteora option, not the active implementation direction.

Status: proposed architecture, not approved for deployment. Researched 10 October 2026 against Openlaunch main `ef8b642b258ec6dd385335fb24ef00a923c72b62`.

## Recommendation

Build an Openlaunch-owned Solana integration on Meteora's deployed DAMM v2. Use direct token/SOL pools, permanent locking of launch liquidity, and a small original Openlaunch program for launch registration and fixed fee rights. Do not build another AMM or buy a vendor-dependent launch stack.

This is a complete mainnet product plan, not a devnet-only launch demo. Devnet is a verification stage. Mainnet release includes launch, discovery, buy, sell, charts, holders, fee claims, wallet identity, and transaction recovery.

Meteora is a strong functional fit for the existing immediate-pool model, not an unconditional match for Openlaunch's trust guarantees. Its single-sided pool creation does not require the creator to seed quote liquidity. Bonding-curve graduation would be a different product and is not part of this proposal. [Pool creation documentation](https://docs.meteora.ag/user-guides/creating-a-liquidity-pool)

## 1. Decisions that must precede implementation

### External program trust

Openlaunch's [contribution rules](../CONTRIBUTING.md) reject contract owners, pause controls, and upgrade paths. Our own Solana program should preserve that policy: no platform fee, no privileged withdrawal, no recipient editor, no pause instruction, and no retained upgrade authority on the production deployment.

That cannot make Meteora immutable. A read-only mainnet RPC inspection on 10 October, at context slots `455201469` and `455201470`, found:

| Program | Address | Observed deployment slot |
| --- | --- | --- |
| DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | `445230614` |
| Dynamic Fee Sharing | `dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh` | `435662190` |

Both retained upgrade authority `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd`. DAMM v2 ProgramData was `AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH`. This is an observation, not an audit: authority ownership, signing policy, timelock, and a deployed-binary/source match remain unverified. Repeat and preserve this evidence before release.

At source commit `a85c926607433f23f0ea60f4ca7b1ae92f4156cb`, authorized protocol operators can change pool status and eligible fee parameters. The account checks do not exclude the permissionless customizable pools proposed here or require creator consent. This source-level finding is distinct from proving that source matches the deployed mainnet binary. Do not promise an unpausable pool or permanently fixed trading fees. [Status handler](https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/instructions/operator/ix_set_pool_status.rs#L12-L38), [fee handler](https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/instructions/operator/ix_update_pool_fees.rs#L104-L132), [operator authorization](https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/access_control.rs#L12-L24)

Required decision: accept this explicitly disclosed third-party trust boundary, or stop and evaluate an immutable alternative. Do not copy the EVM claim of an entirely non-upgradeable launch path onto Solana.

### Fees and supply claims

Proposed policy:

- Openlaunch launch/platform/referral cut: zero.
- Initial selectable total trading fees: 0.01%, 1%, or 3%, subject to verified pool constraints. No 0% choice.
- Use quote-only fee collection (`OnlyB`) with dynamic fees and fee scheduling disabled initially.
- Display total trading fee, Meteora protocol deduction, and beneficiary LP share separately. Meteora currently documents a default protocol share of 20% of trading fees. For example, a 1% trade fee at that split allocates 0.2% of trade value to protocol and 0.8% to LP beneficiaries, before rounding. Recheck actual on-chain parameters; do not hardcode the split as a permanent guarantee. [Fee documentation](https://docs.meteora.ag/core-products/damm-v2/fees/overview)
- No SOL-fee burn mode in the first release. Burning wrapped SOL through the Token Program is unsupported; unwrapping is not burning. A forfeiture vault or buyback-and-burn would need a separate specification. [Solana burn semantics](https://solana.com/docs/tokens/basics/burn-tokens)
- Creation costs include account rent, network fees, and any required setup funding. Show an estimate before signing; do not say the only cost is gas.

Locked liquidity is not backing, a price floor, or guaranteed exit value. In a single-sided launch, buyers bring quote reserves. Show real reserves separately from market capitalization, and explain that selling depends on available reserves and price impact.

## 2. Mainnet release scope

| Area | Required outcome |
| --- | --- |
| Wallets | Solana Wallet Standard discovery, account changes, disconnect, supported-network checks, and mobile-wallet verification. Keep existing EVM connections intact. |
| Launch | Name, symbol, image, immutable launch terms, validated supply and starting-price range, fee recipients, cost review, simulation, submission, confirmation, recovery. |
| Pool | Direct token/SOL DAMM v2 pool; all launch liquidity permanently locked under the selected program's rules; no creator inventory allocation. |
| Trading | Native buy and sell, current quotes, minimum received, price impact, slippage protection, network/account costs, SOL gas reserve, and explicit failed/pending states. |
| Discovery | Solana chain filter, case-sensitive mint lookup, launch list, watchlist, token page, creator attribution, activity, and explorer links. |
| Market data | Real trades, correctly scaled prices, market cap, reserves, volume, wallet-level holders, and locally indexed OHLC. External chart indexing must not gate a new token's chart. |
| Fees | Fixed recipients, permissionless fee collection, individual claim accounting, claim history, and a usable fee dashboard. |
| Identity | Solana message-signature authentication for profiles and posts, chain-aware creator permissions, and existing moderation rules. |
| Operations | Durable indexer/backfill, error monitoring, recovery documentation, provider capacity, reproducible release, and EVM regression coverage. |

Keep the current Openlaunch visual system and layouts. Add chain-specific explanations where guarantees differ, not a second website or a visual remake. Reuse existing controls and status patterns; label preparation, awaiting signature, submitted, confirmed, finalized, expired, and recoverable failure distinctly.

Initial mainnet support is token/SOL only. USDC pairs, Solana bridging, bonding curves, multiple AMMs, arbitrary Token-2022 extensions, buybacks, and linked EVM/Solana identities are separate follow-ups. Solana actions remain outside points scoring until attribution and abuse rules have their own approved tests; disclose that exclusion instead of implying rewards.

## 3. Architecture

### Small original program, existing AMM

Use an original Rust program, with a pinned framework/toolchain selected during the feasibility stage. Its responsibilities are narrowly limited to:

1. Bind creator, mint, pool, position, launch terms, and fee recipients in a deterministic on-chain launch record.
2. Keep preparatory inventory under program control until launch finalization.
3. Verify mint, supply, pool configuration, full liquidity lock, and position-NFT custody before marking a launch active.
4. Hold position fee rights in a program-derived account with no transfer, approval, liquidity-removal, or arbitrary-call escape route.
5. Collect only fees and credit immutable recipient shares, with no platform destination.

Recommend one to seven unique recipients, matching the current EVM upper bound, with nonzero shares totaling 10,000 basis points. If transaction constraints require a smaller bound, revise the specification explicitly before implementation. Use deterministic integer accounting, retained dust, and independent claims so one recipient cannot block another. No changeable payout destination or whole-vault sweep.

Meteora's existing Dynamic Fee Sharing is a lower-code alternative, but it supports two to five recipient entries and shareholder-authorized integration funding. It does not directly preserve our single-beneficiary, permissionless-collection product. Do not create duplicate recipients to work around its minimum. [DFS design](https://docs.meteora.ag/helper-products/dynamic-fee-sharing/design-guide)

The original wrapper adds audit and deployment work. If fixed fee rights and on-chain registration are not requirements, a direct SDK integration could be smaller, but that is a different product contract and needs an explicit decision.

### Token and metadata

Prefer standard SPL Token initially. Choose and test supply/decimal bounds before exposing them; do not reuse ERC-20's 18-decimal assumptions. At activation, revoke mint authority and leave no freeze authority. Account for the complete minted supply: deposit it or burn documented rounding residue; never silently return residual launch inventory to the creator. Display final supply accurately after any burn.

Use a reviewed standard metadata implementation compatible with existing wallets. Record the initial content hash/URI and disclose metadata-update authority separately from mint authority. Keep editable social/profile information outside immutable financial terms. Metadata storage and availability need an explicit retention policy.

No transfer-tax, transfer-hook, permanent-delegate, default-frozen, or other unreviewed token extensions. A later Token-2022 decision must enumerate allowed extensions and prove pool, wallet, and indexer compatibility.

### Wallet and transaction boundary

Add a Solana-specific client adapter; do not force Solana signing through wagmi or viem. Initialize Wallet Standard in the browser, verify supported accounts/chains/features, and invalidate quotes and prepared transactions on account, network, amount, or route changes. No private-key input, browser-stored seed, or server-held user signer. [Wallet Standard guidance](https://docs.phantom.com/developer-powertools/wallet-standard)

Build and validate expected instructions locally. Pin program IDs, mints, destinations, amount bounds, and fee budgets. A quote or RPC response must not authorize arbitrary instructions. Verify the wallet-returned signed message against the reviewed transaction before broadcasting; reject unsupported mutations rather than assuming the wallet returned identical instructions. Simulate before signing, handle blockhash expiry, and reconcile unknown submission results before offering a fresh transaction. Never equate a returned signature with success.

Research baseline: `@meteora-ag/cp-amm-sdk@1.5.1`, upstream commit `79ebbfe59a225e641a2f37cd03404f26de1b0c8e`. Pin compatible Solana dependencies with a documented reason and lockfile review. The SDK is MIT; the DAMM program source has a separate noncommercial license. Use the supported deployed program interface, not a copied/redeployed AMM implementation. Confirm intended use and any copied code against their respective terms. [SDK](https://github.com/MeteoraAg/damm-v2-sdk/tree/79ebbfe59a225e641a2f37cd03404f26de1b0c8e), [program license](https://github.com/MeteoraAg/damm-v2/blob/main/license.md)

### Transaction boundaries and recovery

The SDK's custom-pool builder can append permanent locking to the pool-creation transaction. That does not establish that mint, metadata, pool, lock, fee custody, and registry fit together. Measure serialized size, signer count, compute, CPI depth, and account limits. Plan against the supported legacy/v0 1,232-byte packet budget; do not depend on newer formats without wallet and cluster verification. [SDK example](https://github.com/MeteoraAg/damm-v2-sdk/blob/79ebbfe59a225e641a2f37cd03404f26de1b0c8e/examples/createCustomizablePoolAndLockLiquidity.ts), [transaction limits](https://solana.com/docs/core/transactions)

If preparation requires multiple transactions, this remains mandatory:

```text
Prepare mint / metadata / escrow
               |
               v
Finalize atomically: pool + permanent lock + fixed fee custody + launch record
               |
               v
Verify confirmed state -> reconcile finalized state -> expose verified launch
```

Preparation must not release tradable inventory. Failure must not leave an unlocked live pool. Recovery is derived from on-chain launch state and public identifiers, not an ephemeral browser key. Specify retry and pre-activation cancellation/rent recovery without creating a post-activation withdrawal path. If the atomic finalization invariant cannot be met, stop and redesign rather than weaken it.

### Storage, indexing, and authentication

Existing storage and code assume lowercase EVM addresses, numeric chain/position IDs, ERC-20 transfers, Uniswap ticks, and EVM signatures. Add family-aware identities such as `{ family, network, address }`, preserve case-sensitive Solana base58 strings, and leave existing EVM keys and URLs stable.

Use additive Solana tables and normalized read models rather than rewriting EVM financial math. Store integers exactly, decimals explicitly, and unique events by network/signature/instruction path. A separate ingestion worker needs durable cursors, bounded retries, backfill, idempotency, failed-transaction filtering, and confirmed/finalized reconciliation.

Decode both outer and inner instructions. Attribute each launch pool's swaps at instruction level, including aggregator routes and multi-hop transactions executed outside Openlaunch; do not count route-level transfers again as pool volume. Verify account ownership and launch invariants independently of emitted logs. Aggregate holders by wallet rather than token-account count, distinguish pools/vaults from users, and reconcile balances after restart. Stale or unavailable USD conversion must appear unavailable, not as zero or an invented price.

Add a separate Ed25519 authentication path with domain, action, address, network, nonce, and expiry binding. Consume nonces once. Do not reuse EVM verification or lowercase middleware. Cross-wallet identity linking is deferred, not inferred from a shared browser session.

## 4. Delivery sequence

Use one feature branch and one coherent draft PR with reviewable commits and a checklist. Mainnet remains disabled until all release gates pass.

1. **Architecture acceptance and feasibility:** approve trust and fee differences; prove selected pool permissions, CPI compatibility, transaction bounds, token/metadata strategy, and fee custody. Produce threat model and measured fixtures before committing to the wrapper design.
2. **On-chain invariants:** implement the small original program and adversarial tests, launch-state recovery, fee accounting, reproducible builds, and deployment scripts that never submit by default.
3. **Wallet and execution:** build launch, buy, sell, claims, simulations, confirmation, and reload recovery through the real wallet adapter.
4. **Indexer and product coverage:** add migrations, ingestion, normalized data, token pages/charts, discovery, dashboard, and Solana authentication. Exercise the entire journey with real test-cluster data.
5. **Security and release:** independent review, full regression suite, operator runbook, and an explicitly authorized capped mainnet canary. Only then enable public mainnet creation.

No mainnet deployment, upgrade-authority revocation, funded test, or transaction signing is authorized by this plan alone. Deployment cost, review cost, and RPC capacity are approval items, not assumed budget.

## 5. Release gates

- Prove no extra minting, freezing, unlocked-liquidity escape, position transfer, recipient mutation, platform diversion, duplicate claim, or cross-launch fee theft.
- Test substituted/malformed accounts, wrong program owners, PDA seed collisions, duplicate recipients, integer overflow, rounding dust, closed accounts, donations, replay, and unauthorized CPI paths.
- Complete launch -> buy -> sell -> collect -> claim on local/test infrastructure, including maximum supported inputs, packet/compute measurements, slippage failures, rejected signatures, expired blockhashes, RPC disagreement, and reload at every stage.
- Rebuild the index from chain data and compare supply, reserves, trades, holders, and claims. Include direct swaps, aggregator CPI/multi-hop routes, multiple swaps in one transaction, and failed transactions; prove intermediate transfers do not inflate trade counts, users, or volume. Verify reorg/finality handling, restart safety, and incomplete-provider responses.
- Exercise desktop and mobile wallets; validate wallet switching, reconnect, insufficient funds, account rent, and priority-fee caps.
- Run repository lint, TypeScript, unit tests, production build, Solidity tests, and Base/Robinhood/Arc regression flows. Add dedicated Rust/Solana CI and migration replay tests.
- Review exact deployed Meteora versions and audit coverage. Independently review our program, transaction builders, and authentication; upstream audits do not cover this integration. [Meteora audit index](https://docs.meteora.ag/resources/audits/damm-v2)
- Publish our reproducible program build and deployment manifest; verify its mainnet binary/source match and exact authority state. Repeat the canary lifecycle against the final immutable production state before public creation. Immutable bugs require a new version for future launches, not upgrades to existing custody.
- Monitor upstream ProgramData/deployment, authority, and relevant pool/config changes. Unexpected changes must disable new in-app submissions and invalidate locally prepared unsigned transactions until independently reviewed. This cannot revoke previously signed transactions or pause the external protocol. Keep read access and recovery information available; expose claims only when their execution path remains verified.
- Document monitoring for indexer lag, quote failures, confirmation backlog, and accounting discrepancies. Establish funded operating capacity and ownership.
- Rehearse rollback: disable new submissions in the frontend without pretending to pause the chain; keep existing positions, claims, explorer links, and recovery usable. A locked launch cannot be unwound by a UI rollback.

## Approval checklist

- [ ] Accept Meteora's external upgrade/administrative trust boundary and chain-specific disclosures.
- [ ] Approve token/SOL first, zero Openlaunch cut, explicit protocol fees, no SOL-fee burn mode, and no initial points eligibility.
- [ ] Approve the original minimal registry/fee-custody program, subject to the atomic-finalization feasibility gate.
- [ ] Resolve token decimals/supply/range bounds, metadata authority/storage policy, and supported wallet matrix during the specification stage.
- [ ] Assign independent security review, deployment authority handling, RPC/indexer ownership, and canary budget before mainnet release.

Application code is unchanged at this planning checkpoint. No launch simulation, mainnet transaction, deployment, or security audit is claimed complete.
