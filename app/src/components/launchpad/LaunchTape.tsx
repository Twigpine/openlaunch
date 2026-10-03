"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, Plus } from "lucide-react";
import { useLive } from "./LiveProvider";
import TokenAvatar from "./TokenAvatar";
import { QuoteBrandBadge } from "./MuseworldBadge";
import type { FeedItem } from "@/lib/launchpad/queries";
import { fmtQuote } from "@/lib/launchpad/math";
import { CHAIN_SHORT, shortAddr } from "@/lib/chainPublic";
import { ago } from "@/lib/launchpad/time";

/** Shared live tape; animate only genuine new events, never a looping demo. */
export default function LaunchTape({ initial }: { initial: FeedItem[] }) {
  const { subscribe } = useLive();
  const [items, setItems] = useState(initial);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef(new Set(initial.map(key)));
  const clearFresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const unsubscribe = subscribe((snap) => {
      const incoming = snap.feed ?? [];
      const entering = new Set(incoming.filter((item) => !seen.current.has(key(item))).map(key));
      seen.current = new Set(incoming.map(key));
      setItems(incoming);
      if (entering.size) {
        setFresh(entering);
        if (clearFresh.current) clearTimeout(clearFresh.current);
        clearFresh.current = setTimeout(() => setFresh(new Set()), 1_800);
      }
    });
    const clock = setInterval(() => setNow(Date.now()), 5_000);
    return () => { unsubscribe(); clearInterval(clock); if (clearFresh.current) clearTimeout(clearFresh.current); };
  }, [subscribe]);

  return (
    <section aria-labelledby="activity-heading" className="overflow-hidden rounded-2xl border border-line bg-paper">
      <div className="flex min-h-14 items-center justify-between border-b border-line px-4">
        <h2 id="activity-heading" className="flex items-center gap-2 text-sm font-semibold text-ink"><Activity size={14} aria-hidden="true" className="text-muted" />Activity</h2>
        <span className="text-[11px] text-muted">Launches & trades</span>
      </div>
      <ul aria-label="Recent launches and trades" tabIndex={0} className="max-h-[27rem] overflow-y-auto overscroll-contain divide-y divide-line bb-scroll">
        {items.length === 0 ? <li className="px-4 py-8"><p className="text-sm text-ink">Waiting for the first launch.</p><p className="mt-1 text-xs leading-relaxed text-muted">New launches and trades will appear here.</p></li> : null}
        {items.map((item) => {
          const k = key(item);
          const buy = item.kind === "swap" && item.is_buy;
          const Icon = item.kind === "launch" ? Plus : buy ? ArrowDownLeft : ArrowUpRight;
          const tone = item.kind === "launch" ? "text-body" : buy ? "text-up" : "text-down-ink";
          return (
            <li key={k} className={fresh.has(k) ? "bb-tape-enter" : ""}>
              <Link href={`/t/${item.chain}/${item.token}`} className="block px-4 py-3 transition-colors hover:bg-card motion-reduce:transition-none">
                <div className="flex min-w-0 items-center gap-2">
                  <TokenAvatar chain={item.chain} token={item.token} symbol={item.symbol} image={item.image_url} size={28} className="shrink-0 rounded-lg" />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{item.name}</span>
                  <time dateTime={item.at} className="shrink-0 font-mono text-[10px] text-muted tnum" title={new Date(item.at).toUTCString()} suppressHydrationWarning>{ago(item.at, now)}</time>
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[11px]">
                  <Icon size={12} aria-hidden="true" className={tone} />
                  <span className={tone}>{item.kind === "launch" ? "Launched" : buy ? "Buy" : "Sell"}</span>
                  {item.kind === "swap" ? <span className="min-w-0 truncate font-mono text-body tnum">{fmtQuote(item.quote_wei, item.quote_decimals, item.quote_symbol)}</span> : null}
                  <QuoteBrandBadge quoteKey={item.quote_key} />
                  {item.kind === "swap" && item.is_dev ? <span className="text-warm-ink">· creator</span> : null}
                  <span className="ml-auto shrink-0 text-[10px] text-muted">{CHAIN_SHORT[item.chain]}</span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-muted">{shortAddr(item.kind === "launch" ? item.launcher : item.trader)}{item.kind === "launch" && item.lp_fee === 0 ? <span className="font-sans"> · 0% trading fee</span> : null}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function key(item: FeedItem): string {
  return `${item.chain}:${item.kind}:${item.tx_hash}:${item.token}${item.kind === "swap" ? `:${item.log_index}` : ""}`;
}
