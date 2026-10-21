# Scope: original v1 suite

This document describes the original deployments. The new optional quote-only fee suite is documented in [QUOTE_FEES.md](QUOTE_FEES.md).

# Launchpad — free token launches on Uniswap v4 (Base)

**LIVE on Base mainnet (block 50940130) and Robinhood Chain (block 55880172), 2026-09-06** — same addresses on both: LaunchFactory `0x815542E8b392389A1389E22E588E4B62A67Ade72`, LaunchLocker `0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a` (`deployments/launchpad-base.json`, `deployments/launchpad-robinhood.json`). Robinhood default quote: USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec).

**Arc (5042): LIVE 2026-09-16 (block 21165817, tx `0x9814d588…6a4b7`)**, same addresses (`deployments/launchpad-arc.json`), deploying **`src/LaunchFactoryArc.sol`**: a verbatim copy of `LaunchFactory.sol` (which stays untouched, the Base / Robinhood source) with ONE guard: `launch` refuses `quote = address(0)` there (`NativeQuoteUnsupported`). `script/check-arc-factory.sh` fails if the two files drift apart in any other way. The copied NatSpec still describes native ETH as a quote; on Arc that path reverts (the guard wins), and the comments are left as deployed because the verified source must stay byte-identical to what is on-chain. On Arc the native asset is USDC and the same balance is also the ERC-20 at `0x3600…`; `LaunchLocker` keeps one ledger per currency (`reserved[currency]`, `claimable`), so a native-quoted position would let a credited ERC-20 share (a payout on Circle's blocklist, and three sanctioned addresses are blocklisted on Arc's USDC already) be read as native surplus by another launch's `collect` and swept, after which every smaller USDC collect underflows. `test_fork_arc_withoutTheGuardCreditedUsdcWouldBeSwept` reproduces it with the guard disabled; `test_fork_arc_nativeQuotedPoolCannotSweepCreditedUsdc` pins the refusal. The locker is byte-identical to Base and Robinhood Chain. Only quote: USDC `0x3600000000000000000000000000000000000000` (6 dec; it is also the gas token, the native balance at 18 dec). Uniswap v4 there: PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, PositionManager `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B`, Universal Router `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` (v2.1.1, "v2" swap layout). `test/LaunchFactory.arc.fork.t.sol` proves launch → buy → collect and the router layout against the live chain; it runs only under Circle's [arc-foundry](https://github.com/circlefin/arc-foundry) (`FOUNDRY_PROFILE=arc arc-forge test`), since upstream forge cannot execute USDC transfers on Arc.

Three contracts, no platform fee, no owner:

| contract | role |
|---|---|
| `src/LaunchFactory.sol` | `launch(params)` deploys a fixed-supply ERC20, initializes a v4 pool (quote/token), mints ONE single-sided position holding 100% of supply to the locker, registers fee recipients. Permissionless. |
| `src/LaunchLocker.sol` | Holds every position NFT forever (no transfer/decrease path exists). Anyone calls `collect(tokenId)`; 100% of LP fees are PUSHED to the launch's recipients in that tx (`Paid`), burned for the `DEAD` recipient (`Burned`), or — only if a push fails — credited for a later `claim` (`Credited`). |
| `src/LaunchToken.sol` | Plain ERC20 + EIP-2612 permit. No mint/pause/blacklist/tax. `metadataURI` immutable. |

## "Free" means, verifiably
- Factory: no launch fee, no `payable`, no treasury, no owner, no setter.
- Locker: no fee address, no bps variable. `_distribute` loops only over the launch's recipients; `test_noPlatformFee_lockerHasNoFeeSurface` asserts every `Credited` event goes to a named recipient and the sum equals the amount collected.
- Launcher picks `lpFee` 0–3% (pips, 10_000 = 1%). `0` = feeless pool. Non-zero → 100% to `recipients` (bps sum 10_000, ≤7). **Empty `recipients` = no beneficiary = every fee is burned** (registered as `[DEAD: 100%]`). A recipient equal to `0x…dEaD` inside a split burns that share.
- Push-first payout: `collect` sends ETH with a 50k gas stipend / ERC20 via low-level transfer; a failing recipient gets credited instead (never blocks others, never lost). Reentrancy guarded; `reserved` only tracks credited balances.
- Only cost of a launch is gas (~1.5M gas ≈ cents on Base).

## Launch params
```
name, symbol, metadataURI
quote        address(0) = ETH, or any ERC20 (USDC on Base = 0x8335…2913)
supply       0 → 1_000_000_000e18
startTick    multiple of 200; price = 1.0001^tick token per quote unit.
             ETH/18-dec token: 184_200 ≈ 1 ETH = 100M tokens (1B supply ≈ 10 ETH FDV)
lpFee        0 … 30_000
salt         any bytes32 (scoped to msg.sender). ERC20 quote: token must sort ABOVE quote →
             call `findSalt(launcher, baseSalt, name, symbol, supply, metadataURI, quote, 64)` first.
recipients   [] (= burn all fees) or [{payout,bps}…] summing to 10_000; payout 0x…dEaD = burn that share
```
Trading: standard v4 swap on `poolKeyOf(token)` (currency0 = quote, currency1 = token, tickSpacing 200, no hook). Buys move the tick DOWN.

## Tests
```
forge test --match-path test/LaunchFactory.t.sol            # 33 unit tests (incl. fuzz)
forge test --match-contract LaunchEventsTest                # 7 event-emission tests (indexer schema)
FORK_TESTS=true forge test --match-contract LaunchFactoryForkBase8453   # live Base: ETH + USDC quote
```

## Events (indexer schema)

Every off-chain row in `app/db/schema.sql` comes from one of these events.
`test/LaunchEvents.t.sol` pins each emission; `test_events_accountForEveryWei`
asserts the per-`collect` invariant `Paid + Credited + Burned == Collected`.

| event | indexed | data | indexer row |
|---|---|---|---|
| `Launched(token, tokenId, launcher, quote, poolId, startTick, lpFee, supply, metadataURI)` (factory) | `token, tokenId, launcher` | `quote, poolId, startTick, lpFee, supply, metadataURI` | `bb_launches` row (one per launch) |
| `Registered(tokenId, token, quote, recipients)` (locker) | `tokenId, token, quote` | `recipients[{payout,bps}]` | `bb_launches.recipients`; empty launch input is stored as `[DEAD: 100%]` |
| `Collected(tokenId, token, quoteAmount, tokenAmount)` (locker) | `tokenId, token` | `quoteAmount, tokenAmount` (one leg is 0 on buy-only / sell-only collects) | `bb_launch_fee_events` `kind='collected'` |
| `Paid(tokenId, account, currency, amount)` (locker) | `tokenId, account, currency` | `amount` | `kind='paid'`; one row per recipient pushed in this `collect`. `amount` may be `0`: `_tryPay` succeeds trivially on a zero share (integer-division dust on a tiny collect), emitting `Paid` with no outbound transfer — indexers must not treat every `Paid` as an actual push |
| `Credited(account, currency, amount)` (locker) | `account, currency` | `amount` | `kind='credited'`; `token_id` is null — the push failed, pull later with `claim` |
| `Claimed(account, currency, amount)` (locker) | `account, currency` | `amount` | `kind='claimed'`; emitted by `claim` / `claimFor` |
| `Burned(tokenId, currency, amount)` (locker) | `tokenId, currency` | `amount` | `kind='burned'`; immediate send to `DEAD`, never reserved or claimable |

Notes for indexers: the last recipient in `_distribute` absorbs rounding dust so
shares always sum to the collected amount; a `DEAD` recipient is burned inline
during `collect` (not credited); `collect` emits exactly one `Collected` plus
zero-or-more `Paid` / `Credited` / `Burned` per currency leg.

## Deploy (Base mainnet)
```
DEPLOYER_PRIVATE_KEY=0x… forge script script/DeployLaunchFactory.s.sol --rpc-url https://mainnet.base.org --broadcast
```
Dry-run 2026-09-06: ~5.4M gas, ≈0.00006 ETH. Slither 0.11.6: no findings above informational (zero-checks / OZ return values). Deployer key: macOS keychain `basebid-launchpad-deployer`, address in `.launchpad-deployer.address`. Then `forge verify-contract` factory (args: PoolManager, PositionManager, Permit2) and locker (arg: PositionManager), and set the factory address in the app.

Uniswap v4 on Base: PoolManager `0x498581fF718922c3f8e6A244956aF099B2652b2b`, PositionManager `0x7C5f5A4bBd8fD63184577525326123B519429bDc`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`.

## Not included (deliberately)
Anti-snipe hook (swap-path risk; opt-in v2), vesting/vault, airdrops, any admin.

## Rug-proof evidence (live Base, 2026-09-06)
`test/LaunchLocker.rug.fork.t.sol` (`FORK_TESTS=true BASE_RPC_URL=… forge test --match-contract LaunchLockerRugFork`) runs against the LIVE factory/locker and the first real launch:
- locker owns the position NFT; no approved operator; deployer / creator / factory are not operators
- deployer, creator and a stranger each try `transferFrom`, `safeTransferFrom`, `approve`, full `DECREASE_LIQUIDITY` and `BURN_POSITION` → every call reverts
- `collect()` leaves liquidity and ownership unchanged
- locker / factory / token answer no `owner()`, `pause()`, `upgradeTo`, `mint`
Deployed-bytecode selector scan of the locker: no `transferFrom`, `safeTransferFrom`, `approve`, `setApprovalForAll`, `burn`; `collect` hard-codes liquidity `0` in DECREASE_LIQUIDITY. LaunchToken bytecode: no `mint`, `pause`, `owner`, blacklist. Pool has no hook (address 0), so no hook can touch funds. PoolManager's owner can only set protocol fees (≤0.1%), never withdraw LP funds. Contracts are non-upgradeable constructor deployments, Sourcify exact match.

## Stock-token quotes (Robinhood Chain), verified 2026-09-06
`test/LaunchFactory.stock.fork.t.sol` launches a token quoted in **AAPL** (Apple • Robinhood Token, `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9`, 18 dec) against the LIVE factory, buys with AAPL, sells back, and collects 1% fees paid to the creator in AAPL. No contract change needed: `quote` is any ERC-20. Robinhood Stock Tokens are plain ERC-20s (+ERC-8056 `uiMultiplier()` for corporate actions), no transfer restrictions observed, and already flow through Uniswap v4 (the PoolManager holds AAPL). Registry: `GET https://api.robinhood.com/rhj/assets` (194 active tokens on 4663, all 18 dec); prices: `GET https://api.robinhood.com/rhj/prices/<SYMBOL>` (bid/ask USD, 15s cache; apply `currentMultiplier` for token-equivalent value).
