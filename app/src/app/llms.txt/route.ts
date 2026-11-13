import { SITE_URL, explorerAddress } from "@/lib/chainPublic";
import { launchpad } from "@/lib/launchpad/config";
import { BRAND_DOMAIN, BRAND_GITHUB } from "@/lib/brand";
import { boostEnabled } from "@/lib/launchpad/boostServer";
import { BOOST_FLOOR_TWIG, BOOST_TOKEN, BOOST_WINDOW_H } from "@/lib/launchpad/boost";
import { applicationsOpen } from "@/lib/launchpad/pairApplyServer";
import { PAIR_CHAINS, PAIR_CHAINS_TEXT } from "@/lib/launchpad/pairs";

/** How to apply for a community pair, only while applications are open: an agent must never burn for one that cannot exist yet. */
function pairApplySection(): string {
  if (!applicationsOpen()) return "";
  return `Listing is applied for at /pairs/apply (a free check, then a fee in TWIG on Base, whichever chain the token is on, sent to 0x…dEaD naming the
application: amount = whole TWIG × 10^18 + 3 × 10^11 + application id; it pays for a review, not a listing, and is not refunded). Rules: https://github.com/Twigpine/openlaunch/blob/main/docs/pairs.md
`;
}

/** The Boost section, only while the switch is on (boost.ts holds the rule). */
function boostSection(): string {
  if (!boostEnabled()) return "";
  return `
## Boost (Base, optional, paid in TWIG)
A separate "Boosted" lane on the home page: the 5 tokens with the most TWIG sent to 0x000000000000000000000000000000000000dEaD for them in the last ${BOOST_WINDOW_H}h.
It is not part of the ranking: sort=live and the Trending board count outside wallets only. Nothing is paid to openlaunch.
To boost a launch: TWIG (${BOOST_TOKEN}).transfer(0x…dEaD, amount) with amount = whole * 10^18 + token_id
(whole = a count of whole TWIG, at least ${BOOST_FLOOR_TWIG}; token_id = the launch's position id, the list API's token_id field,
greater than 0 and less than 10^11). The last 12 digits name the launch; a transfer outside these bounds is not a boost.
Then POST ${SITE_URL}/api/launch/sync?chain=base&tx=0x… to show it at once. Burns are final.
- GET  ${SITE_URL}/api/boost?chain=base                (the lane: twig, boosts, last_at, expires_at, clicks, top_booster, launch; names)
- GET  ${SITE_URL}/api/boost?chain=base&token=0x…      (one token: twig in the window, place, hidden)
`;
}

export const dynamic = "force-dynamic";

/** One "- <chain>: …" line per chain; links only for deployed contracts (factory / locker are nullable until configured). */
function verificationLine(label: string, c: { factory: string | null; locker: string | null }, verifiers: [string, (a: string) => string][]): string {
  if (!c.factory && !c.locker) return `- ${label}: (not deployed yet)`;
  const parts = verifiers.map(([name, url]) => {
    const links = [c.factory ? `${url(c.factory)} (factory)` : null, c.locker ? `${url(c.locker)} (locker)` : null].filter(Boolean).join(", ");
    return `${name} ${links}`;
  });
  return `- ${label}: ${parts.join("; ")}`;
}

/** Serve the plain-text agent reference, including chain deployments, API parameters and browsing rules. */
export function GET() {
  const b = launchpad("base");
  const r = launchpad("robinhood");
  const a = launchpad("arc");
  const e = launchpad("elysium");
  const body = `# ${BRAND_DOMAIN}

> openlaunch (${BRAND_DOMAIN}) is an open-source (MIT: ${BRAND_GITHUB}), zero-fee token launchpad on Base (8453), Robinhood Chain (4663), Arc (5042) and Elysium (99901). One transaction deploys a token and locks 100% of its supply as
> Uniswap v4 liquidity, forever. No platform fee: the factory and locker have no fee address at all. About page: ${SITE_URL}/about

## Source verification
${verificationLine("Base (8453)", b, [
  ["Basescan", (a) => `https://basescan.org/address/${a}#code`],
  ["Blockscout", (a) => `https://base.blockscout.com/address/${a}?tab=contract`],
  ["Sourcify", (a) => `https://repo.sourcify.dev/8453/${a}`],
])}
${verificationLine("Robinhood Chain (4663)", r, [
  ["Blockscout", (a) => `https://robinhoodchain.blockscout.com/address/${a}?tab=contract`],
  ["Sourcify", (a) => `https://repo.sourcify.dev/4663/${a}`],
])}
${verificationLine("Arc (5042)", a, [
  ["Arc Explorer", (x) => `https://explorer.arc.io/address/${x}?tab=contract`],
  ["Sourcify", (x) => `https://repo.sourcify.dev/5042/${x}`],
])}
${verificationLine("Elysium (99901)", e, [
  ["Elysium Explorer", (x) => explorerAddress("elysium", x)],
])}

