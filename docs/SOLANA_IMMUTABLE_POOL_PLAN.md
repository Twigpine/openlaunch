# Immutable Solana launch pools

Status: specification with an implemented review candidate. Not audited, deployed, or approved for mainnet. See [implementation and release handoff](SOLANA_RELEASE.md).

Date: 10 October 2026. Repository baseline: `ef8b642b258ec6dd385335fb24ef00a923c72b62`.

Supersedes [the Meteora integration proposal](SOLANA_MAINNET_PLAN.md). The chosen direction is an original, narrowly scoped pool program rather than a wrapper around an upgradeable DEX. This is protocol development and requires independent economic and security review.

## 1. Product contract

A creator launches a fresh token directly into a token/SOL market. All initial supply enters the pool. Buyers bring real SOL; the creator does not seed quote liquidity. Trading starts immediately after successful activation, without graduation or migration.

Recommended first-release defaults, subject to specification approval:

| Item | Proposed v1 rule |
| --- | --- |
| Launch token | Fresh legacy SPL mint created by this program; no existing-token imports |
| Supply | 1 billion tokens, 6 decimals; `1_000_000_000_000_000` token atoms |
| Quote | Native SOL, accounted in lamports |
| Initial price | Creator selects a bounded starting valuation in SOL; its virtual-reserve parameter is fixed forever |
| Openlaunch cut | Zero launch, platform, referral, and protocol fees |
| Trading fee | Creator chooses 0%, 1%, or 3%, fixed at activation |
| Fee destination | For nonzero fees, 1 to 7 unique fixed recipients; shares sum to 10,000 basis points |
| Fee collection | Accrues separately in SOL; anyone may trigger payment to the fixed recipient |
| Liquidity | No LP token and no liquidity-withdrawal instruction |
| Mint controls | No freeze authority; mint authority revoked at activation |
| Upgrade/admin controls | No active-pool administrative powers; deployed program immutable before activation |

No SOL-fee burn mode. Zero-fee launches need no beneficiaries. For nonzero fees, every accrued trading-fee lamport belongs to beneficiary entitlements or bounded rounding residue, not Openlaunch. Network fees, priority fees, account rent, and storage costs remain separate costs paid by the creator/trader.

Keep Base, Robinhood, and Arc execution unchanged and retain the current UI. This is a new execution backend, not a site redesign.

## 2. Precisely define the guarantee

The target is **no application-controlled administrative path over active pool funds or trading terms**:

- No owner, treasury switch, pause/unpause, fee setter, recipient setter, whitelist, or operator role.
- No reserve withdrawal, rescue/sweep, migration, arbitrary CPI, active-account close, shrinking realloc, or authority/delegate escape route.
- No upgrade authority after release. New code versions use new program IDs for future launches; they cannot rewrite existing pools.
- Ordinary trades exchange reserves according to fixed rules. Locked liquidity does not mean tokens can never leave the vault.

This does not promise profit, a redemption floor, exploit immunity, availability of the website/RPC, or immunity from Solana runtime/consensus changes. An immutable bug cannot be patched in place. Disabling our frontend cannot stop direct on-chain trading or an exploit.

