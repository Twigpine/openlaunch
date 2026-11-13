import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, ChartNoAxesColumn, Download, Info } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import StatsChart from "@/components/stats/StatsChart";
import styles from "@/components/stats/Stats.module.css";
import { ChainLogo } from "@/components/launchpad/ChainLogo";
import { CHAIN_KEYS, CHAIN_LABELS } from "@/lib/chainPublic";
import { BRAND_GITHUB } from "@/lib/brand";
import { fmtUsd } from "@/lib/launchpad/math";
import { pageMetadata } from "@/lib/seo";
import { getProtocolStatsCached } from "@/lib/stats/server";
import { DEFAULT_STATS_WINDOW, STATS_WINDOWS, parseStatsChain, parseStatsWindow, statsHref, type StatsWindow } from "@/lib/stats/stats";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata({
  path: "/stats",
  title: "Protocol stats",
  description: "Launches, trades, trade-time USD volume, creator fees and burns across every openlaunch chain, read from the chain index. Daily series and CSV download.",
});

const WINDOW_LABEL: Record<StatsWindow, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time" };

const n = (v: number): string => Math.round(v).toLocaleString("en-US");

/** `/api/stats` with the current filters, preserving only what the caller chose. */
function apiHref(window: StatsWindow, chain: string | null, format?: "csv"): string {
  const params = new URLSearchParams({ window });
  if (chain) params.set("chain", chain);
  if (format) params.set("format", format);
  return `/api/stats?${params.toString()}`;
}

