"use client";

import Link from "next/link";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { usePoints } from "./usePoints";

/** The connected wallet's place on the board in view, or what is waiting for it until its profile is verified. */
export default function YourStanding({ board }: { board: "creator" | "scout" }) {
  const { address } = useHydratedAccount();
  const p = usePoints(address);
  if (!address || !p?.season || !p.me) return null;
  const ended = p.season.ended;
  const me = p.me;
  const points = board === "creator" ? me.creator : me.scout;
  const rank = board === "creator" ? me.rank_creator : me.rank_scout;
  const why = board === "creator" ? me.why_creator : me.why_scout;
  return (
    <section aria-label="Your standing" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand/30 bg-brand-soft px-5 py-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-brand">You</p>
        <p className="text-sm text-ink">{me.eligible ? (rank ? <>Rank <strong className="font-mono tnum">#{rank}</strong></> : "Not ranked on this board") : ended ? "Not on the final board" : <>Your points are waiting. <Link href="/me" className="font-semibold underline underline-offset-4">See what unlocks them</Link>.</>}{why ? <span className="text-muted"> · {why}</span> : null}</p>
      </div>
      <span className="font-mono text-xl font-bold text-ink tnum">{points.toLocaleString("en-US")}</span>
    </section>
  );
}