Use native SOL and the original SPL Token Program to avoid an external AMM in the custody path. A read-only mainnet check on 10 October at finalized slot `455205523` found the legacy Token Program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` had no upgrade authority. ProgramData was `3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2`, deployment slot `419472000`. Verify again before release; loader ownership alone is insufficient to determine upgradeability. [Token documentation](https://solana.com/docs/tokens)

## 3. Pricing model and solvency

Use an offset constant-product model, a known single-sided-sale construction. SPL Token Swap documents this model, but its archived implementation is a reference, not an inherited audit or a ready-made fee/locking system. Any reused code requires commit-pinned license and provenance review. [Offset-curve reference](https://github.com/solana-labs/solana-program-library/blob/master/docs/src/token-swap.md#offset), [Apache-2.0 license](https://github.com/solana-labs/solana-program-library/blob/master/LICENSE)

All calculations use checked integers. Define:

- `S`: original supply in token atoms.
- `X`: accounted token inventory in the pool.
- `R`: accounted real SOL reserve, excluding fees and rent.
- `V > 0`: immutable virtual SOL offset, in lamports.
- `f`: selected fee basis points; `B = 10_000`.

Initialize `X = S`, `R = 0`. Preserve:

```text
0 < X <= S
R >= 0
X * (R + V) >= S * V
```

`V` is not a deposit, collateral, TVL, or spendable balance. At launch, spot-price FDV in SOL equals `V / 1_000_000_000`, while real SOL reserves are zero. The UI must display these as different facts. Starting valuation presets and bounds require economic review; no USD oracle controls the curve.

### Exact-input buy

For gross SOL input `g`:

```text
fee       = ceil(g * f / B)
net       = g - fee
tokensOut = floor(X * net / (R + V + net))

require net > 0
require 0 < tokensOut < X
require tokensOut >= minTokensOut

X' = X - tokensOut
R' = R + net
```

The reserve receives `net`; the fee vault receives `fee`. Account creation and transaction fees are not secretly subtracted from the quoted trade amount.

### Exact-input sell

For input `t` token atoms:

```text
require 0 < t <= S - X

gross  = floor((R + V) * t / (X + t))
fee    = ceil(gross * f / B)
solOut = gross - fee

require gross <= R
require solOut > 0
require solOut >= minLamportsOut

X' = X + t
R' = R - gross
```

The real reserve pays both `solOut` and `fee`; the fee portion moves to the separate fee vault. Both directions enforce an on-chain expiry slot as well as minimum output.

Why virtual SOL cannot be paid out: the invariant gives `R*X >= V*(S-X)`. A valid sell has `t <= S-X`, so `V*t <= R*X`, which implies `(R+V)*t/(X+t) <= R`. Conservative rounding preserves this bound. Keep the explicit real-reserve check anyway; never hide insolvency by capping a quote to available funds.

Require token amounts, `R+V`, and post-buy `R+V+net` to fit documented `u64` bounds so two-factor products fit `u128`. Use overflow-safe ceiling division. Lifetime cumulative fees and paid counters use separately bounded `u128` accounting, not the `u64` reserve limit; entitlement multiplication needs overflow-safe decomposition or a reviewed wider intermediate. No floating-point prices in the program or quote builder.

For illustration only, with 1 billion tokens, `V = 30 SOL`, and a 1% fee: a 1 SOL buy receives `31,945,788.964181` tokens. Immediately selling those tokens back, without other trades, returns `0.980099999 SOL`, excluding network costs. One lamport remains in real reserves through rounding. The virtual 30 SOL was never withdrawable. This is not a proposed default valuation or a return forecast.

The final token atom cannot be bought at finite input. Full round-trip reversal can leave permanently locked rounding dust. Profitable trades after market movements remain possible; only isolated round trips should be non-profitable before external incentives.

## 4. Separate custody and fee accounting

```text
Pool state: immutable terms + accounted reserves + cumulative fee ledger
  |-- Token vault: launch inventory, exact SPL mint, pool PDA authority
  |-- SOL reserve vault: real trading reserves + protected rent
  `-- SOL fee vault: beneficiary obligations + protected rent
```

