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

The whole card opens the token (the name link's `::after` covers it; only the credit's name sits above as its own link). Under 640px a card is one compact row, the name on the left and the TWIG, clicks and time left on the right, the credit under the name, so all five places fit on a phone screen. From 640px it is the stacked card. One set of parts, placed by CSS grid areas. A hover is the visitor's own doing, so it may move: the card warms, a still warm edge and an arrow show, the avatar grows a little and the fuse brightens. It applies only under a pointer that hovers (no stuck hover on phones, where a tap shows a pressed shade), and with reduced motion only the colours change.

## The lane's invitation

The lane asks for a boost where people see it, without ever sending one itself:

- **"Boost a token"** in the lane's header, on every screen size. **Every open place is a button** ("＋ Open spot · from 100K TWIG", one per place from 1024px; one "＋ N open spots · Boost a token" row below that, so the cards stay first). Each opens the **picker** (`BoostPicker.tsx`, loaded on first use): the connected wallet's own Base launches first (their creators are the likeliest boosters), a search of Base tokens, or what is trending on Base before anything is typed. Picking a token goes to `/t/base/<token>?boost=1#boost`, the same link /me's Boost uses, where the dialog opens with every check it has. Nothing is sent from the lane or the picker.
- **What it takes to get in**, beside the title (under it on a phone): "2 open spots · from 100K TWIG" while there is room, "Full · 5th place holds 1.2M TWIG" once there is not. It is read off the cards the lane shows (`boostEntryLine`), so it never contradicts them. The token page's dialog keeps its own rule from the full ranking; the two differ only when a ranked token's market row cannot be read and its card is left out.
- **Credit:** each card names the wallet that sent the most TWIG for it in the last 24 hours ("by @name ✓" with a profile, the short address otherwise; a tie goes to the newer boost, then the address). Only the name is a link, above the card's own. The lane read carries `top_booster` and the credited wallets' `names` (null for no profile), so the first paint shows the name without a swap; a failed read shows no credit and never fails the lane. The credit took the card's "Latest burn" link: the burns stay one step away, on the token page's Boost panel.
- **What the lane brought**, on the token's page: while it is boosted, the Boost panel adds "312 clicks from the lane in the last 24 hours" (`getTokenBoost` reuses the cards' own count, only for a token boosted in the window), from 10 clicks up (`BOOST_PANEL_CLICKS_MIN`) so a fresh boost never reads like a small number. A failed count shows no line.
- The picker asks only for what it shows: the wallet's own Base launches through `GET /api/launch/list?launcher=0x…`, trending kept a minute across opens. A token an admin keeps out of the lane says "Not shown in the lane" in the picker instead of sending the visitor to a page with no Boost button.

## Views and clicks

The lane counts how often it is seen and how often its cards are opened, to tell whether a place in it brings visitors. **Each card shows its clicks** of the last 24 hours (the window its TWIG is counted in) with a pointer icon, once it has one: nothing at 0, so a fresh boost never reads "0", and the number rolls up when a poll brings more. /admin has every figure (a "Views and clicks" table under the Boosted lane, 24 h / 7 d / 30 d). Nothing in the ranking reads them (`boost-ui.test.ts`). Views are not on the cards: one page load is a view for every card in the lane, so they would read nearly the same on all five.

