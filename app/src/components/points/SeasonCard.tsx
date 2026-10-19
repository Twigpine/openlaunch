"use client";

import Link from "next/link";
import { ArrowRight, Trophy } from "lucide-react";
import { useTranslations } from "use-intl";
import { RULES } from "@/lib/points/score";
import { usePoints } from "./usePoints";
import { whyText } from "./why";

/**
 * /me: this wallet's season points. Eligible → points and ranks. Not yet → the points waiting for it and the one
 * step that unlocks them. An ended season shows its final standings. Nothing while no season is public.
 */
export default function SeasonCard({ address }: { address: string }) {
  const p = usePoints(address);
  const t = useTranslations("account");
  if (!p?.season) return null;
  const me = p.me;
  const days = Math.max(0, Math.ceil((new Date(p.season.ends_at).getTime() - p.at) / 86_400_000));
  const cell = (label: string, points: number, rank: number | null, why: string) => (
    <div className="min-w-0 rounded-xl border border-line bg-paper px-4 py-3">
      <p className="text-xs text-muted">{label}{rank ? <span className="ml-1.5 font-mono text-brand">#{rank}</span> : null}</p>
      <p className="mt-1 font-mono text-2xl font-bold text-ink tnum">{points.toLocaleString("en-US")}</p>
      {why ? <p className="mt-1 truncate text-[11px] text-muted">{whyText(why, (key, values) => t(`points.why.${key}`, values))}</p> : null}
    </div>
  );
  const step = p.reason && p.reason !== "hidden" ? p.reason : null; // a step the wallet can take itself
  // the one step that puts a wallet on the board, by what stands in the way (a hidden profile has none to take)
  const nextStep = step ? t(`season.steps.${step}`, { days: RULES.eligibleMinAgeDays, followers: RULES.eligibleMinFollowers }) : "";
  const waiting = me && !me.eligible && step && !p.season.ended;
  const howItWorks = (chunks: React.ReactNode) => <Link href="/rules#points" className="underline underline-offset-4">{chunks}</Link>;
  return (
    <section aria-labelledby="season-card" className="mb-4 rounded-2xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="season-card" className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><Trophy size={15} className="text-brand" aria-hidden="true" />{p.season.name} · {p.season.final ? t("season.final") : p.season.ended ? t("season.waitingFinal") : t("season.daysLeft", { days })}</h2>
        <Link href="/leaderboard" className="inline-flex items-center gap-1 text-xs font-medium text-body hover:text-ink">{t("leaderboard.title")} <ArrowRight size={13} aria-hidden="true" /></Link>
      </div>
      {me ? (
        <>
          {waiting ? (
            <p className="mt-3 rounded-xl bg-brand-soft px-4 py-3 text-sm text-ink">
              {t.rich("season.waiting", { total: me.total.toLocaleString("en-US"), step: nextStep, strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
          ) : null}
          {!me.eligible && p.reason === "hidden" ? <p className="mt-3 text-sm text-muted">{t("season.hidden")}</p> : null}
          <div className="mt-3 grid grid-cols-2 gap-3">{cell(t("points.creator"), me.creator, me.rank_creator, me.why_creator)}{cell(t("points.scout"), me.scout, me.rank_scout, me.why_scout)}</div>
        </>
      ) : (
        <p className="mt-3 text-sm text-body">{p.season.ended ? t.rich("season.noneEnded", { link: howItWorks }) : step ? t.rich("season.noneYetStep", { step: nextStep, link: howItWorks }) : t.rich("season.noneYet", { link: howItWorks })}</p>
      )}
    </section>
  );
}
