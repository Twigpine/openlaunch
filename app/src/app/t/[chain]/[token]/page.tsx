import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isAddress, type Address } from "viem";
import { ArrowLeft, ArrowUpRight, Globe, Share2 } from "lucide-react";
import TokenAvatar from "@/components/launchpad/TokenAvatar";
import { MorphAvatar, MorphName } from "@/components/launchpad/TokenMorph";
import { feeModeOf } from "@/components/launchpad/FeeChip";
import TradePanel from "@/components/launchpad/TradePanel";
import CollectPanel from "@/components/launchpad/CollectPanel";
import CopyChip from "@/components/launchpad/CopyChip";
import MobileBuyBar from "@/components/launchpad/MobileBuyBar";
import TokenChart from "@/components/launchpad/TokenChart";
import TokenComments from "@/components/launchpad/Posts";
import ChangeChip from "@/components/launchpad/ChangeChip";
import HoldersPanel from "@/components/launchpad/HoldersPanel";
import TokenDetails from "@/components/launchpad/TokenDetails";
import TokenTrades from "@/components/launchpad/TokenTrades";
import LaunchReceipt from "@/components/launchpad/LaunchReceipt";
import TokenAbout from "@/components/launchpad/TokenAbout";
import { getHolderPanel } from "@/lib/launchpad/holdersServer";
import { memo } from "@/lib/launchpad/memo";
import { ago, nowMs } from "@/lib/launchpad/time";
import { getLaunch, getSwaps } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { NATIVE, SWAP_SITES, TICK_SPACING, type Quote } from "@/lib/launchpad/config";
import UnlistedPairBadge from "@/components/launchpad/UnlistedPairBadge";
import { GITLAWB_SITE } from "@/lib/launchpad/gitlawb";
import GitlawbBadge from "@/components/launchpad/GitlawbBadge";
import TwigBadge from "@/components/launchpad/TwigBadge";
import { TWIG_SITE, TWIG_WRAP_URL } from "@/lib/launchpad/twig";
import MuseworldBadge from "@/components/launchpad/MuseworldBadge";
import { MUSEWORLD_SITE } from "@/lib/launchpad/museworld";
import { fmtCompact, fmtPrice, fmtQuote, fmtUsd, pipsToPct } from "@/lib/launchpad/math";
import { marketCount as count } from "@/lib/launchpad/token-market";
import { marketUsd } from "@/lib/launchpad/market-format";
import { CHAIN_LABELS, SITE_URL, chainIdOf, explorerAddress, explorerName, explorerTx, isChainKey, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { jsonLdHtml, tokenCanonical } from "@/lib/seo";
import { stockByAddress } from "@/lib/launchpad/stocksServer";
import { BRAND_DOMAIN, BRAND_X } from "@/lib/brand";
import { clampSocial } from "@/lib/launchpad/ogcard";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { launchpad } from "@/lib/launchpad/config";
import { tokenTint } from "@/lib/launchpad/tintServer";
import { proofFacts } from "@/lib/launchpad/proof";
import TokenProof, { type ProofLink } from "@/components/launchpad/TokenProof";
import WatchButton from "@/components/launchpad/WatchButton";
import { BorderBeam } from "@/components/vendor/border-beam";
import { Banner } from "@/components/launchpad/LaunchCard";
import { ChainLogo } from "@/components/launchpad/ChainLogo";
import type { ProofKey } from "@/lib/launchpad/proof";

/** Where GITLAWB lives, as said beside a GITLAWB-quoted pool. */
const GITLAWB_ORIGIN: Record<ChainKey, string> = { base: " on Base", robinhood: " (bridged 1:1 from Base over LayerZero; one supply, two chains)", arc: "" /* not bridged to Arc */ };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ chain: string; token: string }> }): Promise<Metadata> {
  const { chain, token } = await params;
  const l = isChainKey(chain) && isAddress(token) ? await getLaunch(chain, token) : null;
  if (!l) return { title: "Token not found" };
  const title = `${l.name} (${l.symbol})`;
  const description = clampSocial(l.description ?? `${l.name} launched on openlaunch.lol. 100% of supply locked as Uniswap v4 liquidity on ${CHAIN_LABELS[l.chain]}, ${l.lp_fee === 0 ? "0% trading fee" : "no platform fee"}.`, 155);
  // Next replaces nested metadata objects rather than merging them, so repeat the site-level fields here:
  // og:site_name (Discord shows it above the title) and twitter summary_large_image (full-width card).
  return {
    title,
    description,
    alternates: { canonical: tokenCanonical(SITE_URL, l.chain, l.token) },
    openGraph: { siteName: BRAND_DOMAIN, type: "website", title, description: clampSocial(description), url: `${SITE_URL}/t/${l.chain}/${l.token}` },
    twitter: { card: "summary_large_image", site: `@${BRAND_X}`, title, description: clampSocial(description) },
  };
}