## What a launch does
1. deploys a fixed-supply ERC-20 (1,000,000,000; no mint/pause/blacklist/tax/owner)
2. initializes a Uniswap v4 pool quote/token (quote = ETH, USDG on Robinhood Chain, USDC on Arc, HYPE or USDC on Elysium, or a registry stock token, all in the form; also TWIG, GITLAWB, USDC or WETH on Base and GITLAWB on Robinhood Chain, priced but not in the form; tick spacing 200, no hook) at the chosen start tick
3. mints one single-sided position holding 100% of supply to an ownerless locker (no withdraw path exists)
4. registers fee routing: lpFee 0 | 10000 (1%) | 30000 (3%) pips; recipients [] = fees burned,
   else {payout,bps}[] summing to 10000. Fixed forever.
Anyone may call locker.collect(tokenId): accrued fees are paid straight to recipients (or burned).

## Contracts
Base (8453):            LaunchFactory ${b.factory ?? "(not deployed yet)"} · LaunchLocker ${b.locker ?? "(not deployed yet)"}
Robinhood Chain (4663): LaunchFactory ${r.factory ?? "(not deployed yet)"} · LaunchLocker ${r.locker ?? "(not deployed yet)"}
Arc (5042):             LaunchFactory ${a.factory ?? "(not deployed yet)"} · LaunchLocker ${a.locker ?? "(not deployed yet)"}
Elysium (99901):        LaunchFactory ${e.factory ?? "(not deployed yet)"} · LaunchLocker ${e.locker ?? "(not deployed yet)"}
Uniswap v4: Base PoolManager 0x498581fF718922c3f8e6A244956aF099B2652b2b, Universal Router 0x6fF5693b99212Da76ad316178A184AB56D299b43;
            Robinhood PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951, Universal Router 0x8876789976decbfcbbbe364623c63652db8c0904;
            Arc PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951, Universal Router 0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1;
            Elysium PoolManager 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1, Universal Router 0xa13f7611115752deb2b13813bdde16a5073e4b45
