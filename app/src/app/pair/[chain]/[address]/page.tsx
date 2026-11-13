import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isAddress } from "viem";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import LaunchRow from "@/components/launchpad/LaunchRow";
import { CommunityPairBadge } from "@/components/launchpad/QuoteBadge";
import { pageMetadata } from "@/lib/seo";
import { pairByAddress, pairEvents, pairStats } from "@/lib/launchpad/pairsServer";
import { listLaunchesPage } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { quoteInfo } from "@/lib/launchpad/config";
import { PAIR_COPY, PAIR_MONITOR_LIQUIDITY_USD, PAIR_PRICE_KIND_LABEL, isPairChain, pairPath, pairTitle, pairVolumeLabel, type PairPublic } from "@/lib/launchpad/pairs";
import { fmtUsd, units } from "@/lib/launchpad/math";
import { nowMs } from "@/lib/launchpad/time";
import { CHAIN_LABELS, explorerAddress, isChainKey, shortAddr, type ChainKey } from "@/lib/chainPublic";

export const dynamic = "force-dynamic";

async function load(chain: string, address: string): Promise<PairPublic | null> {
  if (!isChainKey(chain) || !isPairChain(chain) || !isAddress(address)) return null;
  return pairByAddress(chain, address);
}

export async function generateMetadata({ params }: { params: Promise<{ chain: string; address: string }> }): Promise<Metadata> {
  const { chain, address } = await params;
  const p = await load(chain, address);
  if (!p) return { title: "Community pair not found", robots: { index: false } };
  return pageMetadata({ path: pairPath(p.chain, p.address), title: `${p.symbol}: community pair`, description: `Launch a token on ${CHAIN_LABELS[p.chain]} paired with ${p.symbol} on openlaunch. ${PAIR_COPY.pageNote}` });
}

const day = (iso: string) => new Date(iso).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, "");

/** Where the pair's USD price comes from, as a link anyone can follow. */
function sourceLink(p: PairPublic): { href: string; label: string } {
  if (p.price_kind === "launch") return { href: `/t/${p.chain}/${p.price_pool}`, label: `its pool on openlaunch` };
  if (p.price_kind === "univ3") return { href: explorerAddress(p.chain, p.price_pool), label: shortAddr(p.price_pool) };
  return { href: `https://www.geckoterminal.com/${p.chain}/pools/${p.price_pool}`, label: `${p.price_pool.slice(0, 10)}…` };
}

