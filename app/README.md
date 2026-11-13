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
First-time setup (secrets, storage, contracts) is in `LAUNCH.md`. Every deploy after that is a tagged release:

## Releasing
Releases are cut by [release-please](https://github.com/googleapis/release-please) from the conventional-commit titles
of the pull requests merged into `main` (they are squash-merged, so each title is one commit). The version lives in
`package.json` (SemVer: `fix` is a patch, `feat` a minor version, `!` a major one); the notes go to `CHANGELOG.md` and
[GitHub Releases](https://github.com/Twigpine/openlaunch/releases). The site footer and `/api/health` show the running
version and commit.

1. After each merge, release-please keeps one pull request titled `chore: release X.Y.Z` up to date: the version in
   `package.json` and `package-lock.json`, and the new `CHANGELOG.md` entry. Edit the notes there if needed; they are
   public: no hostnames, secrets, wallet keys or unfixed vulnerabilities.
2. A maintainer approves its checks: GitHub holds the workflow runs of a pull request that release-please's token opens
   or updates until someone with write access clicks **Approve workflows to run** on it. Then the maintainer approves the
   pull request (pr-guard asks for an owner's approval), re-runs `pr-guard` (it reads approvals only when it runs, see
   CONTRIBUTING.md), and merges once it passes. release-please tags the merge commit `vX.Y.Z` and publishes the GitHub
   Release.
3. Deploy, by hand, from an up-to-date `main` (`git pull`), at the repository root: `app/scripts/deploy.sh --dry-run`,
   then `app/scripts/deploy.sh`, both through the maintainers' checker below. `deploy.sh` refuses anything but a clean
   `main` equal to `origin/main` whose tag is on GitHub and whose release is published; it takes the contract addresses
   from the hash-pinned deployment records and checks that production reports the new version and commit. Then run
   `app/scripts/smoke.sh`.

A bad release is fixed by a new patch release, never by moving or deleting a tag. If release-please is ever off, a
release can still be made by hand: in one pull request bump the version in `package.json` and `package-lock.json` and
the `app` entry in `.release-please-manifest.json` to the same number (release-please counts from that manifest), tag
the merge commit, publish the release with its notes, then deploy as above.

The release tooling (`scripts/deploy.sh`, `smoke.sh`, `migrate.mjs` and `scripts/lib/`, the `Dockerfile`,
`.dockerignore`, `fly.toml`, and `release-please-config.json` at the repository root) is blocked by pr-guard for
everyone: it runs with the deploy credentials or against the production database, or decides how releases are cut, so
it changes only in a pull request of its own that a maintainer merges with the guard bypassed. Maintainers also deploy
through a checker kept outside the repository, which compares these files with the fingerprints of the last reviewed
release before it runs `deploy.sh`.
