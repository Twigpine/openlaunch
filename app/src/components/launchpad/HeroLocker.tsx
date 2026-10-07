"use client";

import { useEffect, useRef, useState } from "react";
import LaunchMachine from "./LaunchMachine";
import { useLive } from "./LiveProvider";
import { CHAIN_LABELS } from "@/lib/chainPublic";
import { feedKey } from "@/lib/launchpad/river";
import { coinActive, pickLaunch, type CoinReaction, COIN_LIFE_MS } from "@/lib/launchpad/hero-coin";

/**
 * The hero's locker, reacting to real launches: for 15 seconds after a new one the caption says where it happened and
 * the coin wears its picture (hero-coin.ts holds the rules: our own images only, no look-alikes, never a name).
 * It reads the shared poll and takes its clock from it, so there is no timer here. `imageBase` is the server's image host.
 */
export default function HeroLocker({ imageBase }: { imageBase: string | null }) {
  const { live, subscribe } = useLive();
  // the launches the page was drawn with never react: only ones that arrive after it
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(live.feed.filter((item) => item.kind === "launch").map(feedKey));
  const [reaction, setReaction] = useState<CoinReaction | null>(null);
  useEffect(() => subscribe((data) => {
    const picked = pickLaunch(data.feed, seen.current ?? new Set(), data.at, imageBase);
    seen.current = picked.seen;
    setReaction((cur) => picked.reaction ?? (cur && data.at - cur.since >= COIN_LIFE_MS ? null : cur));
  }), [subscribe, imageBase]);
  const active = coinActive(reaction, live.at);
  return <LaunchMachine coin={active && reaction.src ? { key: reaction.key, src: reaction.src } : null} eyebrow={active ? `New launch on ${CHAIN_LABELS[reaction.chain]}` : undefined} />;
}
