# Earn on idle USDC

A card on the **/me** dashboard lets a wallet put its own USDC into one reviewed lending vault on Base and take it out again. The vault is **Steakhouse Prime USDC**, a Morpho Vault V2 run by Steakhouse Financial (`0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9`). Funds go from the wallet straight into the vault and back. Openlaunch adds no contract, holds no key, takes no fee and never has custody.

The feature is **off unless the runtime secret `EARN=on` is set**. Off, `GET /api/earn` answers `{ "enabled": false }` and the card and the ⌘K entry do not appear. `fly secrets set EARN=on` turns it on (the app restarts, no rebuild); unsetting it or any other value is the kill switch. The browser does not remember the answer: open tabs pick up a switch-off on their next /me visit or ⌘K open, without a reload (a /me page left open keeps its card until then). It cannot stop anyone using the vault directly; it removes openlaunch's door to it.

## How it works

- **Vault registry** (`app/src/lib/earn/vaults.ts`): one vault per chain at most, `null` on Robinhood Chain and Arc so a chain never inherits Base's vault. Each entry pins the address, the asset (Circle's Base USDC), the decimals and the terms as reviewed.
- **Calls** (`app/src/lib/earn/calls.ts`): plain ERC-4626 on the vault. `deposit(assets, wallet)`, `withdraw(assets, wallet, wallet)` for part, `redeem(allShares, wallet, wallet)` for everything (so no dust share is left). The approval is `approve(vault, exactAmount)` on USDC. No SDK, no router, no bundler.
- **Reads**: the wallet's USDC, allowance, shares and what they redeem for are read in the browser through the same-origin `/api/rpc` proxy. The vault's public figures (rate, size, fees, terms) come from `GET /api/earn`, which reads the chain on the server, once per 10 minutes. No third-party API: the CSP and `SECURITY.md` are unchanged.
- **Rate**: what one share actually gained over about the last 30 days, annualised (simple, not compounded), from `convertToAssets` at two blocks and their real timestamps. It is net of the vault's fees and excludes any external rewards. It needs a node that serves historical state; without one the rate shows as unavailable and everything else still works.
- **Writes** follow the trade panel: a synchronous lock before the first await, a network switch if needed, a simulation before every signature, then the receipt. One-at-a-time wallets: approve (only when the allowance is short), then deposit. Smart wallets that already execute atomic batches (`wallet_getCapabilities` → `atomic.status: "supported"`): one `wallet_sendCalls` with approve + deposit, atomic, so a failed deposit takes the approval back with it. The batch is simulated before its one prompt too: the approval, then the deposit with the approval's only effect (the allowance) applied as a state override on USDC (`allowed` mapping, slot 10, `assetAllowanceSlot`). The override is trusted only after a read shows it took; otherwise the wallet gets the one-at-a-time path, where each call is simulated on its own. A deposit that reverts with the allowance in place stops before any prompt. A withdrawal batch is one call, simulated first. A wallet that would first need an EIP-7702 upgrade (`"ready"`) takes the one-at-a-time path.

## Builder code

Every Earn transaction is credited to openlaunch's Base builder code `bc_ly9ism19` (ERC-8021, `BUILDER_DATA_SUFFIX` in `app/src/lib/chainPublic.ts`):

- each call's data ends with the suffix: the approval, the deposit, the withdrawal and the redemption. One-at-a-time wallets get it as `dataSuffix` on `simulateContract`/`writeContract`, passed per call because a suffix set in the wagmi config is not applied for injected wallets (wagmi #5248);
- batching wallets also get it as the `dataSuffix` capability on `wallet_sendCalls` (`optional: true`), so the wallet can tag its own operation.

Base's Dashboard reports lending TVL per builder code. Check a real transaction with Base's builder-code checker or by decoding its input (`Attribution.fromData` from `ox/erc8021`).

## Safety rules

