"use client";

import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Plus } from "lucide-react";
import TokenAvatar from "./TokenAvatar";
import { QuoteBrandBadge } from "./MuseworldBadge";
import type { FeedItem } from "@/lib/launchpad/queries";
import { fmtQuote } from "@/lib/launchpad/math";
import { CHAIN_SHORT, shortAddr } from "@/lib/chainPublic";
import { ago } from "@/lib/launchpad/time";
import { feedKey } from "@/lib/launchpad/river";

/** Recent launches and trades as rows of links: the river's list view, and the same events for screen readers. */
export function TapeList({ items, now, fresh, label = "Recent launches and trades", className = "" }: { items: readonly FeedItem[]; now: number; fresh?: ReadonlySet<string>; label?: string; className?: string }) {
  return (
    <ul aria-label={label} tabIndex={0} className={`overflow-y-auto overscroll-contain divide-y divide-line bb-scroll ${className}`}>
      {items.length === 0 ? <li className="px-4 py-8"><p className="text-sm text-ink">Nothing in the last 30 minutes.</p><p className="mt-1 text-xs leading-relaxed text-muted">New launches and trades will appear here as they happen.</p></li> : null}
      {items.map((item) => {
        const k = feedKey(item);
        const buy = item.kind === "swap" && item.is_buy;
        const Icon = item.kind === "launch" ? Plus : buy ? ArrowDownLeft : ArrowUpRight;
        const tone = item.kind === "launch" ? "text-body" : buy ? "text-up" : "text-down-ink";
        return (
          <li key={k} className={fresh?.has(k) ? "bb-tape-enter" : ""}>
            <Link href={`/t/${item.chain}/${item.token}`} prefetch={false} className="block px-4 py-3 transition-colors hover:bg-card motion-reduce:transition-none">
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
                {item.kind === "swap" && item.is_dev ? <span className="text-warm-ink">by the creator</span> : null}
                <span className="ml-auto shrink-0 text-[10px] text-muted">{CHAIN_SHORT[item.chain]}</span>
              </div>
              <p className="mt-1 font-code text-[10px] text-muted">{shortAddr(item.kind === "launch" ? item.launcher : item.trader)}{item.kind === "launch" && item.lp_fee === 0 ? <span className="font-sans">, 0% trading fee</span> : null}</p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
