# Openlaunch Solana SDK

Original TypeScript client for the unreleased immutable launch-pool program. This package is not an audited protocol and includes no production program ID. The compile/test fixture ID must never be used as a deployment configuration.

Kept inside `app/packages` so the existing app-only Docker build context contains the local package. Import `@openlaunch/solana-sdk` from the app. Source exports require a TypeScript-aware bundler or `tsx`; Next supports this without a separate generated client. Public keys remain case-sensitive base58. Amounts are `bigint` in token atoms or SOL lamports, never JavaScript floating-point amounts.

## Dependencies

- `@solana/web3.js` 1.99.0: pinned class-based transaction/account API shared with the app wallet integration. The v1 line is maintenance-only; a future major upgrade requires rerunning wallet message and serialization tests, not an unreviewed range bump.
- `@noble/hashes` 1.8.0: browser-compatible SHA-256 for Anchor discriminators and reviewed ELF verification. No private-key handling.
- `buffer` 6.0.3: explicit browser-compatible binary encoding instead of relying on a global Node `Buffer`.

The SDK does not depend on Anchor's JavaScript client, a DEX SDK, SPL Token metadata services, server signing, or an external quote service.

## Public API

| API | Result / contract |
| --- | --- |
| `derivePoolAddresses(programId, creator, nonce)` | Canonical pool, mint, token vault, SOL reserve, fee vault and temporary mint-authority PDAs; `nonce` is u64 bigint. |
| `deriveAssociatedTokenAddress(mint, owner)` | Legacy SPL associated token account, including supported off-curve owners. |
| `decodePoolAccount(address, accountInfo, programId)` | Checked `PoolAccount`; requires owner, discriminator, ABI version, canonical PDAs and immutable terms. |
| `fetchPoolSnapshot(connection, programId, address)` | `{ address, addresses, pool, slot }`; account and custody checks use one confirmed-bank batch. Accepts donated surplus; refuses unsafe numeric RPC balances. |
| `verifyImmutableProgram(connection, programId)` | Finalized linked Program/ProgramData check; rejects retained upgrade authority or wrong loader. |
| `quoteBuy(state, grossLamports, minOutput = 1n)` | Exact SOL-in buy, fee rounded up and token output rounded down. |
| `quoteSell(state, tokenAtoms, minOutput = 1n)` | Exact token-in sell; rejects any attempt to spend virtual SOL. |
| `feeEntitlement(earned, weightBps)` / `claimableFees(earned, weightBps, paid)` | Checked lifetime u128 accounting without multiplication overflow. |
| `minimumAfterSlippage(output, bps)` | Conservative minimum; refuses zero or 100% slippage. |
| `parseAmount(text, decimals)` / `formatAmount(value, decimals)` | Exact human amount handling; rejects exponents, signs and excessive fractional digits. |

`PoolAccount` contains `status: "prepared" | "active" | "cancelled"`, `creator`, `rentPayer`, `mint`, `nonce`, `virtualSol`, `feeBps`, `recipients`, `tokenInventory`, `realSolReserves`, `feesEarned`, `sequence`, `name`, `symbol`, `uri`, and `contentHash`. Every recipient contains `{ address: PublicKey, weightBps: number, paid: bigint }`. Empty URI is valid; metadata lives in our program, not an automatically recognized wallet metadata mirror.

`CurveState` needs `{ tokenInventory, realSolReserves, virtualSol, feeBps }`. Both quote functions return `{ grossInput, netInput, fee, amountOut, nextTokenInventory, nextRealSolReserves }`. On sells, `grossInput` and `netInput` are token atoms; `fee` and `amountOut` are lamports. Virtual offset is not reserve liquidity or collateral. The technical 1 through 1,000,000 SOL offset bounds are not endorsed valuations and remain subject to economic review.

### Instruction builders

All builders return a `TransactionInstruction`, never send or sign it.

