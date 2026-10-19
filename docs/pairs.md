# Community pairs

A launch can be paired with any ERC-20: the factory has no allowlist and never will. **Community pairs** are the site's list of community tokens it badges and prices in USD. They are never offered in the launch form, which offers ETH, TWIG and stocks only: a launch paired with a community token is made against the factory by the community's own tools or agents (findSalt with the pair's address, then `launch`). A token that is not on the list still trades; it shows as an "Unlisted pair", with no USD price, and stays out of Trending.

Chains: **Base and Robinhood Chain**. The fee is TWIG on Base for a token on either chain, and every pair signature (the applicant's and the admin's) is made on Base.

Pages: `/pairs` (the list), `/pair/<chain>/<address>` (`base` or `robinhood`; one pair: its price source, what is checked, its public record, its launches), `/pairs/apply` (the free check and the application), `/pairs/apply/<id>` (one application). API: `GET /api/pairs`.

## What a listing gets, and what it does not

- The community's badge (its logo and symbol, a neutral pill, never a seal) everywhere a paired launch shows, and on the share card ("community pair · priced in X").
- A USD price, so paired launches show market caps and volume in dollars and can reach Trending.
- Not a place in the launch form.
- Points count a pair only when it is priced from an openlaunch pool (its own launch), as MUSEWORLD is.
- Nothing in the ranking: the Live sort counts outside wallets, as for every launch.

A pair is never called official, verified or safe. Listing is not an endorsement.

## The price

USD per pair token = the price pool's spot (quote units per pair token) × the USD price of the core quote on the pool's other side (ETH or WETH, USDC, USDG, GITLAWB or TWIG). The spot is checked against a 30-minute average, the GITLAWB rule: a spot more than 25% off the average is replaced by it. **With no average there is no USD.**

| `price_kind` | Pool | Average from |
|---|---|---|
| `launch` | the token's own openlaunch pool | our swap index (`bb_launch_swaps`) |
| `univ3` | a Uniswap v3 or Aerodrome Slipstream pool | the pool's own oracle (`observe`) |
| `univ4` | a Uniswap v4 pool (by its 32-byte id) | our minute samples (`bb_pair_prices`), at least 20 of the last 30 minutes |

A v4 pool's key is read from the v4 PositionManager (`poolKeys`), so the pool must be the token against that quote, and a pool with a hook is listed only when the admin names that hook.

## Watching: the hourly monitor

Every listed pair (and every pair the monitor itself suspended) is checked about hourly, by one machine at a time (`pairsTick`, from the sync loop):

- **Code**: the runtime code's hash must match the one recorded at listing. A pair listed without one (the seeded MUSEWORLD) is pinned on its first check. A change **suspends at once**; reading no code at all counts as a failing check (one lagging node can answer empty, and a token's code cannot vanish).
- **Pool**: the price pool must give a spot and an average.
- **Liquidity**: the pool must hold at least $25,000 (GeckoTerminal's figure; unknown counts as no answer, not a failure).

A pool, liquidity or no-code failure that lasts **24 hours suspends** the pair; **14 days** suspended (by the monitor) **delists** it. A pair the monitor suspended comes back by itself when its checks pass. An admin's suspension and every delisting are only lifted by an admin. A core quote's own price outage (no ETH or GITLAWB price) never counts against a pair. Every change is written to `bb_pair_events` and shown on the pair's page; the monitor never writes over an admin's change made while it was checking.

A suspended or delisted pair's launches still trade: they show as unlisted (no badge, no USD, out of Trending), and their token pages say why.

## Listing by an admin

`/admin` → Community pairs, signed in as an admin ([admin.md](admin.md)). Every action is also a signature from the signed-in `ADMIN_WALLETS` wallet over a message that includes every field written (`buildPairAdminMessage`), with a single-use nonce:

- **list / update**: the server reads the token (ERC-20, 6 to 18 decimals, a symbol no core quote, no stock on that chain and no pair listed on either chain has) and the price pool (it trades this token against that quote, reads a price, holds at least $25,000) before writing. On Robinhood Chain the market data includes spoof pools that report large reserves with a handful of holders: the holder floor and the review are what keep those out, so check the pool's real trading there.
- **suspend / delist** (a reason is required and shown on the record), **reinstate** (pins the current code).

One listed symbol per chain is enforced by a unique index.

## Applying (self-serve)

Off unless the runtime secret **`PAIRS_APPLY=on`** is set (`fly secrets set PAIRS_APPLY=on -a basebid`). Off, `/pairs/apply` says applications open soon and the application APIs answer 503. The fee is **`PAIR_LISTING_USD`** dollars (default 200) in TWIG.

1. **Free check** (`POST /api/pairs/precheck`, `pairCheck.ts`). Hard checks, all required: a token contract that reads as an ERC-20 with 6 to 18 decimals and a symbol of its own (not a core quote, not a stock ticker on that chain, not a pair listed on either chain); not already a pair or a core quote; not an upgradeable proxy (EIP-1967 / EIP-1822 slots); a price pool against a core quote that reads a price, holding at least $50,000; trading for at least 14 days; at least 500 holders; plain transfers, tested by simulating a real holder sending the token (`TransferProbe.sol`, run inside an `eth_call` with a state override): it must arrive whole, and a transfer to `0x…dEaD` must succeed (launch fees are burned there). Flags for the reviewer: a live `owner()`, a minimal-proxy clone, `DELEGATECALL` in the code, B20 roles, top-10 holders, 24-hour volume, and GoPlus Security's second opinion. Holders and pool ages come from GeckoTerminal; anything a service cannot answer counts as unknown, never as a pass (so does the symbol while Robinhood's stock registry has not been read, and a listing is refused until it reads).
2. **Apply** (`POST /api/pairs/apply`, action `apply`): signed by a wallet whose openlaunch profile has a verified X account, picking one of the pools the check found. One application in progress per token, three per wallet.
3. **Proof**: the community's own X account posts the application code ("Application OL-12-K7QX"); the applicant saves the post's link (action `proof`). The reviewer checks it by hand.
4. **Fee**: `POST /api/pairs/application/<id>/quote` locks `$fee ÷ the lower of TWIG's spot and 30-minute average`, rounded up to 100,000 TWIG, for 30 minutes (a running lock is never replaced). The applicant sends it in one plain transfer:

   ```
   TWIG.transfer(0x…dEaD, whole TWIG × 10^18 + 3 × 10^11 + application id)
   ```

   This is kind 3 of the Boost tag space (tags below 10^11 name launches). The indexer records it in `bb_pair_burns` (range scan and receipt path both). A burn sent inside the lock counts at the locked price; a later one at the price when it is indexed. Burns add up; the application is paid within 2% of the fee. **The fee pays for a review, not a listing, and is never refunded: it is burned.**
5. **Review** (`/admin` → Pair applications; `POST /api/pairs/review`, signed): **approve** lists the pair through the same checks as an admin listing; **changes** and **reject** need a reason the applicant sees. The fee covers up to 3 reviews within 60 days of paying: after changes, the applicant asks again (action `again`). **Approve without fee** (`waive`, for a partner) lists an application that has not paid the same way and marks it approved with the fee waived. Never one that has paid, and never while the applicant may be paying: under a live fee quote, or in the hour after it while a transfer may still be indexing, even once a first transfer has landed (the panel says when it can be waived).

## Tables

`bb_pairs`, `bb_pair_events`, `bb_pair_prices`, `bb_pair_applications`, `bb_pair_burns` (`app/db/schema.sql`). Code: `app/src/lib/launchpad/pairs.ts` (rules), `pairPrice.ts`, `pairsServer.ts`, `pairCheck.ts`, `pairProbe.ts`, `pairApply.ts`, `pairApplyServer.ts`.