- **A view** is a page load that brought the lane, with cards in it, a third on screen: one beacon per page, and the server adds 1 to this hour of every token in the lane then (`bb_boost_views`). Views are tallied in memory and written once every 10 seconds per machine, so a busy page never queues writes on the same few rows; a restart loses at most those seconds.
- **A click** is a card opened by a click, a Cmd/Ctrl-click or a middle click. It counts **only while the token is in the lane**: the server checks the token against the same few-second lane the pages read, takes its place from there (never from the request), and a tab left open after the boost ran out counts nothing. **One click per address, token and 30-minute slot** (an IPv6 address by its /64, an IPv4 client seen through IPv6, dotted or in hex, by its IPv4 address; `boostAddress.ts`), so a reload, a double click or a script that changes its user agent counts once. People behind one shared address (an office, a mobile carrier) count once per 30 minutes: the public count leans low rather than high (`bb_boost_clicks`).
- The beacon is `POST /api/boost/seen` (`navigator.sendBeacon`, so it never holds up the navigation). **Only the site's own pages may send it:** a request whose `Sec-Fetch-Site` is not `same-origin` (or, without that header, whose `Origin` is another host) gets a 403, so another site cannot raise a card's count from its own visitors' browsers. Bots are skipped, each IP has 60 a minute, the body is capped at 512 bytes, and the answer is a 204 otherwise.
- Click rows are kept 90 days (each names a visitor of one day; /admin reads 30 at most) and pruned hourly. View rows are plain hourly counts and stay.
- **Nothing names a person.** The visitor is a hash of the address (an IPv6 one by its /64) with the daily presence salt (`presence.ts`), no user agent, mixed with the token and cut short: it changes every UTC day and cannot link one address's clicks on two tokens. No IP, user agent or wallet is stored. "Visitors" in the table is one per address per day.
- **Set `PRESENCE_SALT`** (any long random string, `fly secrets set PRESENCE_SALT=$(openssl rand -hex 32)`) so every machine salts the same way. Without it each machine draws its own salt at start, so a repeat click that lands on the other machine counts again, and a restart starts new visitors (the site's visit counter has the same gap).
- The per-address limit (60 a minute) is kept per machine, and the address is the same /64 key, so changing addresses inside one's own IPv6 block buys no fresh bucket.
- The lane's own read (`GET /api/boost`, the live poll) carries each card's `clicks`; a failed click read shows no counts and never fails the lane. While a deploy rolls, a poll from a machine on the older build has no `clicks`, and the cards simply show none.
- `GET /api/boost/stats?days=1|7|30` serves the table to an admin session ([admin.md](admin.md)): per token, views, clicks, visitors, the click rate, and the TWIG burned for it in the period with the clicks per 100K TWIG. Views, clicks and burns start at the same whole hour. The top 100 tokens are listed and the totals cover all of them; visitors have no total, since a visitor is counted per token.

Only many addresses can add many clicks: one address adds at most one per card every 30 minutes. The count is a guide, not a payout, and nothing is paid or ranked on it.

## The dialog

On a Base token page (or from **Boost** on a launch in /me, which opens it there): whole TWIG only, presets 100K / 300K / 1M / 5M, the balance, Max (tag included), an estimate in dollars at today's TWIG price, and the last digits the amount will carry. It states plainly that the TWIG goes to 0x…dEaD, cannot be undone or refunded, and counts toward the token's place in the lane for 24 hours without changing the ranking. When the lane is full and the amount would leave the token under the 5th place, the dialog says so before anything is sent and offers the amount that would show it now. The done screen names the token's place, or says it is not in the lane yet, and offers **Share on X**: the booster's own post, prefilled with what was sent and where it went ("Boosted $SYM with 1M TWIG on openlaunch.lol. The TWIG went to 0x…dEaD."), the token's page as its link and `via @openlaunch_lol` (`boostShareUrl`, the same x.com intent as the token page's Share). Nothing about price; the words pass the same test as the rest.

Writes follow the trade panel: a synchronous lock before the first await, a network switch to Base if needed, a simulation of the exact transfer, then the wallet. **Sent means sent:** once the wallet returns a hash, only a receipt ends the action. A receipt that cannot be read leaves the dialog unconfirmed and locked, with "Check again" and the transaction link; the token page keeps that lock if the dialog is closed and reopened. A reload forgets it, so the copy says to check the wallet's activity before sending again.

## Moderation

ADMIN_WALLETS can hide a token from the lane on /admin (or show it again by address), signed in there ([admin.md](admin.md)). The signed moderation answer carries the lane read fresh (both few-second caches skipped), so the panel is right at once, whichever machine its next read reaches. No public read skips the caches: a wallet named in a URL proves nothing. Pages and polls keep reading the cached lane, so a hidden card can stay on an open page for up to about 10 seconds. Each action is an admin-wallet signature over a boost-specific message (`openlaunch.lol boosted lane`, the action, `base:<token>`, the admin, a single-use nonce, a time within 5 minutes), so a posts signature can never be replayed here. Hidden is a flag in `bb_token_settings.boost_hidden`. Burns already sent stay recorded and are never refunded. A hidden token's page says it is not shown in the lane and offers no button, so nobody burns TWIG for a place it cannot get.

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

Lane views and clicks per week:

```sql
SELECT wk, sum(views) AS views, sum(clicks) AS clicks, round(100.0 * sum(clicks) / NULLIF(sum(views), 0), 1) AS click_pct FROM (
  SELECT date_trunc('week', hour_at) AS wk, views, 0 AS clicks FROM bb_boost_views WHERE chain_id = 8453
  UNION ALL
  SELECT date_trunc('week', clicked_at), 0, 1 FROM bb_boost_clicks WHERE chain_id = 8453
) x GROUP BY wk ORDER BY wk DESC;
```