- `buildPrepareLaunchInstruction(programId, { creator, payer?, nonce, virtualSol, feeBps, name, symbol, uri, contentHash, recipients })` binds immutable configuration. `contentHash` is exactly 32 bytes. `recipients` is an array of `{ address, weightBps }`, empty for 0% fees.
- `buildActivateLaunchInstruction(programId, creator, nonce)` activates only after the program's own upgrade authority is absent. The creator pays activation rent.
- `buildCancelPreparationInstruction(programId, creator, nonce)` makes preparation terminal. The retained tombstone is not a refundable account.
- `buildBuyInstruction(programId, tradeArgs)` / `buildSellInstruction(programId, tradeArgs)` use `{ creator, nonce, trader, traderToken?, amountIn, minimumOut, expirySlot }`. Omitting `traderToken` selects the canonical ATA; it still needs to exist.
- `buildCreateAssociatedTokenInstruction(payer, mint, owner)` may be prepended to a buy, using the official idempotent ATA instruction. Rent is extra, not deducted from the quote.
- `buildClaimFeesInstruction(programId, pool, recipientIndex)` pays the immutable recipient only. Any wallet may pay transaction fees to trigger a claim; it cannot redirect the payment.

See [`solana/ABI.md`](../../../solana/ABI.md) for exact account order and instruction layouts. Name/symbol/URI sizes count UTF-8 bytes. Slippage and expiry are enforced again on-chain; a client quote is not an execution guarantee.

### Signing and ambiguous-submission recovery

```ts
const prepared = await prepareTransaction(connection, walletPublicKey, instructions);
await simulatePreparedTransaction(connection, prepared);

// Request wallet-standard signing of prepared.wireBytes, using the current account/cluster.
const signed = validateSignedTransaction(prepared.messageBytes, walletSignedBytes, walletPublicKey);
// Persist signed.signature, prepared.blockhash and prepared.lastValidBlockHeight BEFORE submission.
const submitted = await submitSignedTransaction(connection, signed);
const result = await reconcileTransaction(connection, signed.signature, prepared.lastValidBlockHeight);
```

The app must check the selected wallet account/cluster again after the wallet prompt. Returned transaction messages must be byte-identical to the reviewed message and all required signatures valid. The SDK intentionally supports legacy transactions only in this first integration. SDK preparation/simulation contains no user signer.

Submission errors return `unknown`, retaining the locally derived signature. Do not create a replacement transaction after a timeout. Reconciliation reads finalized block height and historical signature status. A processed/confirmed failure remains `pending` because it could exist only on a fork. Only finalized failure or expiry with no observed signature is terminal. Reliable archival RPC history is part of the operational assumptions; compare another trusted endpoint for unresolved anomalies. Never silently clear recovery state just because the UI was closed.

## Read-only deployment evidence

From `app/`, set `SOLANA_VERIFY_RPC_URL` privately, then run:

```text
npx tsx packages/solana-sdk/scripts/verify-manifest.ts <reviewed-manifest.json> <reviewed-program.so>
```

The manifest requires `schema: 1`, `cluster` (`devnet` or `mainnet-beta`), `programId`, canonical `programData`, an independently verified `genesisHash`, exact 40-character `sourceCommit`, 64-character `binarySha256`, nullable `verifiedSlot`, nullable `securityReview` / `economicReview`, and `releaseApproved` boolean.

The checker compares RPC genesis, reads both this program and the legacy Token Program at one finalized context, checks their actual linked ProgramData and absent upgrade authorities, hashes the reviewed local ELF, and compares every deployed byte with it (only zero allocation padding is tolerated). It prints proof observations to stdout and **never** changes the manifest, grants approval, deploys, sends transactions or changes authority. Error output excludes RPC URLs, provider errors, local file paths and environment values.

Retain its output with a reproducible source-to-ELF build attestation and a second independently trusted RPC check. Matching an ELF supplied by the caller does not prove that ELF came from the reviewed source, that the RPC is honest, that the program is secure, or that an audit is complete. `releaseApproved` in evidence is always false. Human release approval remains a separate reviewed action.

## Verification

From `app/`:

```text
npx tsc --noEmit -p packages/solana-sdk/tsconfig.json
npx tsx --test packages/solana-sdk/tests/*.test.ts
```

Tests cover golden values shared with Rust, independent binary-search oracle comparisons, u64/u128 limits, fee rounding, slippage, decoder/PDA substitution, donated surplus, immutable ProgramData linkage, wallet message mutation, partial/invalid signatures, ambiguous submission and packet measurements. `tests/abi-fixture.json` contains only deterministic public fixture identities and serialized ABI bytes, no private key or deployable configuration. `scripts/print-abi-fixture.ts` reproduces it for intentional ABI changes.

Measured unsigned legacy packet sizes with one signer: maximum-length seven-recipient preparation 792 bytes, activation 509 bytes, buy with idempotent ATA creation 508 bytes. Preparation and activation are separate transactions. These checks do not measure runtime compute, rent, wallet compatibility or real-validator lifecycle behavior; those remain separate release gates.
