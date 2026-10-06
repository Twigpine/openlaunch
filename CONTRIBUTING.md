# Contributing

Thanks for looking. openlaunch is small on purpose: three contracts, one site, no platform fee. Changes that
keep it that way are welcome.

## Ground rules

- **No fee, no owner, no admin.** Pull requests that add a fee switch, an owner, a pause, an allowlist or an
  upgrade path to the contracts will not be merged. That is the product.
- **Facts over scores.** UI that ranks or flags tokens must be derived from on-chain data the reader can verify
  (see the holders panel and the trending strip for the pattern).
- **Tests with the change.** Pure logic lives in `app/src/lib/launchpad/*.ts` and is unit-tested with
  `node --test`; contracts are tested with Foundry. CI runs both on every pull request.

## Setup

```
git clone --recurse-submodules https://github.com/Twigpine/openlaunch.git
cd openlaunch/app && npm install && cp .env.example .env.local   # fill in RPCs + DATABASE_URL
npm run migrate && npm run dev
cd ../contracts && forge test --match-path test/LaunchFactory.t.sol
```

`app/README.md` covers running against anvil forks of the chains. `app/LAUNCH.md` is the production runbook.

## Before you open a pull request

```
cd app && npm run lint && npx tsc --noEmit -p . && npm test && npm run build
cd ../contracts && forge build && forge test --match-path test/LaunchFactory.t.sol
```

For contract changes, also run the live-fork suites locally (`FORK_TESTS=true forge test`) and say so in the PR.

## Style

- TypeScript strict, ESLint clean, no new dependencies without a reason in the PR.
- Commit messages: short imperative subject, a body that says *why*.
- Keep the design system: shared class tokens live in `app/src/components/ui.ts`.

## Security issues

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).
