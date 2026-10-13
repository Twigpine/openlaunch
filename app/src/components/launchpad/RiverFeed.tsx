"use client";

import Link from "next/link";
import TokenAvatar from "./TokenAvatar";
import { ChainCorner } from "./ChainLogo";
import { AnimatedList, AnimatedListItem } from "@/components/vendor/animated-list";
import type { FeedItem } from "@/lib/launchpad/queries";
import { feedKey, riverUsd, type RiverEntry } from "@/lib/launchpad/river";
import { fmtQuote } from "@/lib/launchpad/math";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { ago } from "@/lib/launchpad/time";
import { setPendingToken } from "@/lib/launchpad/token-transition";

/** Cards the column holds; the list clips to what its fixed height shows, so an arrival never changes the section's size. */
const LATEST = 4;

/** The newest events beside the river, as real links. A new one springs in at the top. */
export default function RiverFeed({ entries, now }: { entries: readonly RiverEntry[]; now: number }) {
  const latest = entries.slice(0, LATEST);
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-medium text-muted">Latest</h3>
      {latest.length === 0 ? (
        <p className="mt-2 grid h-[3.375rem] place-content-center rounded-xl border border-dashed border-line-strong px-4 text-center text-xs text-muted lg:h-[15rem]">New trades and launches show up here as they happen.</p>
      ) : (
        // phones show one (the hero's live line already carries the newest event), tablets one row of two, the desktop column four
        <AnimatedList aria-label="Latest trades and launches" className="mt-2 h-[3.375rem] overflow-hidden sm:grid sm:grid-cols-2 lg:flex lg:h-[15rem] max-sm:[&>li:nth-child(n+2)]:hidden max-lg:[&>li:nth-child(n+3)]:hidden">
          {latest.map(({ item }) => (
            <AnimatedListItem key={feedKey(item)}>
              <FeedCard item={item} now={now} />
            </AnimatedListItem>
          ))}
        </AnimatedList>
      )}
    </div>
  );
}

function FeedCard({ item, now }: { item: FeedItem; now: number }) {
  const buy = item.kind === "swap" && item.is_buy;
  const verb = item.kind === "launch" ? "Launched" : buy ? "Bought" : "Sold";
  const tone = item.kind === "launch" ? "text-ink" : buy ? "text-up" : "text-down-ink";
  const amount = item.kind === "launch" ? item.symbol : item.usd !== null ? riverUsd(item.usd) : fmtQuote(item.quote_wei, item.quote_decimals, item.quote_symbol);
  const detail = item.kind === "launch" ? `${item.lp_fee / 10_000}% fee, on ${CHAIN_SHORT[item.chain]}` : `${item.symbol} on ${CHAIN_SHORT[item.chain]}`;
  return (
    <Link
      href={`/t/${item.chain}/${item.token}`}
      prefetch={false}
      onClick={() => setPendingToken({ chain: item.chain, token: item.token, name: item.name, symbol: item.symbol, image: item.image_url })}
      className="flex h-[3.375rem] items-center gap-3 rounded-xl border border-line bg-paper/60 px-3 transition-colors hover:border-line-strong hover:bg-paper motion-reduce:transition-none"
    >
      <span className="relative shrink-0">
        <TokenAvatar chain={item.chain} token={item.token} symbol={item.symbol} image={item.image_url} size={30} className="rounded-full" />
        <ChainCorner chain={item.chain} size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-[13px] leading-tight">
          <span className={`font-medium ${tone}`}>{verb}</span>
          <span className="truncate font-semibold text-ink tnum">{amount}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted">
          {detail}
          {item.kind === "swap" && item.is_dev ? <span className="text-warm-ink">, by the creator</span> : null}
        </span>
      </span>
      <time dateTime={item.at} title={new Date(item.at).toUTCString()} className="shrink-0 self-start pt-0.5 font-mono text-[10px] text-muted tnum" suppressHydrationWarning>{ago(item.at, now)}</time>
    </Link>
  );
}
