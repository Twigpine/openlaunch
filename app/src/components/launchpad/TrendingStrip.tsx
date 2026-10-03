"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChartNoAxesCombined } from "lucide-react";
import TokenAvatar from "./TokenAvatar";
import { isGitlawbQuote } from "./GitlawbBadge";
import { QuoteBrandBadge, isMuseworldQuote } from "./MuseworldBadge";
import ChangeChip from "./ChangeChip";
import { useLive } from "./LiveProvider";
import type { LaunchRow } from "@/lib/launchpad/queries";
import { fmtQuote } from "@/lib/launchpad/math";
import { marketUsd } from "@/lib/launchpad/market-format";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { stickyKing } from "@/lib/launchpad/ranking";
import { launchKey, refreshInPlace } from "@/lib/launchpad/list-state";

type Snap = { window: "1h" | "24h"; items: LaunchRow[] };

/** Existing on-chain ranking and two-poll leader hold, with chain-scoped identity. */
export default function TrendingStrip({ initial }: { initial: Snap }) {
  const { subscribe } = useLive();
  const [snap, setSnap] = useState(initial);
  const [crown, setCrown] = useState({ king: initial.items[0] ? launchKey(initial.items[0]) : null, streak: { token: null as string | null, n: 0 } });
  const active = useRef({ pointer: false, focus: false });
  const pending = useRef<Snap | null>(null);

  useEffect(() => {
    function apply(next: Snap) {
      setCrown((prev) => stickyKing(prev.king, next.items[0] ? launchKey(next.items[0]) : null, prev.streak));
      setSnap(next);
    }
    const unsubscribe = subscribe((live) => {
      if (!live.trending) return;
      if (active.current.pointer || active.current.focus) {
        pending.current = live.trending;
        // Preserve the displayed time window too: don't relabel old rankings.
        const next = live.trending;
        setSnap((cur) => ({ ...cur, items: refreshInPlace(cur.items, next.items) }));
      } else {
        pending.current = null;
        apply(live.trending);
      }
    });
    const timer = setInterval(() => {
      if (pending.current && !active.current.pointer && !active.current.focus) {
        apply(pending.current);
        pending.current = null;
      }
    }, 1_000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [subscribe]);

  const leader = snap.items.find((row) => launchKey(row) === crown.king);
  const items = leader ? [leader, ...snap.items.filter((row) => launchKey(row) !== crown.king)] : snap.items;

  return (
    <section aria-labelledby="trending-heading" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ChartNoAxesCombined size={15} aria-hidden="true" className="text-muted" />
          <h2 id="trending-heading" className="text-sm font-semibold text-ink">Trending</h2>
          <span className="text-[11px] text-muted">{snap.window === "1h" ? "Last hour" : "Last 24 hours"}</span>
        </div>
        <span className="text-[11px] text-muted" title="Ranked by distinct wallets other than the launcher, then trades, volume and holders (log-scaled), with a boost for young tokens. The hourly window needs two such wallets; the daily window needs one.">Ranked by on-chain activity</span>
      </div>
      {items.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-dashed border-line-strong px-4 py-4">
          <p className="text-xs text-muted">A quiet window. Trending appears when tokens have enough trading activity.</p>
          <a href="#launches" className="inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-body hover:text-ink">Explore launches <ArrowUpRight size={13} aria-hidden="true" /></a>
        </div>
      ) : (
        <ol aria-label="Trending tokens" className="grid auto-cols-[minmax(13rem,1fr)] grid-flow-col gap-2 overflow-x-auto pb-1 bb-scroll snap-x snap-mandatory lg:auto-cols-fr" onPointerEnter={(e) => { if (e.pointerType === "mouse") active.current.pointer = true; }} onPointerLeave={() => { active.current.pointer = false; }} onFocusCapture={() => { active.current.focus = true; }} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) active.current.focus = false; }}>
          {items.map((row, index) => {
            const trades = snap.window === "1h" ? row.trades_1h : row.trades_24h;
            const volume = snap.window === "1h" ? row.volume_1h_usd : row.volume_24h_usd;
            const quoteVolume = snap.window === "1h" ? row.volume_1h : row.volume_24h;
            const volumeLabel = volume !== null ? marketUsd(volume) : fmtQuote(quoteVolume, row.quote_decimals, row.quote_symbol);
            // `relative`: the cards hold sr-only (absolutely positioned) labels; without a positioned ancestor inside
            // the scroller they resolve against <main> and stretch the whole page sideways on phones
            return (
              <li key={launchKey(row)} className="relative min-w-0 snap-start">
                <Link href={`/t/${row.chain}/${row.token}`} className={`group block h-full rounded-xl border bg-card p-3.5 transition-colors hover:border-muted motion-reduce:transition-none ${index === 0 ? "border-line-strong" : "border-line"}`}>
                  <div className="mb-3 flex items-center justify-between text-[11px] text-muted">
                    <span className="font-mono tnum">0{index + 1}<span className="sr-only"> ranked</span></span>
                    {isGitlawbQuote(row.quote_key) || isMuseworldQuote(row.quote_key) ? <span className="flex items-center gap-1">{CHAIN_SHORT[row.chain]} · <QuoteBrandBadge quoteKey={row.quote_key} /></span> : <span>{CHAIN_SHORT[row.chain]} · {row.quote_symbol}</span>}
                    <ArrowUpRight size={13} aria-hidden="true" className="text-muted group-hover:text-ink" />
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <TokenAvatar chain={row.chain} token={row.token} symbol={row.symbol} image={row.image_url} size={30} className="shrink-0 rounded-lg" />
                    <div className="min-w-0"><p className="truncate text-[13px] font-semibold text-ink">{row.name}</p><p className="truncate font-mono text-[10px] text-muted">{row.symbol}</p></div>
                  </div>
                  <div className="mt-3 flex min-w-0 items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-sm font-bold text-ink tnum"><span className="sr-only">Market cap </span>{capDisplay(row.fdv_quote, row.quote_usd, { key: row.quote_key, symbol: row.quote_symbol, decimals: row.quote_decimals }).compact}</span>
                    <ChangeChip v={row.change_from_launch} plain />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2 text-[10px] text-muted">
                    <span><span className="font-mono tnum text-body">{trades}</span> trades</span><span className="truncate font-mono tnum" title={`Volume ${volumeLabel}`}>{volumeLabel}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