export default async function StatsPage({ searchParams }: { searchParams: Promise<{ window?: string; chain?: string }> }) {
  const sp = await searchParams;
  const window = parseStatsWindow(sp.window, DEFAULT_STATS_WINDOW);
  const chain = parseStatsChain(sp.chain);
  const stats = await getProtocolStatsCached(window, chain);
  const scope = chain ? CHAIN_LABELS[chain] : "all chains";

  return (
    <main className={shell.page}>
      <SectionIntro
        eyebrow="Protocol facts"
        icon={<ChartNoAxesColumn />}
        title="Protocol stats"
        description={<>Launches, trades, trade-time volume and fee flows, aggregated from the same chain index the site reads. No estimates and no scores: every figure is a sum of indexed events, and events without a price for their hour are counted rather than guessed.</>}
      >
        <a href={apiHref(window, chain)} className={shell.textLink}>JSON API <ArrowUpRight size={14} aria-hidden="true" /></a>
        <a href={apiHref(window, chain, "csv")} className={shell.action}><Download size={15} aria-hidden="true" />CSV</a>
      </SectionIntro>

      <div className={styles.controls}>
        <nav aria-label="Time window" className={styles.tabs}>
          {STATS_WINDOWS.map((w) => (
            <Link key={w} href={statsHref(w, chain)} aria-current={w === window ? "page" : undefined} className={`${styles.tab} ${w === window ? styles.tabActive : ""}`}>{WINDOW_LABEL[w]}</Link>
          ))}
        </nav>
        <nav aria-label="Chain" className={styles.tabs}>
          <Link href={statsHref(window, null)} aria-current={chain === null ? "page" : undefined} className={`${styles.tab} ${chain === null ? styles.tabActive : ""}`}>All chains</Link>
          {CHAIN_KEYS.map((c) => (
            <Link key={c} href={statsHref(window, c)} aria-current={chain === c ? "page" : undefined} className={`${styles.tab} ${chain === c ? styles.tabActive : ""}`}>
              <ChainLogo chain={c} size={14} />{CHAIN_LABELS[c]}
            </Link>
          ))}
        </nav>
      </div>

      {!stats.available ? (
        <section className={styles.unavailable} aria-live="polite">
          <p className={styles.cardLabel}>Chain index</p>
          <h2>Stats are temporarily unavailable.</h2>
          <p>The page reads the site&apos;s Postgres index of factory, locker and PoolManager events. It is not configured or the aggregate read failed, so there are no numbers to show — an empty card would be a lie. Try again shortly, or read the same contract in <Link href="/api/stats">the API</Link>.</p>
        </section>
      ) : (
        <>
          <section className={styles.cards} aria-label={`${WINDOW_LABEL[window]} totals for ${scope}`}>
            <article className={styles.card}>
              <p className={styles.cardLabel}>Launches</p>
              <p className={styles.cardValue}>{n(stats.totals.launches)}</p>
              <p className={styles.cardNote}>{n(stats.totals.launchers)} launcher wallets</p>
            </article>
            <article className={styles.card}>
              <p className={styles.cardLabel}>Trades</p>
              <p className={styles.cardValue}>{n(stats.totals.trades)}</p>
              <p className={styles.cardNote}>{n(stats.totals.traders)} trader wallets</p>
            </article>
            <article className={styles.card}>
              <p className={styles.cardLabel}>Volume</p>
              <p className={styles.cardValue} title={fmtUsd(stats.totals.volume_usd)}>{fmtUsd(stats.totals.volume_usd, { compact: true })}</p>
              <p className={styles.cardNote}>USD at each trade&apos;s own hour</p>
            </article>
            <article className={styles.card}>
              <p className={styles.cardLabel}>To creators</p>
              <p className={styles.cardValue} title={fmtUsd(stats.totals.fees_to_creators_usd)}>{fmtUsd(stats.totals.fees_to_creators_usd, { compact: true })}</p>
              <p className={styles.cardNote}>{fmtUsd(stats.totals.fees_burned_usd, { compact: true })} burned</p>
            </article>
          </section>

          {stats.totals.usd_partial ? (
            <p className={styles.warning}>
              <Info size={15} aria-hidden="true" />
              <span>{n(stats.totals.unpriced_trades)} trades and {n(stats.totals.unpriced_fee_events)} fee events have no trade-time USD for their hour, so they are not in the USD sums. Counts and non-USD facts still include them.</span>
            </p>
          ) : null}

          <div className={styles.charts}>
            <StatsChart points={stats.series} metric="volume_usd" title="Daily volume" caption="Trade-time USD, by UTC day" kind="usd" />
            <StatsChart points={stats.series} metric="launches" title="Daily launches" caption="Launches indexed, by UTC day" kind="count" />
          </div>

          <div className={styles.twoCol}>
            <section className={styles.panel} aria-labelledby="stats-by-chain">
              <div className={styles.panelHeading}><h2 id="stats-by-chain">By chain</h2><span>{WINDOW_LABEL[window]}</span></div>
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead><tr><th scope="col">Chain</th><th scope="col" className={styles.numeric}>Launches</th><th scope="col" className={styles.numeric}>Trades</th><th scope="col" className={styles.numeric}>Volume</th><th scope="col" className={styles.numeric}>To creators</th><th scope="col" className={styles.numeric}>Burned</th></tr></thead>
                  <tbody>
                    {stats.by_chain.map((row) => (
                      <tr key={row.chain}>
                        <th scope="row"><span className={styles.chainName}><ChainLogo chain={row.chain} size={15} />{CHAIN_LABELS[row.chain]}</span></th>
                        <td className={styles.numeric}>{n(row.launches)}</td>
                        <td className={styles.numeric}>{n(row.trades)}</td>
                        <td className={styles.numeric}>{fmtUsd(row.volume_usd, { compact: true })}</td>
                        <td className={styles.numeric}>{fmtUsd(row.fees_to_creators_usd, { compact: true })}</td>
                        <td className={styles.numeric}>{fmtUsd(row.fees_burned_usd, { compact: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className={styles.panel} aria-labelledby="stats-top">
              <div className={styles.panelHeading}><h2 id="stats-top">Top launches by volume</h2><span>{WINDOW_LABEL[window]}</span></div>
              {stats.top.length === 0 ? (
                <p className={styles.emptyRow}>No indexed trades in this window yet.</p>
              ) : (
                <ol className={styles.topList}>
                  {stats.top.map((launch, i) => (
                    <li key={`${launch.chain}:${launch.token}`}>
                      <span className={styles.topRank}>{i + 1}</span>
                      <div className={styles.topName}>
                        <Link href={`/t/${launch.chain}/${launch.token}`}>{launch.symbol || "—"}</Link>
                        <span>{launch.name || launch.token}</span>
                      </div>
                      <div className={styles.topValue}><span>{fmtUsd(launch.volume_usd, { compact: true })}</span><span>{n(launch.trades)} trades · {CHAIN_LABELS[launch.chain]}</span></div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section className={styles.notes} aria-label="How these figures are calculated">
            <p>Every figure is an aggregate of the site&apos;s Postgres index of <code>bb_launches</code>, <code>bb_launch_swaps</code> and <code>bb_launch_fee_events</code>, which follow the factory, locker and Uniswap v4 PoolManager events. The chain is the source of truth; the index lags by a few blocks and a very new launch may not be synced yet.</p>
            <p>USD is <strong>trade-time USD</strong>: the quote&apos;s price in the event&apos;s own UTC hour, fixed when the event was indexed. An event with no price for that hour is excluded from the USD sums and counted in the warning above. The home page totals additionally fall back to the current price for those events, so the two can differ when a price feed was down.</p>
            <p>Fees to creators are collected quote fees minus burned quote fees. Token-side fee burns are not valued in USD. Holders shown on a launch are the indexed transfer-history count, not this page&apos;s aggregate.</p>
            <p>Download the daily series as CSV above, or read <Link href="/api/stats">/api/stats</Link> with <code>window=7d|30d|90d|all</code> and <code>chain=base|robinhood|arc|elysium</code>. The same numbers are on this page, one memoized read per window. Method and field notes: <a href={`${BRAND_GITHUB}/blob/main/docs/stats.md`} target="_blank" rel="noreferrer">docs/stats.md<ArrowUpRight size={12} aria-hidden="true" /></a>.</p>
          </section>
        </>
      )}
    </main>
  );
}