- **Exact approvals only.** No unlimited allowance exists anywhere in the feature (enforced by `components/earn/earn-ui.test.ts`). An unspent exact approval remains on-chain until used or revoked.
- **Terms tripwire.** A vault's owner and curator can change fees and gates, some with no delay. Before every deposit the browser reads the vault's asset, performance fee, management fee and four gates. If any differ from the reviewed terms (a fee above 0, a gate set, a different asset), the deposit is refused with the reason. The form also shows "Deposits paused" before anyone tries: the open card re-reads the terms every minute (the server's 10-minute figures stand until that first read lands, and whenever the latest read failed). The pause is derived from those reads, never stored, so it lifts by itself once the vault is back to the reviewed terms. **Withdrawals never depend on it.**
- **Sent means sent.** Once the wallet returns a transaction hash (or a batch id), only a final answer ends the action: a successful receipt (done) or a reverted one (an error, after which sending again is safe). A receipt timeout or RPC error leaves it **unconfirmed**: the form stays locked with the amount out of reach, the transaction link is shown, and "Check again" asks the chain (or the wallet, for a batch) once more. Closing the sheet keeps this; reloading the page forgets it, so the copy says to look at the wallet's activity before sending again. An approval whose receipt cannot be read is the one exception that may be retried, because approving again sets the same exact allowance.
- **One account per action.** Every wallet prompt is bound to the account that started the action (`getWalletClient({ account })`, `account` on each write) and preceded by a check that it is still the connected account. A switch mid-action stops it before the next prompt, rather than falling back to another path; so does leaving the page.
- **Terms at every step.** The terms are read again after an approval confirms, right before the deposit is prepared, closing the approval window. They can still change after the deposit is signed; nothing here can prevent that.
- **Liquidity.** The vault pays withdrawals from what its markets have free. A withdrawal larger than that reverts in simulation and the panel says so; nothing is sent.
- **Copy.** The rate is labelled "Last 30 days · Annualised. Variable." The risk line is always visible: deposits can lose money; openlaunch never holds the funds, cannot move them and cannot guarantee a withdrawal; the vault is run by Steakhouse Financial, not openlaunch. No Base or Coinbase marks, no yield promises.

## Limits

- Base only, one vault, USDC only. No borrowing, no "earned so far" figure (it needs deposit history the app does not index), no country restrictions (the switch is global).
- The vault is a third party. Its availability, liquidity, rate and solvency are not guaranteed by openlaunch.
- The batch path for smart wallets is covered by unit and flow tests (exact calls, capability, preflight) and the live test proves the allowance override lands in Base USDC's storage, but it has not yet been run with a real wallet.

## Development and verification

From `app/`: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`. Set `EARN=on` in `.env.local` to see the card locally.

`/ui-review-earn` is a development-only fixture of the card and every panel state (disconnected, first deposit with approval, approved deposit, over balance, wrong network, approving, confirming, unconfirmed transaction and batch, done, withdraw all, withdraw part, liquidity error, paused terms, rate unavailable).

`components/earn/earn-flow.test.ts` runs the real `deposit`, `withdraw` and `recheck` code from `useEarn.ts` against inert wallets and RPCs: a receipt timeout leaves the action unconfirmed and a second press sends nothing; a wallet switch at either step stops before the next prompt; a terms change while the approval confirms stops the deposit; a batch is one atomic, builder-tagged request and only the wallet's final status ends it. `?scene=<id>` shows one. The route returns 404 outside development.

The opt-in live read test checks the pinned vault on Base mainnet (factory proof, asset, fees, gates, a deposit preview, the snapshot). It sends nothing:

```sh
RUN_EARN_LIVE_TESTS=1 npx tsx --conditions=react-server --tsconfig tsconfig.test.json --test src/lib/earn/vault.live.test.ts
```

### Verification log (2026-10-14)

- On-chain review of the vault: `VaultV2Factory.isVaultV2` true; asset `0x8335…2913` (USDC); performance and management fee 0; all four gates `0x0`; about 182.6M USDC deposited; a simulated 1,000 USDC deposit from a fresh address (state override) succeeded.
- Fork run on a local anvil fork of Base, anvil test key, every call carrying the suffix: exact approve 1,000 USDC → deposit (shares within 3e-8 of the preview; allowance back to 0; position 999.999999 USDC) → withdraw 100 USDC → redeem all (shares 0; 1,000.000002 USDC back). Gas: 55,895 / 327,074 / 325,836 / 303,949. Every mined input ended with the suffix, and the deposit's decoded to `{ codes: ["bc_ly9ism19"] }`.
- Live read test passed: rate 4.4% for 2026-09-14 → 2026-10-14, terms as reviewed.
- Not yet done: a real deposit and full withdrawal from a maintainer's own wallet (one ordinary wallet, one Coinbase Smart Wallet), with both transactions checked for the builder code and lending TVL seen on the Base Dashboard. Do this before setting `EARN=on` in production.

## Primary references

- [Morpho Vault V2](https://docs.morpho.org/learn/concepts/vault-v2/) and [contract addresses](https://docs.morpho.org/developers/contracts/addresses)
- [Base: integrate an earn product](https://docs.base.org/build-on-base/integrate-defi/integrate-earn-product)
- [Base builder codes for app developers](https://docs.base.org/specifications/builder-codes/for-app-developers)
- [EIP-5792 wallet call API](https://eips.ethereum.org/EIPS/eip-5792)
- [Steakhouse Financial](https://www.steakhouse.financial)