Each launch has independent PDA-derived accounts. No global fund vault or global writable configuration. Program-derived addresses remove private-key custody, but correctness still depends on the instructions permitted to sign for them. [PDA documentation](https://solana.com/docs/core/pda)

For cumulative earned fees `F`, recipient weight `w_i`, and cumulative paid amount `paid_i`:

```text
entitlement_i = floor(F * w_i / 10_000)
claimable_i   = entitlement_i - paid_i
```

Claims pay only the recipient stored in immutable pool state, never a caller-selected destination. No recipient signature is needed merely to send its earned SOL to that exact address. Reject default, duplicate, or otherwise invalid recipients; validate account compatibility without excluding supported smart-wallet PDAs merely for being off-curve. Individual claims must not depend on other recipients, change `X` or `R`, or touch the reserve vault. Use overflow-safe multiply/divide for the mathematical entitlement formula. Cumulative accounting avoids rounding loss growing with trade count; unallocated residue after all claims is below the recipient count in lamports.

Use accounted balances, not raw vault balances, for prices and claims:

```text
actual token balance >= X
actual SOL reserve balance >= protected rent + R
actual fee vault balance >= protected rent + F - totalPaid
```

Anyone can send unsolicited assets. Donations must not change prices, virtual reserves, or fee entitlements, and must not brick the pool through equality checks. Donated surplus stays inaccessible in v1: no discretionary recovery instruction. Reject recipient aliases with protocol-owned accounts and duplicate mutable accounts. Reserve and fee movements must satisfy conservation even when a recipient is the creator or trader.

## 5. Minimal instruction surface and launch lifecycle

Proposed instructions:

| Instruction | Authority and effect |
| --- | --- |
| `prepare_launch` | Creator signs; binds nonce, terms, metadata commitment, recipients, and original rent payer. No tradable inventory. |
| `activate_launch` | Creator signs; validates preparation and immutability, creates/funds token inventory, revokes mint authority, and atomically marks Active. |
| `cancel_preparation` | Original creator only, never after activation; closes only eligible empty preparation accounts and returns permitted rent to its recorded payer. |
| `buy_exact_in` | Trader-authorized input; audited quote, minimum output, expiry, reserve and fee updates. |
| `sell_exact_in` | Trader-authorized token input; same controls and explicit real-reserve solvency. |
| `claim_fees` | Permissionless trigger; payout only to a fixed recipient from the fee vault. |

```text
Uninitialized -> Prepared -> Active (permanent)
                     `----> Cancelled (terminal)
```

Prefer preparing configuration only, then creating the mint and token vault during activation. All supply must be minted to the vault and mint authority revoked in the same successful activation. No freeze authority from initialization; no creator allocation or token delegate. Emit an activation event only after verifying postconditions.

Measure packet size and compute for the actual maximum-input transaction, including any metadata instructions. Standard legacy/v0 transactions have a 1,232-byte packet budget; do not promise everything fits one transaction. [Transaction limits](https://solana.com/docs/core/transactions)

If account creation must be staged, a prepared mint must have zero supply and only a launch-scoped mint-authority PDA as mint authority. Failed or abandoned preparation cannot create a trading market. Retain a small permanent Cancelled tombstone so closing auxiliary accounts cannot permit nonce reuse; only eligible auxiliary rent can be refunded. Legacy mint rent and tombstone rent may be unrecoverable on cancellation; disclose this rather than promising a full refund. Prevent reinitialization, cancellation/activation races, and prefunded-PDA denial of service. Do not rely on an ephemeral browser key for recovery.

### Immutability before activation

`activate_launch` must reject while this program retains an upgrade authority. Verify the executable account equals this program ID, the expected loader, its recorded ProgramData address, ProgramData ownership/layout, and an absent authority. An unrelated immutable ProgramData account must not satisfy the check.

Use disposable immutable program IDs for devnet lifecycle tests. Production sequence: review exact source, build reproducibly, deploy, verify binary/source match, revoke upgrade authority, independently verify revocation, then permit activation. Revocation itself requires explicit deployment approval. [Deployment rules](https://solana.com/docs/core/programs/program-deployment), [verifiable builds](https://www.anchor-lang.com/docs/references/verifiable-builds)

### Metadata is separate from money

Store canonical bounded name, symbol, URI/content hash in our immutable state. Images need a durable hosting policy; a content hash does not guarantee availability. Editable profile/social content remains off-chain and cannot change pool terms.

A standard wallet-readable metadata mirror is a compatibility feature to prove during feasibility, not an authority over custody. If a Metaplex mirror is used, isolate setup before initial supply minting using a distinct temporary mint-authority PDA and bounded setup funding, not reserve/fee authority or unrestricted payer signing powers. Recheck zero supply, mint/freeze authorities and vault owner/delegate/close-authority state after that CPI, then mint and revoke atomically. No external metadata CPI during swaps or claims. Finalize intended display mutability; trading and claims cannot depend on metadata service availability. If this isolation cannot be proven, omit the mirror rather than weaken custody. Do not promise every wallet recognizes our custom metadata automatically.

## 6. Complete mainnet app integration

The mainnet release must include launch, native buy/sell, fee claims, discovery, token pages, watchlists, wallet balances, creator profiles/posts, and transaction recovery. No demo-only success states or hardcoded production data.

- **Wallets:** Wallet Standard discovery and signing, verified supported account/cluster/features, desktop/mobile matrix, account-change invalidation, simulation, fees/rent review, and validation of wallet-returned signed messages. No private-key input or server user signer.
- **SDK:** Deterministic PDA derivation, account decoding, exact integer quotes, typed instruction builders and public integration documentation. Program, SDK and independently written reference model must agree. Unknown submission results must be reconciled before any retry with a new transaction.
- **Storage/auth:** Family-aware identities and case-sensitive base58. Keep existing EVM keys/URLs stable. Add separate Ed25519 auth with domain, action, network, address, nonce and expiry binding; do not reuse EVM lowercase/signature middleware.
- **Indexer:** Durable slot/signature/instruction cursors, idempotent backfill, failed-transaction filtering, inner-CPI attribution, per-pool sequence verification and confirmed/finalized reconciliation. Verify event origin, not just its text.
- **Charts:** First-party candles from real successful swaps. Define pricing/volume consistently from the curve-traded quote amount, separately recording fees and gross wallet amounts. Show no-trades/stale states; do not fabricate history from starting valuation. Display actual SOL reserves, virtual offset and FDV separately.
- **Holders:** Ingest ordinary SPL transfers outside our program and reconcile token accounts by wallet. A swap-only indexer is insufficient. Withhold metrics whose coverage is not proven.
- **Availability:** Publish a minimal SDK/CLI recovery path for trading and claims without our hosted UI. Frontend flags control our interface, not on-chain access.

Jupiter routing, wallet swap support, GeckoTerminal and DEX Screener listings are separate integration/adoption work. A new program does not inherit these through deployment. External chart coverage must not be a release dependency.

Out of scope for v1: USDC pairs, bridged assets, existing-token imports, Token-2022 extensions, LP deposits, liquidity migration, graduation, anti-sniper taxes, dynamic fees, buybacks, price oracles in the swap path, cross-wallet identity linking, Solana bridge routes, and points rewards without a separate scoring review.

## 7. Implementation boundaries and milestones

Proposed boundaries, not directories to create before they are needed:

```text
solana/programs/launch_pool/  Original Rust program
solana/tests/                Models, adversarial tests, lifecycle fixtures
solana/deployments/          Build hashes, program IDs, authority evidence
packages/solana-sdk/         Decoders, integer quotes, builders, generated types
app/src/lib/solana/          Wallet, execution, data adapter, indexer, auth
app/db/                     Additive migrations; EVM storage unchanged
```

Prefer a pinned Rust/Anchor toolchain for explicit account constraints and reproducible builds, subject to feasibility and reviewer support. Do not add a generalized multi-chain framework or fork an entire DEX UI.

1. **Specification and independent model:** freeze economics, account map, bounds, state machine, cost assumptions and threat model. Independently review the solvency proof and compare reference implementations. Exit before UI polish: every movement of SOL and tokens is explainable and conserved.
2. **Program and SDK:** implement the minimal surface, property/differential/adversarial tests, measured transaction limits, and immutable disposable test deployments. No mainnet activation.
3. **Complete testnet product:** connect real wallets, indexing, charts, discovery, profiles, trading and claims. Demonstrate rejection, reload, RPC outage, stale quotes and insufficient funds without duplicate transactions.
4. **Independent audit and release rehearsal:** audit the exact program and economic model, fix findings, repeat regression/fuzz tests, verify builds and dependency authorities, rehearse immutable release and incident response.
5. **Explicitly authorized mainnet canary:** use a separately approved limited test budget on the final immutable deployment. Verify launch, buy, sell, claim and indexer recovery before enabling creation in our production UI.

Once the immutable permissionless deployment exists, others can activate pools directly. The canary budget caps only our testing, not protocol TVL or public on-chain access. Do not add an admin allowlist or activation switch to imply otherwise; independent review must precede that deployment.

Use one coherent draft feature PR with staged, reviewable commits and an honest checklist. Testnet code may be reviewed before an audit, but must not be presented as mainnet-ready. Production activation remains blocked by the release gates, not by a promise to fix things later.

## 8. Required acceptance tests

- Randomized buys/sells/claims preserve token conservation, real-reserve solvency, nondecreasing product, and fee liabilities.
- Isolated buy/sell and sell/buy round trips cannot create value; repeated tiny trades and extreme boundaries cannot extract rounding value.
- Selling all circulating tokens never spends virtual reserves or fee funds. User burns and donations do not invalidate accounting.
- Maximum inputs, fee ceilings, zero-output trades, minimum output, expiry, near-empty inventory and lifetime counter bounds behave identically in program and SDK.
- Claims are solvent and order-independent, repeated claims cannot overpay, and one unusable recipient cannot block others.
- Wrong owners/program IDs, account substitution, PDA bump/seed collisions, aliases, unexpected delegates/close authorities, prefunding and replay cannot bypass controls.
- Activation atomically mints the full supply, removes mint authority, verifies custody and becomes irreversible. Cancellation cannot release active funds or resurrect a cancelled launch.
- Wrong ProgramData, retained upgrade authority, active account closure/reallocation, arbitrary CPI and extra mint/freeze attempts fail.
- Index rebuild matches on-chain reserves, fee entitlements, trades and holders, including ordinary transfers, failed transactions, multiple swaps and inner CPIs.
- Desktop/mobile wallet recovery passes; EVM tests, lint, TypeScript, production build and Base/Robinhood/Arc regressions remain green.

The initial planning sanity check has been replaced by persisted regression suites: an independent BigInt model, SDK differential tests, Rust host tests, and compiled-SBF offline VM execution. Their coverage and limitations are recorded in [the build handoff](../solana/BUILD.md) and [release checklist](SOLANA_RELEASE.md). Passing automated checks is not an exhaustive proof or independent audit.

## 9. Decisions and release evidence still required

- Approve fixed 1-billion supply/6 decimals, fixed fee choices, token/SOL-only scope and no SOL-fee burn mode.
- Select initial valuation bounds/presets through economic review; publish realistic examples of slippage and available exit liquidity.
- Set metadata/hosting policy, wallet compatibility targets, and maximum name/URI sizes before packet measurements.
- Assign independent protocol/economic review, deployment custody/revocation procedure, RPC/indexer operations, audit costs and canary budget.
- Produce a public commit/build/program manifest, exact deployed-bytecode match, absent upgrade-authority evidence, revoked mint/freeze proofs, test reports and closed audit findings.
- Rehearse incident response without an on-chain pause or rescue. A frontend rollback cannot recover funds from flawed immutable code; publish notices and preserve verified recovery interfaces.

The review candidate now includes the original pool program, SDK, independent model, isolated app workspace, read-only release verifier and CI. No program has been deployed, no on-chain authority has been revoked, and no funded wallet transaction has been performed. Public launch remains blocked until the release checklist is satisfied.