/** One community pair: what it is, where its price comes from, what is checked, its public record and its launches. */
export default async function PairPage({ params }: { params: Promise<{ chain: string; address: string }> }) {
  const { chain, address } = await params;
  const p = await load(chain, address);
  if (!p) notFound();
  const c = p.chain as ChainKey;
  const [events, stats, page] = await Promise.all([
    pairEvents(c, p.address),
    pairStats(c, [p.address]).then((m) => m.get(p.address) ?? null).catch(() => null),
    ethUsd().then((usd) => listLaunchesPage({ sort: "new", chain: c, quote: p.address, limit: 50, ethUsd: usd })).catch(() => ({ items: [], hasMore: false })),
  ]);
  const now = nowMs();
  const quoteSym = quoteInfo(c, p.price_quote).symbol;
  const src = sourceLink(p);
  const volUsd = stats && p.usd !== null ? units(stats.volume_quote, p.decimals) * p.usd : null;
  const statusLine = p.status === "listed" ? `Listed since ${day(p.listed_at)}` : p.status === "suspended" ? `Suspended since ${day(p.status_at)}` : `Delisted on ${day(p.status_at)}`;
  return (
    <main className={shell.page}>
      <SectionIntro eyebrow="Community pair" title={pairTitle(p)} description={p.description ? `${p.description} ${PAIR_COPY.pageNote}` : PAIR_COPY.pageNote}>
        <Link href="/pairs" className={shell.textLink}>All community pairs <ArrowRight size={14} aria-hidden="true" /></Link>
      </SectionIntro>

      <section className={`${shell.anchorSection} mt-8`} aria-labelledby="pair-facts">
        <h2 id="pair-facts" className="sr-only">Facts</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {p.status === "listed" ? <CommunityPairBadge symbol={p.symbol} logo={p.logo} size="md" /> : <span className="rounded-full border border-warm/30 bg-warm-soft px-2.5 py-1 text-xs font-medium text-warm-ink">{p.status === "suspended" ? "Suspended" : "Delisted"}</span>}
          <span className="text-muted">{statusLine}{p.status !== "listed" && p.status_reason ? `: ${p.status_reason}` : ""}</span>
        </div>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact term="Price" value={p.usd !== null ? fmtUsd(p.usd) : "–"} note={p.status === "listed" ? (p.usd !== null ? "Checked against its pool's 30-minute average." : "None right now: launches show no USD until it reads.") : "Not priced while not listed."} />
          <Fact term="Launches paired" value={(stats?.launches ?? 0).toLocaleString("en-US")} note={`${(stats?.launches_24h ?? 0).toLocaleString("en-US")} in the last 24 hours.`} />
          <Fact term="Volume, all time" value={pairVolumeLabel(volUsd)} note={`Across the launches paired with ${p.symbol}.`} />
          <Fact term="Contract" value={shortAddr(p.address)} note={`${p.decimals} decimals, on ${CHAIN_LABELS[c]}.`} href={explorerAddress(c, p.address)} />
        </dl>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {p.website ? <a href={p.website} target="_blank" rel="noopener noreferrer" className="text-brand hover:text-ink">{new URL(p.website).hostname} <ArrowUpRight size={12} aria-hidden="true" className="inline" /></a> : null}
          {p.x_handle ? <a href={`https://x.com/${p.x_handle}`} target="_blank" rel="noopener noreferrer" className="text-brand hover:text-ink">@{p.x_handle} <ArrowUpRight size={12} aria-hidden="true" className="inline" /></a> : null}
        </div>
      </section>

      <section className={`${shell.anchorSection} mt-12`} aria-labelledby="pair-checks">
        <h2 id="pair-checks" className="font-display text-xl font-bold tracking-tight text-ink">How it is priced and watched</h2>
        <ul className="mt-4 space-y-2 text-sm text-body">
          <li>USD price: from {PAIR_PRICE_KIND_LABEL[p.price_kind]} against {quoteSym} (<a href={src.href} target={src.href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer" className="text-brand hover:text-ink">{src.label}</a>), times {quoteSym}&apos;s own price.{p.price_hook ? ` The pool runs a hook (${shortAddr(p.price_hook)}), named when it was listed.` : ""} A spot more than 25% off the 30-minute average is replaced by the average.</li>
          <li>Every hour: the contract&apos;s code must be the code it was listed with, the pool must give a price, and the pool must hold at least ${PAIR_MONITOR_LIQUIDITY_USD.toLocaleString("en-US")}. A code change suspends the pair at once; any other check failing for 24 hours suspends it; 14 days suspended delists it.</li>
          <li>{PAIR_COPY.noForm}</li>
          <li>{p.checked_at ? `Last checked ${day(p.checked_at)}, ${new Date(p.checked_at).toISOString().slice(11, 16)} UTC.` : "Not checked yet."}{p.failing_since ? ` Failing since ${day(p.failing_since)}.` : ""}</li>
        </ul>
      </section>

      <section className={`${shell.anchorSection} mt-12`} aria-labelledby="pair-record">
        <h2 id="pair-record" className="font-display text-xl font-bold tracking-tight text-ink">Record</h2>
        {events.length === 0 ? <p className="mt-4 text-sm text-muted">Nothing recorded yet.</p> : (
          <ol className="mt-4 space-y-2 text-sm">
            {events.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-3 text-body">
                <time dateTime={e.created_at} className="font-mono text-xs text-muted tnum">{e.created_at.slice(0, 16).replace("T", " ")} UTC</time>
                <span className="font-semibold text-ink">{e.status}</span>
                {e.reason ? <span>{e.reason}</span> : null}
                <span className="text-muted">by {/^0x[0-9a-f]{40}$/.test(e.actor) ? shortAddr(e.actor) : e.actor}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={`${shell.anchorSection} mt-12`} aria-labelledby="pair-launches">
        <h2 id="pair-launches" className="font-display text-xl font-bold tracking-tight text-ink">Launches paired with {p.symbol}</h2>
        {page.items.length === 0 ? <p className="mt-4 text-sm text-muted">None yet.</p> : (
          <ul className="mt-4">
            {page.items.map((l) => <li key={`${l.chain}:${l.token}`} className="relative"><LaunchRow l={l} now={now} /></li>)}
          </ul>
        )}
      </section>
    </main>
  );
}

function Fact({ term, value, note, href }: { term: string; value: string; note: string; href?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <dt className="text-xs uppercase tracking-wide text-muted">{term}</dt>
      <dd className="mt-1 font-mono text-lg font-bold text-ink tnum">{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="hover:text-brand">{value}</a> : value}</dd>
      <dd className="mt-2 text-xs leading-relaxed text-muted text-pretty">{note}</dd>
    </div>
  );
}
