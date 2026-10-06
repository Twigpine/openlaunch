<p align="center">
  <a href="https://openlaunch.lol"><img src="brand/readme-banner.png" alt="OPENLAUNCH.LOL — Launch a token. Free. Open source. Liquidity locked forever." width="100%"></a>
</p>

<p align="center"><b>Launch a token. Free. Open source. On Base, Robinhood Chain or Arc.</b></p>

<p align="center">
  <a href="https://openlaunch.lol">openlaunch.lol</a> ·
  <a href="https://openlaunch.lol/rules">how it works</a> ·
  <a href="https://openlaunch.lol/agents">for agents</a> ·
  <a href="https://x.com/openlaunch_lol">@openlaunch_lol</a>
</p>

<p align="center">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-0052FF">
  <img alt="Base" src="https://img.shields.io/badge/chain-Base-0052FF">
  <img alt="Robinhood Chain" src="https://img.shields.io/badge/chain-Robinhood%20Chain-15803d">
  <img alt="Arc" src="https://img.shields.io/badge/chain-Arc-111111">
  <img alt="platform fee 0" src="https://img.shields.io/badge/platform%20fee-0-15803d">
  <img alt="contracts verified" src="https://img.shields.io/badge/contracts-verified%20on%20Basescan%20%2B%20Sourcify-0052FF">
</p>

---

**One transaction** deploys a fixed-supply ERC-20, opens a Uniswap v4 pool at the market cap you pick and
locks **100% of the supply** as liquidity in an ownerless locker — forever. Nobody can pull it: not the
creator, not us. There is **no platform fee**: the factory and the locker have no fee address at all.
Creators choose a 0 / 1 / 3 % trading fee that is pushed **in full** to beneficiaries they name, or burned.

## What you get

- **Free by construction.** No fee parameter exists in the contracts, so there is nothing to raise later.
- **Rug-proof liquidity.** The position NFT lives in a locker with no owner, no pause, no upgrade path and
  no transfer function. Proven with an adversarial fork suite against the live deployment.
