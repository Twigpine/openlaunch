# Independent Solana pool model

This is a dependency-free specification oracle and reproducible regression suite, not a production quote library or a security audit.

Run from this directory with Node 22:

```sh
npm test
npm run test:sdk
```

The first command uses only Node built-ins. The SDK differential command uses Node's TypeScript stripping to load the production SDK's pure math module; it does not require a wallet, RPC, private key, network request, or an on-chain deployment.

## Independence

The oracle deliberately does not import or copy the program/SDK's closed-form trade quotients. It binary-searches the largest output preserving the **previous** constant product. The sell search extends through the effective reserve `R + V`, not just real reserves `R`, then independently asserts that the result cannot spend virtual SOL. Clipping the search to `R` would hide a broken solvency model.

Fees are the smallest integer meeting the fee inequality. Beneficiary entitlements use an unbounded integer search, so tests exercise lifetime values that would overflow a naive `u128 * weight` implementation. The production implementation instead uses checked quotient/remainder decomposition.

The shared JSON golden vectors encode every amount as a decimal string. Do not regenerate them from production math when a regression appears; investigate the disagreement.

## Checked properties

- 90,000 deterministic accepted mixed trades across all three fee tiers and minimum, middle and maximum virtual offsets. The test asserts substantial coverage of both trade directions, avoiding pseudo-random low-bit selection bias.
- Conservation of token supply and actual SOL balances, separate rent floors, real reserves, fee obligations and unsolicited donations.
- Transfers between holders, token burns, token/SOL/fee-vault donations, repeated fee claims, and independent recipient payouts.
- Nondecreasing constant product and maximal integer output on every accepted trade.
- 3,600 isolated round trips, covering buy/sell and sell/buy, cannot create trader value before external incentives.
- Tiny-input fee ceilings, zero outputs, slippage, malformed states, near-empty inventory, `u64` reserve bounds and `u128` cumulative fees.
- 108,000 differential state transitions against the production TypeScript SDK, plus fee and rejection boundary comparisons.

## What these tests do not establish

These are mathematical and balance-sheet tests. They do not execute Solana instructions or prove account ownership, signer validation, CPI safety, PDA initialization under prefunding, expiry enforcement, runtime rent behavior, activation atomicity, deployment immutability, packet/compute limits, wallet compatibility or indexing correctness. Those require separate program/runtime, SDK and integration tests.

Passing this suite does not approve the virtual-offset valuation policy, establish market demand, make virtual SOL withdrawable, guarantee buyer returns, complete an independent audit, or authorize mainnet deployment.
