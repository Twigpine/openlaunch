# Boost: TWIG for a place in the Boosted lane

A **Boosted** lane sits under the Trending board on the home page and on /base. It shows the 5 tokens with the most TWIG sent to `0x000000000000000000000000000000000000dEaD` for them in the last 24 hours. Nothing is paid to openlaunch or Twigpine: the TWIG is gone, and the GITLAWB behind it stays in the TWIG contract.

The lane is a separate, labelled surface. **It is not part of the ranking**: the Live sort, the Trending board and `app/src/lib/launchpad/ranking.ts` never read boosts (`app/src/components/launchpad/boost-ui.test.ts` enforces it). A token still cannot buy its way into the facts-only ranking; it can only buy a place in a row that says it is paid.

The feature is **off unless the runtime secret `BOOST=on` is set**. Off, `GET /api/boost` answers `{ "enabled": false }`, and the lane, the token page line, the dialog, the /me link, the ⌘K entry, the rules entry and the llms.txt section do not appear. `fly secrets set BOOST=on` turns it on (the app restarts, no rebuild); unsetting it or any other value is the kill switch. Open tabs follow the switch on their next live poll (about 5 seconds). The indexer records boosts either way: they are on-chain burns whatever the switch says.

## The rule

A boost is one plain ERC-20 transfer on Base:

```
TWIG (0x6ac18bcf4ede02591d4917452700ea5eaaea13c1).transfer(0x…dEaD, amount)
amount = whole TWIG × 10^18 + the launch's position id
```

- **The last 12 digits name the launch.** The tag is `amount mod 10^12`, the launch's `token_id` (its Uniswap v4 position id, unique on Base's PositionManager; about 3.1 million in October 2026). It is worth less than 10^-6 TWIG, so wallets show the whole amount. Tags from 10^11 up are reserved for later kinds (pinned posts, names) and are ignored today.
- **Why the amount and not a memo in calldata:** the tag is in the Transfer event itself. The indexer reads logs only, and a plain wallet, an ERC-4337 smart wallet, a Safe and an agent all boost the same way. The ERC-8021 builder-code suffix still rides on the calldata, as on every other transaction from the app.
- **Floor:** 100,000 whole TWIG, in TWIG, not dollars, so a pushed TWIG price cannot move it. Smaller transfers are not boosts.
- **Window:** a token stays in the lane until 24 hours after its newest boost. Boosts on one token inside that time add up. Order: most TWIG in the window, then the newer boost, then the address.
- **Lane size:** 5. A boost counts toward its token's total for 24 hours whether or not the token is shown; when the lane is full, a token shows once its total reaches the 5th place (a tie goes to the newer boost).
- **Who:** anyone, for any Base launch. The booster recorded is the Transfer's own sender, so a smart wallet is credited, not its bundler.
- **Base only:** TWIG exists only there (`TWIG_ADDRESSES` in `app/src/lib/launchpad/twig.ts`).

## How it works

- **Pure core** (`app/src/lib/launchpad/boost.ts`): the constants, the amount encoding and decoding, the Max amount under a balance, the Transfer-log decoder, the lane order, the time left, the moderation message and every sentence the feature shows.
- **Indexing** (`app/src/lib/launchpad/indexer.ts`): each Base suite range adds one log query, TWIG `Transfer` with `to = 0x…dEaD`. The receipt path (`POST /api/launch/sync?chain=base&tx=…`, which the dialog calls after the receipt) applies the same logs at once. Rows land in `bb_boosts` as raw facts (sender, amount, tag, block, time). Fee burns from every configured launch locker and fee vault are skipped: they are fees, already counted. Overlapping suite ranges and receipt replays count a boost only once.
- **Reading** (`app/src/lib/launchpad/boostServer.ts`): the lane joins `bb_boosts` to `bb_launches` by `(chain_id, token_id = tag)` at read time, so a boost indexed before its launch still counts once the launch is in. It is cached for 5 seconds per machine; a sync that indexed a boost and an admin hide drop that cache, so the next read on that machine is fresh. `GET /api/boost?chain=base` and `GET /api/boost?chain=base&token=0x…` serve the same data; the token read also says whether the lane is full and what its 5th place holds.
- **Live poll:** every `/api/launch/live` answer carries `boost_on` (one boolean, seeded by the root layout, so /me and ⌘K are right on first paint). The lane's cards come only with `?boost=1`, which the poll adds while a lane is on screen.
- **Totals:** while the switch is on, the hero's "TWIG burned" adds boosts that name a launch to the fee burns; its label splits the two.

## The lane's motion

Nothing in the lane moves on its own, the same rule as the Trending board above it. Each card has a **fuse**: a thin warm line along its bottom edge whose length is the share of its 24 hours still left, stepped with the card's 30-second clock. When a poll shows a card with more TWIG than before and a boost under 3 minutes old (`boostIgnitions`), the card **lights up** once: a warm inset ring, the amount rolling up to its new total, and a few embers rising from it. A token that only moved up because another expired stays still. Places change with a short slide. With reduced motion only the colour ring plays: no embers, no roll, no slide.

## The dialog

On a Base token page (or from **Boost** on a launch in /me, which opens it there): whole TWIG only, presets 100K / 300K / 1M / 5M, the balance, Max (tag included), an estimate in dollars at today's TWIG price, and the last digits the amount will carry. It states plainly that the TWIG goes to 0x…dEaD, cannot be undone or refunded, and counts toward the token's place in the lane for 24 hours without changing the ranking. When the lane is full and the amount would leave the token under the 5th place, the dialog says so before anything is sent and offers the amount that would show it now. The done screen names the token's place, or says it is not in the lane yet.

Writes follow the trade panel: a synchronous lock before the first await, a network switch to Base if needed, a simulation of the exact transfer, then the wallet. **Sent means sent:** once the wallet returns a hash, only a receipt ends the action. A receipt that cannot be read leaves the dialog unconfirmed and locked, with "Check again" and the transaction link; the token page keeps that lock if the dialog is closed and reopened. A reload forgets it, so the copy says to check the wallet's activity before sending again.

## Moderation

ADMIN_WALLETS can hide a token from the lane on /admin (or show it again by address). Each action is an admin-wallet signature over a boost-specific message (`openlaunch.lol boosted lane`, the action, `base:<token>`, the admin, a single-use nonce, a time within 5 minutes), so a posts signature can never be replayed here. Hidden is a flag in `bb_token_settings.boost_hidden`. Burns already sent stay recorded and are never refunded. A hidden token's page says it is not shown in the lane and offers no button, so nobody burns TWIG for a place it cannot get.

## Copy rules

Always "sent to 0x…dEaD". Never a price or value claim, never "boost your price", never moon, rally, buyback, guarantee, reward, airdrop or yield (`boost.test.ts` checks every sentence). The lane says "Not a ranking". Boosted is not endorsed, and the dialog says so.

## Development and verification

```
cd app
npx tsx --conditions=react-server --tsconfig tsconfig.test.json --test src/lib/launchpad/boost.test.ts src/components/launchpad/boost-ui.test.ts
BOOST=on npm run dev
```

On an anvil fork of Base, a wallet with TWIG can boost any launch the local database knows; the receipt path and the indexer path both record it. Weekly figures:

```sql
SELECT date_trunc('week', block_time) AS wk, count(*) AS boosts, count(DISTINCT booster) AS boosters, sum(amount) / 1e18 AS twig
  FROM bb_boosts WHERE chain_id = 8453 GROUP BY 1 ORDER BY 1 DESC;
```
