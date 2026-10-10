import { SITE_URL } from "@/lib/chainPublic";
import { launchpad } from "@/lib/launchpad/config";
import { BRAND_DOMAIN, BRAND_GITHUB } from "@/lib/brand";

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

export function GET() {
  const b = launchpad("base");
  const r = launchpad("robinhood");
  const a = launchpad("arc");
  const body = `# ${BRAND_DOMAIN}

> openlaunch (${BRAND_DOMAIN}) is an open-source (MIT: ${BRAND_GITHUB}), zero-fee token launchpad on Base (8453), Robinhood Chain (4663) and Arc (5042). One transaction deploys a token and locks 100% of its supply as
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

## What a launch does
1. deploys a fixed-supply ERC-20 (1,000,000,000; no mint/pause/blacklist/tax/owner)
2. initializes a Uniswap v4 pool quote/token (quote = ETH, TWIG on Base, GITLAWB, USDG on Robinhood Chain, USDC on Arc, or a registry stock token; tick spacing 200; legacy pools have no hook) at the chosen start tick
3. mints one single-sided position holding 100% of supply to an ownerless locker (no withdraw path exists)
4. registers fee routing: lpFee 0 | 10000 (1%) | 30000 (3%) pips; recipients [] = fees burned,
   else {payout,bps}[] summing to 10000. Fixed forever.
Anyone may call locker.collect(tokenId): accrued fees are paid straight to recipients (or burned).
Optional quote-v2 suite: creatorFeePips replaces lpFee in the launch tuple; actual pool LP fee is 0 with an immutable quote fee hook. Quote fees accrue on buys and sells. Use the recorded factory and pool key; collect from the recorded vault with collect(tokenId), claim credits with claim(tokenId). Rows expose suite_id, fee_asset_mode, factory_address, locker_address, fee_contract_address, hook_address, pool_fee_pips and creator_fee_pips. Metadata requests include suite_id=quote-v2 for that suite.

## Contracts
Base (8453):            LaunchFactory ${b.factory ?? "(not deployed yet)"} · LaunchLocker ${b.locker ?? "(not deployed yet)"}
Robinhood Chain (4663): LaunchFactory ${r.factory ?? "(not deployed yet)"} · LaunchLocker ${r.locker ?? "(not deployed yet)"}
Arc (5042):             LaunchFactory ${a.factory ?? "(not deployed yet)"} · LaunchLocker ${a.locker ?? "(not deployed yet)"}
Uniswap v4: Base PoolManager 0x498581fF718922c3f8e6A244956aF099B2652b2b, Universal Router 0x6fF5693b99212Da76ad316178A184AB56D299b43;
            Robinhood PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951, Universal Router 0x8876789976decbfcbbbe364623c63652db8c0904;
            Arc PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951, Universal Router 0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1
USDG (Robinhood, 6 dec): 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
USDC (Arc, 6 dec):       0x3600000000000000000000000000000000000000 (also the gas token; native balance = the same USDC at 18 decimals)
TWIG (Base, 18 dec):     0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1 (Twigpine's token: 1:1 wrapper of GITLAWB, wrap/unwrap any time, no fee; the Base form's quote; priced = GITLAWB; fees paid in TWIG, burned when recipients = [])
GITLAWB (Base, 18 dec):  0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3 (Twigpine's token; still recognised and priced on Base; fees paid in GITLAWB, burned when recipients = [])
GITLAWB (Robinhood, 18 dec): 0xd1b0d44E4f6ed940fcC7A9F59Bf30Daf62cCFe3D (LayerZero OFT of the Base token, 1:1)

## Launch (contract call)
factory.launch((name, symbol, metadataURI, quote, supply=0, startTick, lpFee, salt, recipients))
startTick 184200 ≈ 10 ETH FDV for 1B supply (raw price = 1.0001^tick token-wei per quote unit; for USDG or USDC use ~391400 ≈ $10k FDV).
ERC20 quote: token must sort above the quote address → call factory.findSalt(launcher, baseSalt, name, symbol, 0, metadataURI, quote, 64) first.
Optional metadata: POST ${SITE_URL}/api/launch/meta {chain, launcher, salt, name, symbol, description?, image_url?, website?, x_handle?} → {uri, token}; pass uri as metadataURI. x_handle takes a handle (foo, @foo) or an x.com / twitter.com profile link; the bare handle is stored.
Recommended: buy a little right after launch (a Universal Router swap on the new pool; the site's form suggests ≈ $25). A token with no
holder and no price move reads as dead on screeners and sits under "quiet launches" on the home page until an outside wallet trades it.

## API
- GET  ${SITE_URL}/api/launch/list?chain=base|robinhood|arc&sort=live|new|mcap|volume|gainers|holders&window=1h|24h|all&limit=50
  sort=live (the home page default; "trending" is an alias): tokens an outside wallet traded in the last 24h first, ranked by outside
  wallets this hour, then today, then the last outside trade; then each launcher's newest launch under 1h old; then quiet launches, one
  row per launcher; both by age. "Outside" = not the launcher and not a swap in the sniper window (launch block + 3; a sell there can
  only be a sniper's). Rows carry traders_1h_ex / traders_24h_ex
  (those counts), last_outside_trade_at, live_tier (live|new|quiet, live sort only) and launcher_collapsed.
- GET  ${SITE_URL}/api/launch/feed
- GET  ${SITE_URL}/api/launch/meta/<token>
- POST ${SITE_URL}/api/launch/sync?chain=base|robinhood|arc&tx=0x…   (index a tx you just sent)
- GET  ${SITE_URL}/api/health
Pages: / (list, ?chain=), /launch (?chain=), /t/<chain>/<token> (trade + fees), /rules, /agents.
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
