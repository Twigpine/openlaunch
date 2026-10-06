import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import TokenChart from "@/components/launchpad/TokenChart";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { REVIEW_POOLS } from "./pools";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chart preview", robots: { index: false, follow: false } };

export default async function ChartReview({ searchParams }: { searchParams: Promise<{ pool?: string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { pool: id } = await searchParams;
  const pool = REVIEW_POOLS.find((candidate) => candidate.id === id) ?? REVIEW_POOLS[0];

  return <main className="mx-auto min-w-0 max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Chart preview</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">The token-page chart with real Openlaunch pools. Check Base, Robinhood and Arc, plus unindexed-pool states. No trades or wallet actions.</p>
      </div>
      <a href={`https://openlaunch.lol/t/${pool.chain}/${pool.token}`} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 text-xs text-body hover:text-ink">View live token<ArrowUpRight size={14} aria-hidden /></a>
    </header>
    <nav aria-label="Example pools" className="mb-5 flex flex-wrap gap-2">
      {REVIEW_POOLS.map((item) => <Link key={item.id} href={`/ui-review-charts?pool=${item.id}`} prefetch={false} aria-current={item.id === pool.id ? "page" : undefined}
        className={`ui-pressable flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm ${item.id === pool.id ? "bg-line text-ink" : "text-muted hover:bg-card hover:text-ink"}`}>
        {item.name}<span className="text-xs text-muted">{CHAIN_SHORT[item.chain]}</span>
      </Link>)}
    </nav>
    <TokenChart key={pool.id} chain={pool.chain} token={pool.token} poolId={pool.poolId} quote={pool.quote} symbol={pool.symbol} launchedAt={pool.launchedAt} hasTrades={pool.hasTrades ?? true} review />
    <details className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-muted">
      <summary className="w-fit cursor-pointer py-2 text-body">Pool identity and trial notes</summary>
      <dl className="mt-3 space-y-2">
        <div><dt className="text-body">Exact Uniswap v4 pool</dt><dd className="mt-1 break-all font-mono">{pool.poolId}</dd></div>
        <div><dt className="text-body">Token contract</dt><dd className="mt-1 break-all font-mono">{pool.token}</dd></div>
      </dl>
      <p className="mt-3 max-w-3xl">GeckoTerminal is primary for exact, correctly oriented pools with a usable USD price. Otherwise the same component shows Openlaunch’s indexed candles. This development-only preview reads public candle data from openlaunch.lol; production uses its own database. Provider branding stays visible, using Gecko’s grayscale logo option.</p>
    </details>
  </main>;
}
