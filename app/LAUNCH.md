# Launch runbook — basebid.lol launchpad

> **Working copy:** this repo (`gitlawb-platform/openlaunch`) is the single source since 2026-09-07. Deploy from
> `app/` with the command below; the old `basebid` deploy tree is archived. Local-only files that never enter git:
> `app/.env.local`, `app/.env.development.local`, `app/.env.production`, `contracts/.env`, `contracts/.launchpad-deployer.address`.


## 0. Deploy the contracts (Base mainnet)
Deployer key lives in the macOS keychain (service `basebid-launchpad-deployer`); address in
`../contracts/.launchpad-deployer.address`. Fund it with ~0.001 ETH on Base (deploy ≈ 0.00006 ETH).
```
cd ../contracts
DEPLOYER_PRIVATE_KEY=$(security find-generic-password -s basebid-launchpad-deployer -w) \
  forge script script/DeployLaunchFactory.s.sol --rpc-url https://mainnet.base.org --broadcast
# → LaunchFactory + LaunchLocker addresses + the deploy block (broadcast/…/run-latest.json)
forge verify-contract <factory> src/LaunchFactory.sol:LaunchFactory --chain base \
  --constructor-args $(cast abi-encode "c(address,address,address)" 0x498581fF718922c3f8e6A244956aF099B2652b2b 0x7C5f5A4bBd8fD63184577525326123B519429bDc 0x000000000022D473030F116dDEE9F6B43aC78BA3)
forge verify-contract <locker> src/LaunchLocker.sol:LaunchLocker --chain base \
  --constructor-args $(cast abi-encode "c(address)" 0x7C5f5A4bBd8fD63184577525326123B519429bDc)
```

## 1. Wind down the old board (owner = the BaseBid deployer EOA)
The old escrow (`0x7a6373BC4796971059824D5ce8DF71AdE54d0285`) still holds bidders' USDC and the
withdraw UI is gone. Push every refund from the owner key, then nothing else is needed:
```
cast send 0x7a6373BC4796971059824D5ce8DF71AdE54d0285 "endSeasonEarly()" --rpc-url https://mainnet.base.org --private-key $OWNER
cast send 0x7a6373BC4796971059824D5ce8DF71AdE54d0285 "batchRelease(uint256,uint256)" 1 100 --rpc-url https://mainnet.base.org --private-key $OWNER
# check: cast call … "totalLocked()(uint256)" → 0
```
(function names per `../contracts/src/BaseBid.sol`; see `../contracts/docs/BASEBID.md`.)

## 2. Fly
```
cd basebid
NEXT_PUBLIC_LAUNCH_FACTORY=0x… NEXT_PUBLIC_LAUNCH_LOCKER=0x… LAUNCH_DEPLOY_BLOCK=… ./scripts/fly-secrets.sh
fly deploy -c fly.toml --ha=false --remote-only \
  --build-arg NEXT_PUBLIC_LAUNCH_FACTORY=0x… --build-arg NEXT_PUBLIC_LAUNCH_LOCKER=0x…
curl -s https://basebid.lol/api/health
```
The release command applies `db/schema.sql` (adds the launch tables; leaves the old `bb_*`
board tables in place — drop them by hand later if wanted).

## 3. Smoke
Run `scripts/smoke.sh` after EVERY deploy (all page types + live APIs must be 200). Then:
Launch one token from the site with a real wallet (0% fee), buy 0.001 ETH of it, sell half,
press Collect on a 1% launch. Check `/api/launch/feed` shows all of it.

## Token logo uploads (Tigris bucket)

Logos are uploaded through `POST /api/launch/image` (wallet + per-IP rate limits, magic-byte sniff, sharp
re-encode to a 512² WebP with metadata stripped, random key) into a PUBLIC Tigris bucket. The app only
ever PUTs; nothing is deletable through the site. Create the bucket once (stages the AWS_* + BUCKET_NAME
secrets on the app automatically):

```
fly storage create -a basebid -n openlaunch-images --public
```

