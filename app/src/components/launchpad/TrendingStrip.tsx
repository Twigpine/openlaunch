"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import TokenAvatar from "./TokenAvatar";
import { QuoteBrandBadge } from "./MuseworldBadge";
import { useLive } from "./LiveProvider";
import type { LaunchRow } from "@/lib/launchpad/queries";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { stickyKing } from "@/lib/launchpad/ranking";
import { launchKey, refreshInPlace } from "@/lib/launchpad/list-state";
import { setPendingToken } from "@/lib/launchpad/token-transition";

type Snap = { window: "1h" | "24h"; items: LaunchRow[] };

/** One row of chips: existing on-chain ranking and two-poll leader hold, with chain-scoped identity. */
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
  const heading = snap.window === "1h" ? "Trending this hour" : "Trending today";

  return (
    <section aria-labelledby="trending-heading" className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      <h2 id="trending-heading" className="shrink-0 text-sm font-semibold text-ink" title="Ranked by distinct wallets other than the launcher, then trades, volume and holders (log-scaled), with a boost for young tokens. The hourly window needs two such wallets; the daily window needs one.">{heading}</h2>
      {items.length === 0 ? (
        <p className="text-xs text-muted">A quiet window. Tokens show here once enough different wallets trade them.</p>
      ) : (
        <ol aria-label="Trending tokens" className="-mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 pb-1 bb-scroll sm:mx-0 sm:px-0 sm:pb-0" onPointerEnter={(e) => { if (e.pointerType === "mouse") active.current.pointer = true; }} onPointerLeave={() => { active.current.pointer = false; }} onFocusCapture={() => { active.current.focus = true; }} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) active.current.focus = false; }}>
          {items.map((row, index) => {
            const trades = snap.window === "1h" ? row.trades_1h : row.trades_24h;
            // `relative`: the chips hold sr-only (absolutely positioned) labels; without a positioned ancestor inside
            // the scroller they resolve against <main> and stretch the whole page sideways on phones
            return (
              <li key={launchKey(row)} className="relative shrink-0">
                <Link
                  href={`/t/${row.chain}/${row.token}`}
                  onClick={() => setPendingToken({ chain: row.chain, token: row.token, name: row.name, symbol: row.symbol, image: row.image_url })}
                  title={`${row.name} on ${CHAIN_SHORT[row.chain]}, paired with ${row.quote_symbol}`}
                  className={`flex h-10 items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3.5 text-[13px] whitespace-nowrap transition-colors hover:border-muted motion-reduce:transition-none ${index === 0 ? "border-line-strong" : "border-line"}`}
                >
                  <span className="sr-only">Number {index + 1}: </span>
                  <TokenAvatar chain={row.chain} token={row.token} symbol={row.symbol} image={row.image_url} size={30} className="shrink-0 rounded-full" />
                  <span className="max-w-[9rem] truncate font-semibold text-ink">{row.name}</span>
                  <QuoteBrandBadge quoteKey={row.quote_key} />
                  <span className="font-mono text-ink tnum"><span className="sr-only">market cap </span>{capDisplay(row.fdv_quote, row.quote_usd, { key: row.quote_key, symbol: row.quote_symbol, decimals: row.quote_decimals }).compact}</span>
                  <span className="text-xs text-muted"><span className="font-mono tnum">{trades}</span> {trades === 1 ? "trade" : "trades"}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
