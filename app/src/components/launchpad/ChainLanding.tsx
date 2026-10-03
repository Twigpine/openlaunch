import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import LaunchList from "@/components/launchpad/LaunchList";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import { CHAIN_KEYS, CHAIN_LABELS, CHAINS, EXPLORERS, explorerAddress, type ChainKey } from "@/lib/chainPublic";
import { BRAND } from "@/lib/brand";
import { CHAIN_LANDING, chainLandingPath } from "@/lib/chainLanding";
import { hasChainPage, launchpad } from "@/lib/launchpad/config";
import { getLaunchTotalsForRequest, listLaunchesPage } from "@/lib/launchpad/queries";
import { PAGE_SIZE } from "@/lib/launchpad/paging";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { dbConfigured } from "@/lib/db";
import { pageMetadata } from "@/lib/seo";

/** Metadata for /<chain>: its own title, snippet and canonical (never "/", see app/metadata.test.ts). */
export function chainLandingMetadata(chain: ChainKey): Metadata {
  const c = CHAIN_LANDING[chain];
  return pageMetadata({ path: chainLandingPath(chain), title: c.title, description: c.description });
}

/**
 * The per-chain landing page: the chain's launches (the same list as the home page, pre-filtered),
 * with a heading and facts that name the chain, so "launch a token on <chain>" has a page to rank.
 */
export default async function ChainLanding({ chain }: { chain: ChainKey }) {
  if (!hasChainPage(chain)) notFound();
  const c = CHAIN_LANDING[chain];
  const lp = launchpad(chain);
  const usd = await ethUsd();
  const [page, totals] = await Promise.all([
    listLaunchesPage({ sort: "live", window: "all", chain, filter: null, limit: PAGE_SIZE, ethUsd: usd }),
    getLaunchTotalsForRequest(usd), // the root layout already ran it this request: shared, not repeated
  ]);
  const launches = totals.by_chain[chain].launches;
  const others = CHAIN_KEYS.filter((k) => k !== chain && hasChainPage(k));

  return (
    <main className={shell.page}>
      <SectionIntro eyebrow={CHAIN_LABELS[chain]} title={c.heading} description={c.intro}>
        <Link href={`/launch?chain=${chain}`} className={shell.action}>Launch on {CHAIN_LABELS[chain]} <ArrowRight size={15} aria-hidden="true" /></Link>
        <Link href="/rules#launchpad" className={shell.textLink}>How it works <ArrowRight size={14} aria-hidden="true" /></Link>
      </SectionIntro>

      <section className={shell.anchorSection} aria-labelledby="facts-heading">
        <h2 id="facts-heading" className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">{CHAIN_LABELS[chain]} at a glance</h2>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact term="Platform fee" value="$0" note={`You pay ${CHAIN_LABELS[chain]} gas in ${c.gas}, nothing else.`} />
          <Fact term="Quote assets" value={lp.quotes.map((q) => q.symbol).join(" · ")} note="What the pool trades against, picked at launch." />
          <Fact term="Launches" value={launches.toLocaleString("en-US")} note={`Tokens launched on ${CHAIN_LABELS[chain]} so far.`} />
          <Fact term="Chain ID" value={String(CHAINS[chain].id)} note={`Liquidity: Uniswap v4 on ${CHAIN_LABELS[chain]}.`} />
        </dl>
        {lp.factory ? (
          <p className="mt-4 text-sm text-muted">
            Factory contract:{" "}
            <a href={explorerAddress(chain, lp.factory)} target="_blank" rel="noopener noreferrer" className="font-mono text-body underline decoration-line-strong underline-offset-4 hover:text-ink break-all">{lp.factory}</a>{" "}
            on {EXPLORERS[chain].name} <ArrowUpRight size={12} aria-hidden="true" className="inline" />
          </p>
        ) : null}
      </section>

      <section className={`${shell.anchorSection} mt-14`} aria-labelledby="chain-launches-heading">
        <h2 id="chain-launches-heading" className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">Tokens on {CHAIN_LABELS[chain]}</h2>
        <div className="mt-6">
          <LaunchList initial={page.items} initialHasMore={page.hasMore} initialSort="live" initialWindow="all" initialChain={chain} initialFilter={null} hasDb={dbConfigured()} />
        </div>
      </section>

      {others.length ? (
        <nav className={`${shell.anchorSection} mt-10`} aria-label="Other chains">
          <p className="text-sm text-muted">
            Also on:{" "}
            {others.map((k, i) => (
              <span key={k}>
                {i ? " · " : null}
                <Link href={chainLandingPath(k)} className="text-brand underline decoration-line-strong underline-offset-4 hover:text-ink">{BRAND} on {CHAIN_LABELS[k]}</Link>
              </span>
            ))}
          </p>
        </nav>
      ) : null}
    </main>
  );
}

function Fact({ term, value, note }: { term: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <dt className="text-xs uppercase tracking-wide text-muted">{term}</dt>
      <dd className="mt-1 font-mono text-lg font-bold text-ink tnum">{value}</dd>
      <dd className="mt-2 text-xs leading-relaxed text-muted text-pretty">{note}</dd>
    </div>
  );
}
