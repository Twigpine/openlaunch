# Solana launch pool security model

This implementation is unaudited and not approved for mainnet funds. Follow the repository's private vulnerability reporting policy in [SECURITY.md](../SECURITY.md). Do not disclose an exploitable vulnerability in a public PR comment.

## Trust and custody

The original program holds token inventory and native SOL in per-pool PDAs. There is no external AMM, owner/admin instruction, LP withdrawal, pause, upgrade switch, migration, rescue, arbitrary CPI, or active-account close. All economic terms are fixed in preparation. Activation requires the exact executable's linked ProgramData to have no upgrade authority. Once active, an immutable defect cannot be patched and the website cannot pause direct users.

The legacy SPL Token Program is the only token CPI target. Anchor's initialization macros require token-2022 helper code to compile, but instruction accounts are constrained to `Program<Token>` and legacy `Mint`/`TokenAccount`, so Token-2022 mints/extensions/hooks are not accepted. No Metaplex or other metadata CPI is used. The custom on-chain name/symbol/URI do not guarantee wallet metadata recognition or hosted-media availability.

## Protected invariants

- Supply is exactly 1 billion tokens at 6 decimals on activation, all in the vault. Mint authority is atomically revoked and freeze authority is absent. Later holder burns are allowed.
- Accounted token inventory X remains within `(0, S]`; real SOL R excludes rent and fees; `X*(R+V) >= S*V`. V is virtual pricing only, never collateral or available liquidity.
- Buy input is split into real reserves and fixed fees. Sell output plus fee is capped by real reserve solvency, not virtual balances. Slippage and slot expiry are enforced on-chain.
- Actual vault balances must cover accounted obligations. Surplus donations neither affect price nor become claimable; they remain inaccessible because no recovery path exists.
- Cumulative fee entitlements use u128 counters and overflow-safe proportional math. A claim can only pay the exact fixed recipient from the fee vault. No signature is needed to pay someone their own entitlement. Rent is protected and duplicate/aliased protocol recipients are rejected.
- Cancelled preparation is a permanent tombstone, not a reusable nonce. Preparation has no auxiliary accounts, so cancelled preparation rent is not refunded.

## Threats and limitations

Review rounding manipulation, dust/near-empty inventory, maximum integer bounds, fee-claim ordering, malicious seed/account substitution, CPI privilege leakage, prefunded-PDA griefing, transaction atomicity, reinitialization, fabricated program data, external SPL transfers/burns, and failed or duplicated transaction ingestion. Host emulation is not a substitute for validator behavior.

Economic safety is not guaranteed by immutability. A token starts with zero real SOL liquidity. Price/FDV based on V is not an exit-value guarantee. Slippage, sandwich/MEV ordering, declining demand, locked dust, creator-recipient trading incentives and arbitrary starting valuations require economic review and clear UI disclosure. The initial V bounds are mechanical, not investment guidance or endorsed fair valuations.

Fee recipients are immutable. A recipient unable to receive a lamport transfer (for example runtime rent restrictions or incompatible account state) can lose access to its fees; others must remain able to claim independently. The protocol cannot rewrite destinations to repair mistakes. Applications should simulate and explain recipient compatibility, without claiming that present simulation proves future account availability.

RPC/indexer/UI may be unavailable or malicious. Users must verify program ID, token mint, transaction bytes, recipients and minimum output. Publish a read/quote/build recovery SDK, preserve signatures until resolved and never silently rebuild a possibly-submitted transaction. Verify successful transaction origin, not only log text. Holders require full token-transfer coverage, not swap-event inference.

## Release gates

1. Freeze specification and mechanically bounded parameters; independent economic and security reviews of the exact commit, with findings resolved and retested.
2. Reproducible modern SBF build, independent bytecode match and full validator/SBF acceptance matrix in [BUILD.md](BUILD.md), including maximum transaction/compute/stack measurements.
3. Real wallet desktop/mobile tests, recipient compatibility, failure/reload recovery, durable indexer/finalization and EVM regression tests.
4. Kevin's separately authorized deployment; verify executable/ProgramData linkage and binary. Authority revocation is irreversible and must be explicitly approved and independently verified. No automatic deployment or revocation is provided.
5. Separately approved mainnet test budget and successful round trip/claims/index reconstruction before production UI enablement. The canary is a test budget, not an on-chain permission or TVL cap: once immutable, anyone can activate pools directly.

No audit or deployment gate is cleared by merging this PR. A frontend rollback cannot recover compromised immutable funds.
