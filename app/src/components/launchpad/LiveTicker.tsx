"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useLive } from "./LiveProvider";
import { ChainLogo } from "./ChainLogo";
import { CHAIN_LABELS } from "@/lib/chainPublic";
import { feedKey, riverUsd } from "@/lib/launchpad/river";
import { ago } from "@/lib/launchpad/time";
import styles from "./LiveTicker.module.css";

/**
 * One line that closes the hero: the newest thing that happened on the network, as a pulse. Chains and dollar amounts
 * only: no token name or picture sits in the hero's own space (Trending and the live panel just below carry those).
 * It reads the shared poll and takes its clock from it, so there is no timer here; a new event fades in on its own key.
 */
export default function LiveTicker({ className = "" }: { className?: string }) {
  const { live } = useLive();
  // the newest event worth a line: a launch, or a trade of a dollar or more (an unpriced one counts); a quiet feed shows its newest
  const item = live.feed.find((e) => e.kind === "launch" || e.usd === null || e.usd >= 1) ?? live.feed[0];
  if (!item) return null;
  const chain = CHAIN_LABELS[item.chain];
  const kind = item.kind === "launch" ? "launch" : item.is_buy ? "buy" : "sell";
  const what = item.kind === "launch" ? `New launch on ${chain}` : `${item.is_buy ? "Buy" : "Sell"}${item.usd !== null ? ` ${riverUsd(item.usd)}` : ""} on ${chain}`;
  return (
    <p className={`${styles.ticker} ${styles[kind]} ${className}`}>
      <span aria-hidden="true" className={styles.dot} />
      <span className={styles.label}>Latest</span>
      <Link key={feedKey(item)} href={`/t/${item.chain}/${item.token}`} className={`${styles.what} ${styles.enter}`}>
        <ChainLogo chain={item.chain} size={16} />
        <span className="truncate">{what}</span>
        <ArrowUpRight size={13} aria-hidden="true" className={styles.arrow} />
      </Link>
      <time dateTime={item.at} className={styles.age} suppressHydrationWarning>{ago(item.at, live.at)}<span className="sr-only"> ago</span></time>
    </p>
  );
}