export default async function TokenPage({ params }: { params: Promise<{ chain: string; token: string }> }) {
  const { chain, token } = await params;
  if (!isChainKey(chain) || !isAddress(token)) notFound();
  const usd = await ethUsd();
  const l = await getLaunch(chain, token, usd);
  if (!l) notFound();
  // the key the server resolved (a registry stock, an unlisted ERC-20), not the static list's
  const quote: Quote = {
    key: l.quote_key,
    address: l.quote as Address,
    symbol: l.quote_symbol,
    decimals: l.quote_decimals,
    usd: l.quote_usd,
    decimalsKnown: l.quote_decimals_known,
  };
  const unlisted = quote.key === "other";
  const stockQuote = quote.key === "stock" ? stockByAddress(chain, l.quote) : null;
  const [swaps, holders, tint] = await Promise.all([getSwaps(chain, l.token, quote.decimals, 40), memo(`holders:${chain}:${l.token}`, 5_000, () => getHolderPanel(chain, l.token)), tokenTint(l.image_url, l.token)]);
  const now = nowMs();
  const mode = feeModeOf(l.lp_fee, l.recipients);
  const cap = capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals });
  const proof = proofFacts({ holders, symbol: l.symbol, launcher: l.launcher, lpFee: l.lp_fee, mode, recipients: l.recipients.length });
  const locker = launchpad(chain).locker;
  const proofLinks: Partial<Record<ProofKey, ProofLink>> = {
    ...(locker ? { lock: { href: explorerAddress(chain, locker), label: "View locker", external: true } } : {}),
    creator: { href: explorerAddress(chain, l.launcher), label: "Creator wallet", external: true },
    spread: { href: "#holders", label: "All holders" },
    launch: { href: explorerTx(chain, l.tx_hash), label: "Launch transaction", external: true },
    fees: { href: "#contracts", label: "Fee settings" },
  };
  const poolKey = { currency0: l.quote as Address, currency1: l.token as Address, fee: l.lp_fee, tickSpacing: TICK_SPACING, hooks: NATIVE as Address };
  const priceUsd = l.price_usd;
  const chainLabel = CHAIN_LABELS[chain];
  const shareText = `${l.name} ($${l.symbol}) on ${chainLabel}. ${l.lp_fee === 0 ? "0% fee" : mode === "burn" ? "fees burned" : "no platform fee"}, liquidity locked forever`;

  const supplyLabel = fmtCompact(Number(BigInt(l.supply)) / 1e18, 0);
  const feeRoute = mode === "free" ? "No trading fee" : `${pipsToPct(l.lp_fee)} trading fee → ${mode === "burn" ? "burned" : mode === "split" ? "beneficiaries" : "beneficiary"}`;
  // the trade box's own wording: short, no arrow
  const tradeFee = mode === "free" ? "None" : `${pipsToPct(l.lp_fee)}, ${mode === "burn" ? "burned" : mode === "split" ? `to ${l.recipients.length} recipients` : "to the recipient"}`;
  const swapSite = SWAP_SITES[chain];
  const utility = "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-muted hover:border-line-strong hover:text-ink";
  // a chip on the cover: dark glass, so it reads over any banner in either theme (display is set where it is used)
  const glass = "h-7 shrink-0 items-center gap-1.5 rounded-full bg-black/45 px-2.5 text-[11px] font-medium text-white ring-1 ring-white/15 backdrop-blur-md";
  // one segment of the action bar; display is set per segment, so a phone-hidden one never carries two display classes
  const segment = "items-center gap-1.5 px-3 transition-colors hover:bg-ink/5 hover:text-ink focus-visible:-outline-offset-2 motion-reduce:transition-none";

  // Facts-only structured data (on-chain fields + creator metadata, no scores).
  // Escaped for the script sink: creator-supplied name/description must not
  // be able to terminate the <script> element.
  const jsonLd = jsonLdHtml({
    name: l.name,
    symbol: l.symbol,
    chain,
    chainId: chainIdOf(chain),
    token: l.token,
    launcher: l.launcher,
    quoteSymbol: quote.symbol,
    supply: l.supply,
    poolId: l.pool_id,
    startTick: l.start_tick,
    lpFee: l.lp_fee,
    blockTime: l.block_time,
    description: l.description,
    siteUrl: SITE_URL,
  });

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      {/* the token's tint (from its logo) is a CSS variable per theme: the ring, the chart line, the proof marks. Never an action colour. */}
      <div className="relative isolate overflow-x-clip [--tok:var(--tok-light)] dark:[--tok:var(--tok-dark)]" style={{ "--tok-light": tint.light, "--tok-dark": tint.dark } as React.CSSProperties}>
      <main className="bb-mid bb-page pt-5 pb-28 sm:pt-7 lg:pb-16">
        {/* The hero: the same cover the token wears on its market card (the creator's banner, else its logo's colours),
            the way back and the chain on it, and the mark over its lower edge. PendingTokenHeader holds this frame while
            the page loads, so the mark and name that morph in from the market row land in place. */}
        <header className="relative mb-6 overflow-hidden rounded-3xl border border-line bg-card">
          <div className="relative h-24 overflow-hidden sm:h-28">
            <Banner token={l.token} image={l.image_url} banner={l.banner_url} />
            {/* the cover melts into the card, so the mark and the name read on one surface */}
            <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-3/4 bg-linear-to-b from-transparent via-card/50 to-card" />
            <nav aria-label="Breadcrumb" className="absolute inset-x-3 top-3 flex items-center justify-between gap-2 sm:inset-x-4 sm:top-4">
              <Link href="/#launches" className={`inline-flex ${glass} transition-colors hover:bg-black/60 motion-reduce:transition-none`}><ArrowLeft size={13} aria-hidden="true" /> All launches</Link>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`inline-flex ${glass}`}><ChainLogo chain={chain} size={14} />{chainLabel}</span>
                <span className={`hidden sm:inline-flex ${glass}`}>Uniswap v4</span>
              </span>
            </nav>
          </div>
          <div className="grid gap-x-8 gap-y-4 px-4 pb-5 sm:px-6 sm:pb-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="flex min-w-0 items-start gap-4">
              {/* the ring takes the tint; the mark and name inside are what the market row morphs into (see TokenMorph) */}
              <span className="relative -mt-11 shrink-0 rounded-[22px] border-2 bg-card p-[3px] shadow-[0_10px_28px_-12px_rgb(0_0_0/0.55)] sm:-mt-12" style={{ borderColor: "var(--tok)" }}>
                <MorphAvatar chain={l.chain} token={l.token}>
                  <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={72} className="shrink-0 rounded-2xl" />
                </MorphAvatar>
              </span>
              <div className="min-w-0 pt-2">
                <MorphName chain={l.chain} token={l.token}>
                  <h1 className="break-words font-display text-2xl font-bold tracking-[-0.03em] text-ink sm:text-3xl">{l.name}</h1>
                </MorphName>
                {/* the chain is on the cover; here the ticker, the pair and the age. Phones wrap these, so they drop the dots that would dangle at a line's end. */}
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted sm:gap-x-1.5">
                  <span className="font-mono text-body">{l.symbol}</span>
                  <span aria-hidden="true" className="max-sm:hidden">·</span>
                  {quote.key === "twig" ? <TwigBadge label="Paired with TWIG" /> : quote.key === "gitlawb" ? <GitlawbBadge label="Paired with GITLAWB" /> : quote.key === "museworld" ? <MuseworldBadge label="Paired with MUSEWORLD" /> : <span>paired with {quote.symbol}</span>}
                  {unlisted ? <UnlistedPairBadge symbol={quote.symbol} /> : null}
                  <span aria-hidden="true" className="max-sm:hidden">·</span>
                  <span title={new Date(l.block_time).toUTCString()}>launched {ago(l.block_time, now)} ago</span>
                </p>
              </div>
            </div>
            <div className="md:row-span-2 md:text-right">
              <p className="text-xs text-muted">Market cap</p>
              <p className="mt-1 font-mono text-3xl font-bold tracking-[-0.03em] text-ink tnum sm:text-4xl" title={cap.usd !== null ? fmtUsd(cap.usd) : cap.main}>{cap.main}</p>
              <p className="mt-1 font-mono text-[11px] text-muted tnum">{cap.detail}</p>
              <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted md:justify-end">
                <span className="text-sm"><ChangeChip v={l.change_from_launch} plain /> <span className="text-muted">since launch</span></span>
                <span aria-hidden="true">·</span>
                <span><span className="font-mono text-body tnum">{l.holders.toLocaleString("en-US")}</span> holders, <span className="font-mono text-body tnum">{(l.buys + l.sells).toLocaleString("en-US")}</span> trades</span>
              </p>
            </div>
            <div className="flex max-w-full flex-wrap items-center gap-2">
              <WatchButton token={{ chain, token: l.token, name: l.name, symbol: l.symbol }} labelled />
              {/* the token's links as one bar, the Watch button's height: share, copy the address, the explorer */}
              <div className="inline-flex h-10 max-w-full items-stretch overflow-hidden rounded-xl border border-line bg-card text-xs font-medium text-body sm:h-9">
                <a href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(`${SITE_URL}/t/${chain}/${l.token}`)}`} target="_blank" rel="noreferrer" className={`inline-flex ${segment}`} aria-label="Share token on X"><Share2 size={13} aria-hidden="true" /><span className="hidden sm:inline">Share</span></a>
                <CopyChip value={l.token} className={`inline-flex ${segment} border-l border-line font-code`} />
                {/* phones keep one row of actions; the explorer link is also in About & contracts */}
                <a href={explorerAddress(chain, l.token)} target="_blank" rel="noreferrer" className={`hidden sm:inline-flex ${segment} border-l border-line`}>{explorerName(chain)}<ArrowUpRight size={13} aria-hidden="true" /></a>
              </div>
            </div>
          </div>
        </header>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_23.75rem] lg:gap-6 lg:grid-rows-[min-content_1fr]">
          <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1">
            <TokenChart chain={chain} token={l.token} symbol={l.symbol} poolId={l.pool_id} quote={l.quote} launchedAt={l.block_time} hasTrades={l.buys + l.sells > 0} />
            {/* hairlines between the cells come from the gap over a line-coloured grid, so they hold in both layouts */}
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-4">
              <Stat k="Price" v={priceUsd !== null ? fmtUsd(priceUsd) : `${fmtPrice(l.price_quote)} ${quote.symbol}`} sub={`${fmtPrice(l.price_quote)} ${quote.symbol}`} />
              <Stat k="24h volume" v={l.volume_24h_usd !== null ? marketUsd(l.volume_24h_usd) : fmtQuote(l.volume_24h, quote.decimals, quote.symbol)} sub={fmtQuote(l.volume_24h, quote.decimals, quote.symbol)} />
              <Stat k="Total volume" v={l.volume_usd !== null ? marketUsd(l.volume_usd) : fmtQuote(l.volume_quote, quote.decimals, quote.symbol)} sub={fmtQuote(l.volume_quote, quote.decimals, quote.symbol)} />
              <Stat k="Buys and sells" v={<><span className="text-up">{count(l.buys)}</span><span className="px-1 text-faint">/</span><span className="text-down-ink">{count(l.sells)}</span></>} sub={`${count(l.buys + l.sells)} trades`}>
                <BuySellBar buys={l.buys} sells={l.sells} />
              </Stat>
            </dl>
            <TokenProof facts={proof.facts} holdersReady={proof.holdersReady} links={proofLinks} bar={proof.holdersReady && holders ? { top10Bps: holders.top10Bps, poolBps: holders.poolBps } : null} />
          </div>

          <aside className="min-w-0 space-y-4 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            {/* a beam in the token's colour travels the trade box border; the box itself keeps the action colours */}
            <div className="relative rounded-2xl">
              <TradePanel chain={chain} token={l.token as Address} symbol={l.symbol} poolKey={poolKey} poolId={l.pool_id as `0x${string}`} feeRoute={tradeFee} quote={quote} ethUsd={usd} />
              <BorderBeam size={120} duration={9} colorFrom="var(--tok)" colorTo="var(--tok)" />
            </div>
            {/* the token at a glance beside the trade box, as other launchpads keep it; the full record is in the About tab */}
            <TokenAbout chain={chain} token={l.token} symbol={l.symbol} description={l.description} website={l.website} x_handle={l.x_handle} launcher={l.launcher} launchedAt={l.block_time} now={now} swap={swapSite ? { name: swapSite.name, url: swapSite.url(l.token) } : null} />
            <LaunchReceipt chain={chain} symbol={l.symbol} supply={supplyLabel} txHash={l.tx_hash} />
            <CollectPanel chain={chain} quote={quote} token={l.token as Address} tokenId={l.token_id} symbol={l.symbol} lpFee={l.lp_fee} recipients={l.recipients} collectedQuote={l.fees_quote_collected} collectedToken={l.fees_token_collected} burnedQuote={l.fees_quote_burned} burnedToken={l.fees_token_burned} priceQuote={l.price_quote} ethUsd={usd} />
          </aside>

          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <TokenDetails
              trades={<TokenTrades chain={chain} symbol={l.symbol} quote={quote} swaps={swaps} now={now} />}
              holders={<HoldersPanel chain={chain} symbol={l.symbol} p={holders} embedded />}
              conversation={<TokenComments chain={chain} token={l.token} symbol={l.symbol} launcher={l.launcher} embedded />}
              about={<section className="p-5">
                <h2 className="text-base font-semibold text-ink">Behind {l.symbol}</h2>
                <p className="mt-2 max-w-xl whitespace-pre-wrap break-words text-sm leading-relaxed text-body text-pretty">{l.description || "The creator has not added a description yet. The contract details below are recorded on-chain."}</p>
                {l.website || l.x_handle || swapSite ? <div className="mt-4 flex flex-wrap gap-2">
                  {l.website ? <a href={l.website} target="_blank" rel="noreferrer nofollow" className={utility}><Globe size={13} /> Website ↗</a> : null}
                  {l.x_handle ? <a href={`https://x.com/${l.x_handle}`} target="_blank" rel="noreferrer nofollow" className={utility}>@{l.x_handle} ↗</a> : null}
                  {swapSite ? <a href={swapSite.url(l.token)} target="_blank" rel="noreferrer" className={utility}>Open in {swapSite.name} ↗</a> : null}
                </div> : null}
                <dl className="mt-5 divide-y divide-line border-y border-line text-xs">
                  <Row k="Creator" v={<A href={explorerAddress(chain, l.launcher)}>{shortAddr(l.launcher)} ↗</A>} />
                  <Row k="Token contract" v={<A href={explorerAddress(chain, l.token)}>{shortAddr(l.token)} ↗</A>} />
                  <Row k="Launch transaction" v={<A href={explorerTx(chain, l.tx_hash)}>{shortAddr(l.tx_hash)} ↗</A>} />
                  <Row k="Pool ID" v={<CopyChip value={l.pool_id} />} />
                  <Row k="Market" v={`${quote.symbol} / ${l.symbol} · Uniswap v4 · no hook`} />
                  {unlisted ? <Row k="Pair token" v={<A href={explorerAddress(chain, l.quote)}>{shortAddr(l.quote)} ↗</A>} /> : null}
                  <Row k="Trading fee" v={feeRoute} />
                  <Row k="Fixed supply" v={`${supplyLabel} ${l.symbol}`} />
                  <Row k="Launched" v={new Date(l.block_time).toUTCString().replace(" GMT", " UTC")} />
                </dl>
                {unlisted ? <p className="mt-4 text-xs leading-relaxed text-muted text-pretty">Paired with {quote.symbol}, a token openlaunch does not list. The launch contracts accept any ERC-20 as the pair; its name here is what its own contract reports, so check the pair token address above. Prices are in {quote.symbol} only, with no USD figure, and this launch is not ranked in Trending.</p> : null}
                {quote.key === "museworld" ? <p className="mt-4 text-xs leading-relaxed text-muted text-pretty">Paired with MUSEWORLD, the official token of <a href={MUSEWORLD_SITE} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">Museworld</a>, where AI agents launch their tokens. {mode === "free" ? "This pool has no trading fee." : mode === "burn" ? "Trading fees on this pool are burned as MUSEWORLD when collected." : "Trading fees on this pool are paid out in MUSEWORLD."} USD figures use the MUSEWORLD/GITLAWB pool on openlaunch (checked against its 30-minute average) and GITLAWB&apos;s own price.</p> : null}
                {stockQuote ? <p className="mt-4 text-xs leading-relaxed text-muted text-pretty">Paired with {stockQuote.name} ({stockQuote.symbol}), a third-party tokenized stock. These securities are not offered to US persons. The quote asset is identified from the issuer registry, not its token name.</p> : null}
                {quote.key === "twig" ? <p className="mt-4 text-xs leading-relaxed text-muted text-pretty">Paired with TWIG, <a href={TWIG_SITE} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">Twigpine</a>&apos;s token on Base: a 1:1 wrapper of GITLAWB that anyone can wrap or unwrap at <a href={TWIG_WRAP_URL} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">wrap.twigpine.com</a>, with no fee. {mode === "free" ? "This pool has no trading fee." : mode === "burn" ? "Trading fees on this pool are burned as TWIG when collected." : "Trading fees on this pool are paid out in TWIG."} USD figures use GITLAWB&apos;s price (one TWIG unwraps to one GITLAWB), from the Uniswap v4 WETH/GITLAWB pool on Base.</p> : null}
                {quote.key === "gitlawb" ? <p className="mt-4 text-xs leading-relaxed text-muted text-pretty">Paired with GITLAWB, <a href={GITLAWB_SITE} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">Gitlawb</a>&apos;s token{GITLAWB_ORIGIN[chain]}. {mode === "free" ? "This pool has no trading fee." : mode === "burn" ? "Trading fees on this pool are burned as GITLAWB when collected." : "Trading fees on this pool are paid out in GITLAWB."} USD figures use the Uniswap v4 WETH/GITLAWB pool price on Base.</p> : null}
              </section>}
            />
          </div>
        </div>
      </main>
      </div>
      <MobileBuyBar symbol={l.symbol} mcap={cap.compact} />
    </>
  );
}

