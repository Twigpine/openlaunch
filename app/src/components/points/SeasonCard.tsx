"use client";

import Link from "next/link";
import { ArrowRight, Trophy } from "lucide-react";
import { RULES, type PublicReason } from "@/lib/points/score";
import { usePoints } from "./usePoints";

/** The one step that puts a wallet on the board, by what stands in the way (a hidden profile has none to take). */
const NEXT_STEP: Record<PublicReason, string> = {
  no_profile: "Create your profile and verify it with one post on X",
  not_verified: "Verify your profile with one post on X",
  account_too_new: `Your X account needs to be at least ${RULES.eligibleMinAgeDays} days old`,
  few_followers: `Your X account needs at least ${RULES.eligibleMinFollowers} followers`,
  hidden: "Your profile is hidden by moderators",
};

/**
 * /me: this wallet's season points. Eligible → points and ranks. Not yet → the points waiting for it and the one
 * step that unlocks them. An ended season shows its final standings. Nothing while no season is public.
 */
export default function SeasonCard({ address }: { address: string }) {
  const p = usePoints(address);
  if (!p?.season) return null;
  const me = p.me;
  const days = Math.max(0, Math.ceil((new Date(p.season.ends_at).getTime() - p.at) / 86_400_000));
  const cell = (label: string, points: number, rank: number | null, why: string) => (
    <div className="min-w-0 rounded-xl border border-line bg-paper px-4 py-3">
      <p className="text-xs text-muted">{label}{rank ? <span className="ml-1.5 font-mono text-brand">#{rank}</span> : null}</p>
      <p className="mt-1 font-mono text-2xl font-bold text-ink tnum">{points.toLocaleString("en-US")}</p>
      {why ? <p className="mt-1 truncate text-[11px] text-muted">{why}</p> : null}
    </div>
  );
  const step = p.reason && p.reason !== "hidden" ? p.reason : null; // a step the wallet can take itself
  const waiting = me && !me.eligible && step && !p.season.ended;
  return (
    <section aria-labelledby="season-card" className="mb-4 rounded-2xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="season-card" className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><Trophy size={15} className="text-brand" aria-hidden="true" />{p.season.name} · {p.season.final ? "final standings" : p.season.ended ? "season over, waiting for the final count" : `${days} ${days === 1 ? "day" : "days"} left`}</h2>
        <Link href="/leaderboard" className="inline-flex items-center gap-1 text-xs font-medium text-body hover:text-ink">Leaderboard <ArrowRight size={13} aria-hidden="true" /></Link>
      </div>
      {me ? (
        <>
          {waiting ? (
            <p className="mt-3 rounded-xl bg-brand-soft px-4 py-3 text-sm text-ink">
              <strong>{me.total.toLocaleString("en-US")} points are waiting for you.</strong> {NEXT_STEP[step]}, and they unlock for the whole season so far with the next points update.
            </p>
          ) : null}
          {!me.eligible && p.reason === "hidden" ? <p className="mt-3 text-sm text-muted">{NEXT_STEP.hidden}.</p> : null}
          <div className="mt-3 grid grid-cols-2 gap-3">{cell("Creator", me.creator, me.rank_creator, me.why_creator)}{cell("Scout", me.scout, me.rank_scout, me.why_scout)}</div>
        </>
      ) : (
        <p className="mt-3 text-sm text-body">{p.season.ended ? "No points this season." : <>No points yet this season. Launch something people hold, or find tokens early and hold them.{step ? <> {NEXT_STEP[step]} so they count.</> : null}</>} <Link href="/rules#points" className="underline underline-offset-4">How points work</Link></p>
      )}
    </section>
  );
}