Then `fly deploy`. Public URL base defaults to `https://<BUCKET_NAME>.fly.storage.tigris.dev`
(override with `IMAGE_PUBLIC_BASE`). Without the bucket the route answers 503 and the form falls back to
the paste-a-URL field. Local dev: `IMAGE_STORE=local` → `.uploads/` served by `/api/launch/image/<key>`.
The per-token share card embeds a logo ONLY when it lives on that bucket host (`isOwnImageUrl`).

## Database backups (Fly built-in, enabled 2026-09-07)

Two layers, both automatic:

1. **Volume snapshots** — Fly snapshots the `basebid-db` volume daily; retention raised to 30 days
   (`fly volumes update <vol> -a basebid-db --snapshot-retention 30`). Restore = new volume from the
   snapshot → new Postgres machine. Day granularity.
2. **Postgres backups to Tigris** (`fly pg backup enable -a basebid-db`, then `fly secrets deploy -a basebid-db`
   to apply — that restarts the single Postgres machine, ~2 min of DB downtime): WAL archived every 60s,
   full base backup every 24h, 7-day point-in-time recovery window, bucket `basebid-db-postgres` (private,
   managed by Fly). Check: `fly pg backup list -a basebid-db` · `fly pg backup config show -a basebid-db`.

**Restore rehearsal (passed 2026-09-07 01:00Z):** `fly pg backup restore basebid-db-restore-test -a basebid-db
--restore-target-name <ID>` built a fresh cluster in ~100s; row counts matched production up to the backup's
end time (333 launches / 7,794 swaps / 522 metadata rows / 8 posts / 237 fee events). Query a restored
cluster with `fly ssh console -a <app> -C "sh -c 'PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -p 5433
-U postgres -d basebid -c ...'"` (port 5433, not the socket). Destroy the rehearsal app afterwards.
For a real recovery: restore to a new app, `fly postgres detach`/`attach` it to `basebid` (DATABASE_URL),
redeploy, run `scripts/smoke.sh`. Point-in-time: `--restore-target-time <RFC3339>` instead of a name.

## Trade-time USD backfill (2026-11-10)

Every trade and fee carries its USD value **at the time it happened** (`bb_launch_swaps.usd`, `bb_launch_fee_events.usd`,
per-launch sums in `bb_launches.volume_usd` / `fees_collected_usd` / `fees_burned_usd`). The indexer prices new ones from
the hourly ledger `bb_quote_usd_hourly`, writing the live price into the hour in progress (`lib/launchpad/usd-history.ts`,
`usdLedger.ts`). Trades from before that went live, and any hour the indexer could not price (a price source down, the
indexer catching up), are filled by the backfill. It is safe to run again at any time: it only prices rows with no USD
value, never replaces an hour the indexer captured live, and stops at the last completed hour.

```bash
cd app
# 1. generate (public price APIs only, no database access): dry run first
npx tsx --tsconfig tsconfig.test.json scripts/usd-backfill.ts --mode dry-run --out /tmp/usd-dry.sql
# 2. run it on the database machine: it prints the report (old method vs trade-time, per chain and quote, totals, fees)
#    and ROLLS BACK, so nothing changes
fly ssh sftp shell -a basebid-db <<< "put /tmp/usd-dry.sql /tmp/usd-dry.sql"
fly ssh console -a basebid-db -C "sh -c 'PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -p 5433 -U postgres -d basebid -f /tmp/usd-dry.sql'"
# 3. once the report looks right: generate and run --mode apply the same way (it writes, then recomputes every launch's
#    USD totals under the same locks as scripts/rebuild-launch-totals.sql; the indexer waits a few seconds)
```

History sources: ETH-USD and HYPE-USD hourly closes from Coinbase Exchange (HYPE gaps from Hyperliquid), GITLAWB from its
GITLAWB/WETH pool on Base via GeckoTerminal (price in WETH between trades) × ETH-USD, TWIG = GITLAWB, stables $1. Stocks,
community pairs and unlisted quotes have no history there: their older trades stay without a USD value (`usd IS NULL`).