function Stat({ k, v, sub, children }: { k: string; v: React.ReactNode; sub: string; children?: React.ReactNode }) {
  return <div className="min-w-0 bg-card px-4 py-3.5"><dt className="text-[11px] text-muted">{k}</dt><dd className="mt-1.5 truncate font-mono text-[15px] font-bold tracking-tight text-ink tnum">{v}</dd><dd className="mt-1 truncate font-mono text-[10px] text-muted tnum" title={sub}>{sub}</dd>{children}</div>;
}
/** Buys against sells as one thin bar; no trades draws an empty track, never an even split. */
function BuySellBar({ buys, sells }: { buys: number; sells: number }) {
  const trades = buys + sells;
  const share = trades ? Math.round((buys / trades) * 100) : 0;
  return <dd className="mt-2 flex h-1 gap-px overflow-hidden rounded-full" title={trades ? `${share}% of trades are buys` : "No trades yet"}>
    {trades ? <><span className="bg-up" style={{ width: `${(buys / trades) * 100}%` }} /><span className="flex-1 bg-down" /></> : <span className="flex-1 bg-line-strong" />}
    <span className="sr-only">{trades ? `${share}% of trades are buys` : "No trades yet"}</span>
  </dd>;
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words text-right font-mono text-body tnum">{v}</dd></div>;
}
function A({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="font-code text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">{children}</a>;
}
