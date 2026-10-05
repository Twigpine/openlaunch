"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import TokenAvatar from "./TokenAvatar";
import { useLive } from "./LiveProvider";
import type { LaunchRow as L } from "@/lib/launchpad/queries";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { ago } from "@/lib/launchpad/time";
import { launchKey } from "@/lib/launchpad/list-state";
import { feedKey } from "@/lib/launchpad/river";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import { JUST_LAUNCHED_SIZE } from "@/lib/launchpad/paging";

/** At most one refetch per this window; a burst of trades on a fresh token costs one request, not one per poll. */
const MIN_GAP_MS = 10_000;

/**
 * The newest launches and whether each has had its first trade. Rows come from the market read model, so the
 * counts are exact; the shared poll only says when they are worth re-reading (a new launch, or a trade on one shown).
 */
export default function JustLaunched({ initial, serverNow }: { initial: L[]; serverNow: number }) {
  const { subscribe } = useLive();
  const [rows, setRows] = useState(initial);
  const [now, setNow] = useState(serverNow);
  const shown = useRef(initial);

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
    <section aria-labelledby="fresh-heading" className="overflow-hidden rounded-2xl border border-line bg-paper">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-line px-4">
        <h2 id="fresh-heading" className="text-sm font-semibold text-ink">Just launched</h2>
        <span className="text-[11px] text-muted">Newest first</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8"><p className="text-sm text-ink">No launches yet.</p><p className="mt-1 text-xs leading-relaxed text-muted">New tokens show here the moment they launch.</p></div>
      ) : (
        <ol aria-label="Newest launches" className="divide-y divide-line">
          {rows.map((l) => {
            const trades = l.buys + l.sells;
            return (
              <li key={launchKey(l)}>
                <Link href={`/t/${l.chain}/${l.token}`} onClick={() => setPendingToken({ chain: l.chain, token: l.token, name: l.name, symbol: l.symbol, image: l.image_url })} className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-card motion-reduce:transition-none">
                  <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={32} className="shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-ink">{l.name}</p>
                    <p className="mt-0.5 truncate text-[11px] text-muted"><span className="font-mono text-body">{l.symbol}</span> on {CHAIN_SHORT[l.chain]}</p>
                  </div>
                  <div className="shrink-0 text-right text-[11px]">
                    <time dateTime={l.block_time} title={new Date(l.block_time).toUTCString()} className="block font-mono text-muted tnum" suppressHydrationWarning>{ago(l.block_time, now)} ago</time>
                    <span className={`mt-0.5 block ${trades ? "text-up" : "text-muted"}`}>{trades ? <><span className="font-mono tnum">{trades}</span> {trades === 1 ? "trade" : "trades"}</> : "No trades yet"}</span>
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