- **Three chains, one set of rules.** Base, Robinhood Chain and Arc (Circle's L1, where gas and quotes are USDC), same contracts; Arc runs `LaunchFactoryArc`, the same source plus a guard that refuses native-asset quotes (see `contracts/docs/LAUNCHPAD.md`).
- **Any quote asset.** ETH, USDG, USDC on Arc, **TWIG** ([Twigpine](https://twigpine.com)'s token on Base: a 1:1 wrapper of GITLAWB,
  wrap or unwrap any time with no fee; priced at GITLAWB's price; fees paid or burned in TWIG), **GITLAWB** ([Twigpine](https://twigpine.com)'s token, on Base and bridged 1:1 to
  Robinhood Chain; priced from its Base Uniswap v4 WETH pool; fees paid or burned in GITLAWB; the Base form offers TWIG in its place), or a **tokenized stock**: Coinbase's B20 stocks on Base
  (NVDAc, AAPLc, TSLAc, …, priced from Chainlink on-chain feeds) and Robinhood Stock Tokens on Robinhood Chain.
- **Trade in-page.** Buys and sells go straight to the Uniswap v4 pool through the Universal Router; the site
  never touches funds.
- **Live everything.** One poller feeds the list, the trending strip, the tape, toasts and totals.
- **Holders & trust panel.** Every transfer of every launched token is indexed: holder count, top-10 share,
  creator holdings and sells, launch-window snipers, locked-pool share. Facts, no score.
- **Creator dashboard.** Fees earned, collect in one click, signed metadata edits, per-token share cards.
- **Posts.** Wallet-signed comments on token pages and a human feed, with reports and creator mute.
- **Agents welcome.** Plain JSON APIs, `llms.txt`, and a launch flow that needs nothing but a wallet.

## Deployments

| chain | LaunchFactory | LaunchLocker |
|---|---|---|
| Base (8453) | [`0x8155…de72`](https://basescan.org/address/0x815542E8b392389A1389E22E588E4B62A67Ade72#code) | [`0xcd16…842a`](https://basescan.org/address/0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a#code) |
| Robinhood Chain (4663) | [`0x8155…de72`](https://robinhoodchain.blockscout.com/address/0x815542E8b392389A1389E22E588E4B62A67Ade72) | [`0xcd16…842a`](https://robinhoodchain.blockscout.com/address/0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a) |
| Arc (5042) | [`0x8155…de72`](https://explorer.arc.io/address/0x815542E8b392389A1389E22E588E4B62A67Ade72) | [`0xcd16…842a`](https://explorer.arc.io/address/0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a) |

Full addresses: factory `0x815542E8b392389A1389E22E588E4B62A67Ade72`, locker `0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a`
— identical on all three chains (same deployer, first transaction each; on Arc the factory is `LaunchFactoryArc`, the same contract plus the native-quote guard). Source verified on Basescan, Blockscout (Base and
Robinhood Chain) and Sourcify (exact match on all three chains). Every launched token is verified too. No owner, no admin, no upgrade path.

## How it works

```
launch(params)                       # one call, gas is the only cost
 ├─ LaunchToken   fixed supply, ERC-20 + permit, no mint / pause / blacklist / tax
 ├─ PoolManager   Uniswap v4 pool, single-sided from your start tick to max
 └─ LaunchLocker  holds the position NFT forever; collect() pushes fees to beneficiaries or burns them
```

Trading fees (if any) are ordinary Uniswap v4 LP fees. `collect()` is permissionless: anyone can trigger a
payout, the recipients are fixed at launch, and a recipient that cannot receive is credited to claim later.
Details, invariants and the deploy steps: [`contracts/docs/LAUNCHPAD.md`](contracts/docs/LAUNCHPAD.md).

## Repository

| | |
|---|---|
| [`contracts/`](contracts) | `LaunchFactory`, `LaunchLocker`, `LaunchToken` (Foundry). Unit tests, live-fork suites on every chain, an adversarial "try to rug it" suite, and a tokenized-stock quote suite. Slither clean. |
| [`app/`](app) | The site: Next.js 16, React 19, wagmi 3 / viem 2, Postgres indexer for launches, swaps, fees, transfers and holders. 80+ unit tests plus a smoke suite that runs after every deploy. |
| [`brand/`](brand) | Logo tile, OG image and social assets. |

### Contracts

```
cd contracts && git submodule update --init --recursive
forge test --match-path test/LaunchFactory.t.sol                       # unit
FORK_TESTS=true forge test --match-contract LaunchLockerRugFork         # rug attempts vs live Base
FORK_TESTS=true forge test --match-contract LaunchStockQuote            # AAPL-quoted launch on Robinhood Chain
FOUNDRY_PROFILE=arc FORK_TESTS=true arc-forge test --match-contract LaunchFactoryArcFork   # USDC-quoted launch + Universal Router on Arc (needs circlefin/arc-foundry)
```

### App

```
cd app && npm install
cp .env.example .env.local        # RPCs, factory / locker addresses, DATABASE_URL (a local Postgres is enough)
npm run migrate                   # applies db/schema.sql; reads DATABASE_URL from .env.local
npm run dev                       # http://localhost:3000
npm test                          # unit tests (tsx + node --test)
```

`app/README.md` covers local development against anvil forks of the chains; `app/LAUNCH.md` is the
production runbook (deploy, backups, restore). Deploying your own instance: change the app name in
`app/fly.toml`, put production values in `app/.env.production`, run `scripts/fly-secrets.sh`, then `fly deploy`
with the four `NEXT_PUBLIC_LAUNCH_*` build args (see the top of `app/fly.toml`).

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md) — please report privately.
CI runs lint, typecheck, unit tests and a production build for the app, and build + unit tests for the contracts,
on every pull request.

## Security

- No platform fee, no owner, no admin keys, no upgradeability — verified in the source and in the deployed bytecode.
- Liquidity cannot be withdrawn by anyone; see `contracts/test/LaunchLocker.rug.fork.t.sol` for what was tried.
- Wallet-signed, single-use-nonce authorization for every off-chain write (posts, edits); images are re-encoded
  server-side; the share-card renderer never fetches user-supplied URLs.
- Tokenized stocks are securities issued by third parties under Regulation S and are not offered to US persons;
  the site only recognizes them from the issuers' own registries, never from on-chain names.

Found something? Open an issue or reach out on X: [@openlaunch_lol](https://x.com/openlaunch_lol).

## License

MIT — see [`LICENSE`](LICENSE).