USDG (Robinhood, 6 dec): 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
USDC (Arc, 6 dec):       0x3600000000000000000000000000000000000000 (also the gas token; native balance = the same USDC at 18 decimals)
USDC (Base, 6 dec):      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (Circle's; priced at $1)
HYPE (Elysium, 18 dec):  address zero (the gas token; priced from Coinbase HYPE-USD, Hyperliquid as the fallback)
USDC (Elysium, 6 dec):   0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65 (Circle's; priced at $1)
WHYPE (Elysium, 18 dec): 0xbA876237B0F021A6c6D852d6c26E107997cC5E81 (priced at HYPE; buyers pay WHYPE, not HYPE)
WETH (Base, 18 dec):     0x4200000000000000000000000000000000000006 (priced at ETH; buyers pay WETH, not ETH)
TWIG (Base, 18 dec):     0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1 (Twigpine's token: 1:1 wrapper of GITLAWB, wrap/unwrap any time, no fee; no longer offered in the Base form, launches already paired with it keep trading; priced = GITLAWB; fees paid in TWIG, burned when recipients = [])
GITLAWB (Base, 18 dec):  0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3 (Twigpine's token; still recognised and priced on Base; fees paid in GITLAWB, burned when recipients = [])
GITLAWB (Robinhood, 18 dec): 0xd1b0d44E4f6ed940fcC7A9F59Bf30Daf62cCFe3D (LayerZero OFT of the Base token, 1:1; no longer offered in the Robinhood Chain form, launches already paired with it keep trading)

## Launch (contract call)
factory.launch((name, symbol, metadataURI, quote, supply=0, startTick, lpFee, salt, recipients))
startTick 184200 ≈ 10 ETH FDV for 1B supply (raw price = 1.0001^tick token-wei per quote unit; for USDG or USDC use ~391400 ≈ $10k FDV).
ERC20 quote: token must sort above the quote address → call factory.findSalt(launcher, baseSalt, name, symbol, 0, metadataURI, quote, 64) first.
Optional metadata: POST ${SITE_URL}/api/launch/meta {chain, launcher, salt, name, symbol, description?, image_url?, website?, x_handle?} → {uri, token}; pass uri as metadataURI. x_handle takes a handle (foo, @foo) or an x.com / twitter.com profile link; the bare handle is stored.
Recommended: buy a little right after launch (a Universal Router swap on the new pool; the site's form suggests ≈ $25). A token with no
holder and no price move reads as dead on screeners and sits under "quiet launches" on the home page until an outside wallet trades it.

${boostSection()}
## Community pairs (${PAIR_CHAINS_TEXT})
A launch may be paired with a listed community token: the site badges it and prices it in USD from one named pool (checked against
that pool's 30-minute average). The launch form does not offer them: such a launch is made against the
factory directly. The contracts accept any ERC-20 either way; an unlisted one shows as "Unlisted pair", unpriced. Each listing is
checked hourly and suspended when its checks fail.
- GET  ${SITE_URL}/api/pairs                                        (every pair: address, symbol, decimals, status, usd, price source)
Pages: /pairs, /pair/<chain>/<address> (chain: ${PAIR_CHAINS.join(" or ")}). Launch with one against the factory exactly as with any ERC-20 quote (findSalt with the pair's address).
${pairApplySection()}
## MCP (agents, read-only)
A stateless Model Context Protocol server is at ${SITE_URL}/api/mcp (Streamable HTTP, JSON response; POST JSON-RPC 2.0).
No key and no session. Tools: list_launches, get_launch, search_launches, get_token_trades, get_token_holders,
get_recent_activity, list_posts, list_community_pairs, get_points_leaderboard, get_protocol_totals. No tool writes.
Client config: {"mcpServers":{"openlaunch":{"type":"http","url":"${SITE_URL}/api/mcp"}}}
Limits: 120 requests per IP per minute, 64 KB per request; browser origins are checked. Details: ${BRAND_GITHUB}/blob/main/docs/mcp.md

## API
- GET  ${SITE_URL}/api/launch/list?chain=base|robinhood|arc|elysium&sort=live|new|mcap|volume|gainers|holders&window=1h|24h|all&limit=50
  sort=live (the home page default; "trending" is an alias): tokens an outside wallet traded in the last 24h first, ranked by outside
  wallets this hour, then today, then the last outside trade; then each launcher's newest launch under 1h old; then quiet launches, one
  row per launcher; both by age. "Outside" = not the launcher and not a swap in the sniper window (launch block + 3; a sell there can
  only be a sniper's). Rows carry traders_1h_ex / traders_24h_ex
  (those counts), last_outside_trade_at, live_tier (live|new|quiet, live sort only) and launcher_collapsed.
  sort=mcap: current fully diluted valuation (price × total supply) descending, using sqrt_price_x96 when available; unpriced rows last.
  Add mcap=filtered for the site's browsing filter: launches whose starting AND current valuations are at least $10M then need
  lifetime outside volume of at least 0.1% of starting FDV and at least 3 outside wallets with $1 cumulative volume each. Outside
  excludes creator, unknown and launch-block+3 trades. Both dollar valuations use the current quote/USD price; volume/FDV is compared
  in quote units. Small launches need no trades. Without it (or with mcap=all) every valuation is listed, as before. Other sorts and
  search are unaffected. Responses carry mcap (filtered|all), mcap_policy=1,
  and per-row mcap classification and supporting facts (outside stats are null when not assessed). This is a browsing filter, not verification.
- GET  ${SITE_URL}/api/launch/feed
- GET  ${SITE_URL}/api/launch/meta/<token>
- POST ${SITE_URL}/api/launch/sync?chain=base|robinhood|arc|elysium&tx=0x…   (index a tx you just sent)
- GET  ${SITE_URL}/api/health
Pages: / (list, ?chain=), /launch (?chain=), /t/<chain>/<token> (trade + fees), /rules, /agents.
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
