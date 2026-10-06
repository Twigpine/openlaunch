"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MagicCard } from "@/components/vendor/magic-card";
import TokenAvatar from "./TokenAvatar";
import { useLive } from "./LiveProvider";
import type { LaunchRow as L } from "@/lib/launchpad/queries";
import { ArrowUpRight } from "lucide-react";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { ago } from "@/lib/launchpad/time";
import { launchKey } from "@/lib/launchpad/list-state";
import { feedKey } from "@/lib/launchpad/river";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import { JUST_LAUNCHED_SIZE } from "@/lib/launchpad/paging";
import { ChainCorner } from "./ChainLogo";

/** At most one refetch per this window; a burst of trades on a fresh token costs one request, not one per poll. */
const MIN_GAP_MS = 10_000;
/** A launch younger than this rings its logo: it is the news. */
const FRESH_MS = 10 * 60_000;

/**
 * The newest launches and whether each has had its first trade. Rows come from the market read model, so the
 * counts are exact; the shared poll only says when they are worth re-reading (a new launch, or a trade on one shown).
 */
export default function JustLaunched({ initial, serverNow }: { initial: L[]; serverNow: number }) {
  const { subscribe } = useLive();
  const [rows, setRows] = useState(initial);
  const [now, setNow] = useState(serverNow);
  const shown = useRef(initial);
  const reduced = useReducedMotion();

  useEffect(() => {
    const seen = new Set<string>();
    let lastFetch = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    function load() {
      const wait = lastFetch + MIN_GAP_MS - Date.now();
      if (wait > 0) {
        trailing ??= setTimeout(() => { trailing = null; load(); }, wait);
        return;
      }
      lastFetch = Date.now();
      controller?.abort();
      const c = new AbortController();
      controller = c;
      fetch(`/api/launch/list?sort=new&limit=${JUST_LAUNCHED_SIZE}`, { cache: "no-store", signal: c.signal })
        .then(async (res) => {
          if (!res.ok) return;
          const data = await res.json() as { launches?: L[] };
          if (c.signal.aborted || !Array.isArray(data.launches)) return;
          shown.current = data.launches;
          setRows(data.launches);
        })
        .catch(() => { /* keep the last rows; the next event retries */ });
    }
    const unsubscribe = subscribe((snap) => {
      const keys = new Set(shown.current.map(launchKey));
      const oldest = shown.current.length ? Math.min(...shown.current.map((r) => new Date(r.block_time).getTime())) : -Infinity;
      let stale = false;
      for (const item of snap.feed ?? []) {
        const key = feedKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        const token = launchKey(item);
        if (item.kind === "launch" ? !keys.has(token) && new Date(item.at).getTime() >= oldest : keys.has(token)) stale = true;
      }
      if (stale) load();
    });
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => { unsubscribe(); clearInterval(clock); controller?.abort(); if (trailing) clearTimeout(trailing); };
  }, [subscribe]);

  return (
    <MagicCard className="rounded-2xl">
    <section aria-labelledby="fresh-heading" className="overflow-hidden rounded-[inherit]">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-line px-4">
        <h2 id="fresh-heading" className="flex items-center gap-2 text-sm font-semibold text-ink">
          {/* the list follows the shared live poll */}
          <span aria-hidden="true" className="relative flex size-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-up opacity-50 motion-reduce:hidden" />
            <span className="relative size-2 rounded-full bg-up" />
          </span>
          Just launched
        </h2>
        <Link href="/?sort=new#launches" className="inline-flex min-h-8 items-center gap-0.5 text-[11px] font-medium text-muted transition-colors hover:text-ink motion-reduce:transition-none">See all<ArrowUpRight size={12} aria-hidden="true" /></Link>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8"><p className="text-sm text-ink">No launches yet.</p><p className="mt-1 text-xs leading-relaxed text-muted">New tokens show here the moment they launch.</p></div>
      ) : (
        <ol aria-label="Newest launches" className="relative py-1.5">
          {/* the log's spine, running behind the logos (each logo's ring cuts it) */}
          <span aria-hidden="true" className="absolute top-9 bottom-9 left-[35px] w-px bg-line" />
          {/* a new launch springs in at the top; rows already on screen just slide down */}
          <AnimatePresence initial={false}>
          {rows.map((l) => {
            const trades = l.buys + l.sells;
            const fresh = now - new Date(l.block_time).getTime() < FRESH_MS;
            return (
              <motion.li key={launchKey(l)} layout={reduced ? false : "position"} initial={reduced ? false : { opacity: 0, scale: 0.96, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 34 }}>
                <Link href={`/t/${l.chain}/${l.token}`} onClick={() => setPendingToken({ chain: l.chain, token: l.token, name: l.name, symbol: l.symbol, image: l.image_url })} title={`${l.name} on ${CHAIN_SHORT[l.chain]}`} className="group flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-ink/[0.03] motion-reduce:transition-none">
                  <span className="relative shrink-0 rounded-[13px] bg-card p-0.5">
                    {/* under ten minutes old: a soft ring says this one is the news */}
                    {fresh ? <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-[13px] ring-2 ring-up/50 motion-reduce:hidden" /> : null}
                    <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={34} className="shrink-0 rounded-xl" />
                    <ChainCorner chain={l.chain} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-semibold text-ink">{l.name}</span>
                      <time dateTime={l.block_time} title={new Date(l.block_time).toUTCString()} className={`shrink-0 font-mono text-[11px] tnum ${fresh ? "text-up" : "text-muted"}`} suppressHydrationWarning>{ago(l.block_time, now)} ago</time>
                    </p>
                    <p className="mt-0.5 flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
                      <span className="truncate text-muted"><span className="font-mono text-body">{l.symbol}</span><span aria-hidden="true"> · </span><span className="sr-only">, market cap </span><span className="font-mono tnum">{capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }).compact}</span></span>
                      <span className={`shrink-0 ${trades ? "text-up" : "text-muted"}`}>{trades ? <><span className="font-mono tnum">{trades}</span> {trades === 1 ? "trade" : "trades"}</> : "No trades yet"}</span>
                    </p>
                  </div>
                </Link>
              </motion.li>
            );
          })}
          </AnimatePresence>
        </ol>
      )}
    </section>
    </MagicCard>
  );
}
