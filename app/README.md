# openlaunch.lol — app

**Launch a token. Free. Open source. On Base, Robinhood Chain or Arc.**

The site for the [openlaunch](../README.md) launchpad. One transaction deploys a fixed-supply ERC-20,
opens a Uniswap v4 pool and locks 100% of the supply as liquidity in an ownerless locker — forever.
No platform fee anywhere. Contracts live in `../contracts` (`LaunchFactory.sol`, `LaunchLocker.sol`,
`LaunchToken.sol`; design in `../contracts/docs/LAUNCHPAD.md`).

Next 16 app router, React 19, Tailwind 4, wagmi 3 + viem 2, Postgres (postgres.js). Runs on Fly.io
(two web machines + an attached Postgres with WAL backups to Tigris); see `LAUNCH.md` for the runbook.

## Pages / API
- `/` list (new · active · volume · market cap) + live tape · `/launch` form · `/t/<token>` trade + fees
- `/rules` how it works · `/agents` contract call + JSON · `/llms.txt`
- `GET /api/launch/list?sort=&limit=` · `GET /api/launch/feed` · `GET /api/launch/meta/<token>`
- `POST /api/launch/meta` (metadata before launching → `{uri, token}`) · `POST /api/launch/sync?tx=` · `GET /api/health`

## How it hangs together
- `src/lib/launchpad/` — `abi.ts` (factory / locker / PoolManager Swap / StateView / Quoter /
  Universal Router / Permit2), `math.ts` (ticks ↔ prices, FDV, formatting), `swap.ts` (V4_SWAP
  encoding), `meta.ts`, `queries.ts`, `indexer.ts` (receipt apply + chunked poller), `loop.ts`.
- Trades happen in the page through the Universal Router (`TradePanel.tsx`): buys send ETH as
  value; sells approve the token to Permit2 once, then a 30-day Permit2 allowance to the router.
- `db/schema.sql` — `bb_launches`, `bb_launch_swaps`, `bb_launch_fee_events`, `bb_launch_meta`,
  `bb_launch_sync_state` (+ `bb_migrations`). Idempotent; applied on every deploy.

## Token charts

Token pages prefer GeckoTerminal’s hosted advanced chart. The lookup validates the
exact chain, Uniswap v4 pool ID, launched base token and quote. Reversed listings
are not used, because the embed would chart the quote asset instead of the token.
Base, Robinhood and Arc use their own provider network IDs. Arc pools retain the
factory's USDC ERC-20 quote identity; native USDC is not substituted for it.

Unlisted, unpriced or temporarily unavailable pools fall back to Openlaunch’s own
indexed candles. **On-chain** is also available manually if a provider frame is
blank, blocked or slow; an iframe load event cannot prove its chart rendered.
Tokens without indexed swaps show **No trades yet**, not fabricated launch-price
candles. The existing shared live clock refreshes native history and can discover
the first swap. Retry Advanced to recheck a previously unavailable provider.

The native renderer is lazy-loaded and retains extreme-value normalization,
quote/USD and price/market-cap modes, volume, read-only wallet markers and bounded
history. The swap panel, stats, indexer and public candle API are unchanged.

`GET /api/launch/chart-provider?chain=&token=&pool=&quote=` returns a classified
status. It deduplicates lookups, caches ready/reversed metadata for 15 minutes and
unlisted/unpriced results for 60 seconds (at most 1,000 entries per process).
Requests time out after 8 seconds. Limits are 60 requests/IP/minute, 10 uncached
upstream calls/minute and two concurrent upstream requests per process; HTTP 429
starts a 60-second upstream cooldown. Cache hits remain available during cooldown.
Scale-out does not supply a shared global limit; use a shared cache/budget if needed.
Provider errors are never cached as missing listings.

Gecko’s official embed options set a black background in dark mode, the site’s
light paper in light mode, and its grayscale logo. Gecko’s own toolbar handles
intervals, drawing tools, indicators and display modes; availability remains under
the provider’s control. Attribution stays visible. Changing site theme, reloading,
or switching sources may reset drawings. No proprietary chart library files are
redistributed.

Only the fixed Gecko API origin is requested by the server, without viewer wallet
addresses or credentials. The browser contacts Gecko directly for the iframe.
CSP allows only `https://www.geckoterminal.com` as a frame origin on all entry
pages, preserving client navigation. It does not allow provider scripts or
connections in the parent page; `frame-ancestors` remains `none`.

The development-only `/ui-review-charts` exercises eight real pool identities,
including an Arc USDC-quoted pool, without a local database. Its allowlisted candle
proxy reads the public production
API without forwarding wallets, cookies or credentials. Both preview endpoints
return 404 in production. See its [test notes](src/app/ui-review-charts/README.md).

No schema migration is required. Reverting the chart integration restores the
previous native-only UI; stored candle history remains untouched.

## Local dev against a Base fork
```
anvil --fork-url https://mainnet.base.org --port 8545 --chain-id 8453
cd ../contracts && DEPLOYER_PRIVATE_KEY=<anvil key 0> forge script script/dev/SeedLaunchpadLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
createdb basebid_dev && DATABASE_URL=postgres://localhost/basebid_dev npm run migrate
# .env.development.local: NEXT_PUBLIC_CHAIN=base, NEXT_PUBLIC_RPC_URL/BASE_RPC_URL=http://127.0.0.1:8545,
#   NEXT_PUBLIC_LAUNCH_FACTORY/_LOCKER + LAUNCH_DEPLOY_BLOCK from the seed output, LAUNCH_SYNC_CONFIRMATIONS=0, LAUNCH_SYNC_LOOP=1
npm run dev
```
Gotcha: anvil's default accounts carry EIP-7702 delegations on Base mainnet — ETH sent to them is
forwarded away. Use a fresh key (`cast wallet new` + `anvil_setBalance`) when testing sells.

## Deploy
See `LAUNCH.md`.
