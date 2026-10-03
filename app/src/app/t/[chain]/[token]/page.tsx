import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isAddress, type Address } from "viem";
import { ArrowLeft, ArrowUpRight, Globe, Share2 } from "lucide-react";
import TokenAvatar from "@/components/launchpad/TokenAvatar";
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
import { getHolderPanel } from "@/lib/launchpad/holdersServer";
import { memo } from "@/lib/launchpad/memo";
import { ago, nowMs } from "@/lib/launchpad/time";
import { getLaunch, getSwaps } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { NATIVE, SWAP_SITES, TICK_SPACING, type Quote } from "@/lib/launchpad/config";
import UnlistedPairBadge from "@/components/launchpad/UnlistedPairBadge";
import { GITLAWB_SITE } from "@/lib/launchpad/gitlawb";
import GitlawbBadge from "@/components/launchpad/GitlawbBadge";
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
  const [swaps, holders] = await Promise.all([getSwaps(chain, l.token, quote.decimals, 40), memo(`holders:${chain}:${l.token}`, 5_000, () => getHolderPanel(chain, l.token))]);
  const now = nowMs();
  const mode = feeModeOf(l.lp_fee, l.recipients);
  const poolKey = { currency0: l.quote as Address, currency1: l.token as Address, fee: l.lp_fee, tickSpacing: TICK_SPACING, hooks: NATIVE as Address };
  const priceUsd = l.price_usd;
  const chainLabel = CHAIN_LABELS[chain];
  const shareText = `${l.name} ($${l.symbol}) on ${chainLabel}. ${l.lp_fee === 0 ? "0% fee" : mode === "burn" ? "fees burned" : "no platform fee"}, liquidity locked forever`;

  const supplyLabel = fmtCompact(Number(BigInt(l.supply)) / 1e18, 0);
  const feeRoute = mode === "free" ? "No trading fee" : `${pipsToPct(l.lp_fee)} trading fee → ${mode === "burn" ? "burned" : mode === "split" ? "beneficiaries" : "beneficiary"}`;
  const swapSite = SWAP_SITES[chain];
  const utility = "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-muted hover:border-line-strong hover:text-ink";

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
      <main className="mx-auto max-w-6xl px-4 pt-5 pb-28 sm:pt-7 lg:pb-16">
        <nav aria-label="Breadcrumb" className="mb-5 flex min-h-8 items-center justify-between gap-3 text-xs text-muted">
          <Link href="/#launches" className="inline-flex items-center gap-2 hover:text-ink"><ArrowLeft size={13} /> All launches</Link>
          <span className="flex items-center gap-2"><span>{chainLabel}</span><span aria-hidden>·</span><span>Uniswap v4</span></span>
        </nav>

        <header className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={56} className="shrink-0 rounded-2xl" />
            <div className="min-w-0">
              <h1 className="break-words font-display text-2xl font-bold tracking-[-0.03em] text-ink sm:text-3xl">{l.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted"><span className="font-mono text-body">${l.symbol}</span><span aria-hidden>·</span>{quote.key === "gitlawb" ? <GitlawbBadge label="Paired with GITLAWB" /> : quote.key === "museworld" ? <MuseworldBadge label="Paired with MUSEWORLD" /> : <span>Paired with {quote.symbol}</span>}{unlisted ? <UnlistedPairBadge symbol={quote.symbol} /> : null}<span aria-hidden>·</span><span title={new Date(l.block_time).toUTCString()}>Launched {ago(l.block_time, now)} ago</span></div>
            </div>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <CopyChip value={l.token} className="!min-h-9 !rounded-lg" />
            <a href={explorerAddress(chain, l.token)} target="_blank" rel="noreferrer" className={utility}>{explorerName(chain)}<ArrowUpRight size={12} /></a>
            <a href={`https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(`${SITE_URL}/t/${chain}/${l.token}`)}`} target="_blank" rel="noreferrer" className={utility} aria-label="Share token on X"><Share2 size={13} /> Share</a>
          </div>
        </header>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-6 lg:grid-rows-[min-content_1fr]">
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">
            <TokenChart chain={chain} token={l.token} symbol={l.symbol} poolId={l.pool_id} quote={l.quote} launchedAt={l.block_time} hasTrades={l.buys + l.sells > 0} />
            <dl className="mt-4 grid grid-cols-2 divide-x divide-line overflow-hidden rounded-xl border border-line bg-card sm:grid-cols-4">
              <Stat k={priceUsd !== null ? "Price / USD" : `Price / ${quote.symbol}`} v={priceUsd !== null ? fmtUsd(priceUsd) : `${fmtPrice(l.price_quote)} ${quote.symbol}`} sub={`${fmtPrice(l.price_quote)} ${quote.symbol}`} />
              <Stat k="Volume / all time" v={l.volume_usd !== null ? marketUsd(l.volume_usd) : fmtQuote(l.volume_quote, quote.decimals, quote.symbol)} sub={fmtQuote(l.volume_quote, quote.decimals, quote.symbol)} />
              <Stat k="Buys / sells" v={<><span className="text-up">{count(l.buys)}</span><span className="px-1 text-muted">/</span><span className="text-down-ink">{count(l.sells)}</span></>} sub={`${count(l.buys + l.sells)} total trades`} />
              <Stat k="Since launch" v={<ChangeChip v={l.change_from_launch} plain />} sub="Market cap change" />
            </dl>
          </div>

          <aside className="min-w-0 space-y-4 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <TradePanel chain={chain} token={l.token as Address} symbol={l.symbol} poolKey={poolKey} quote={quote} ethUsd={usd} />
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
                {quote.key === "museworld" ? <p className="mt-4 text-xs leading-relaxed text-muted text-pretty">Paired with MUSEWORLD, the official token of <a href={MUSEWORLD_SITE} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">Museworld</a>, where AI agents launch their tokens. {mode === "free" ? "This pool has no trading fee." : mode === "burn" ? "Every trading fee on this pool is burned as MUSEWORLD." : "Trading fees on this pool are paid out in MUSEWORLD."} USD figures use the MUSEWORLD/GITLAWB pool on openlaunch (checked against its 30-minute average) and GITLAWB&apos;s own price.</p> : null}
                {stockQuote ? <p className="mt-4 text-xs leading-relaxed text-muted text-pretty">Paired with {stockQuote.name} ({stockQuote.symbol}), a third-party tokenized stock. These securities are not offered to US persons. The quote asset is identified from the issuer registry, not its token name.</p> : null}
                {quote.key === "gitlawb" ? <p className="mt-4 text-xs leading-relaxed text-muted text-pretty">Paired with GITLAWB, <a href={GITLAWB_SITE} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">Gitlawb</a>&apos;s token{GITLAWB_ORIGIN[chain]}. {mode === "free" ? "This pool has no trading fee." : mode === "burn" ? "Every trading fee on this pool is burned as GITLAWB." : "Trading fees on this pool are paid out in GITLAWB."} USD figures use the Uniswap v4 WETH/GITLAWB pool price on Base.</p> : null}
              </section>}
            />
          </div>
        </div>
      </main>
      <MobileBuyBar symbol={l.symbol} mcap={capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }).compact} />
    </>
  );
}

function Stat({ k, v, sub }: { k: string; v: React.ReactNode; sub: string }) {
  return <div className="min-w-0 px-4 py-3"><dt className="text-[10px] text-muted">{k}</dt><dd className="mt-1 truncate font-mono text-sm font-bold text-ink tnum">{v}</dd><dd className="mt-1 truncate font-mono text-[10px] text-muted tnum" title={sub}>{sub}</dd></div>;
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words text-right font-mono text-body tnum">{v}</dd></div>;
}
function A({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">{children}</a>;
}
