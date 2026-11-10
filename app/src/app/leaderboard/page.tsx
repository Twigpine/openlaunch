import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Trophy } from "lucide-react";
import shell from "@/components/sections/SectionShell.module.css";
import NamesProvider from "@/components/profile/NamesProvider";
import { WhoAvatar, WhoName } from "@/components/profile/Who";
import BoardRefresh from "@/components/points/BoardRefresh";
import YourStanding from "@/components/points/YourStanding";
import { whyText } from "@/components/points/why";
import { memo } from "@/lib/launchpad/memo";
import { RULES } from "@/lib/points/score";
import { boardRows, publicSeason, seasonEnded, seasonFinal, type Board } from "@/lib/points/server";
import { pageMetadata } from "@/lib/seo";
import { getLocale, getTranslations } from "@/i18n/server";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("account");
  return pageMetadata({ path: "/leaderboard", title: t("leaderboard.title"), description: t("leaderboard.description") });
}

/** Whole days until a season ends (0 once it has). */
function daysLeft(endsAt: string): number {
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000));
}

/** The public season's Creators and Scouts boards, your own standing, or the "almost here" teaser before a season is public. */
export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<{ board?: string }> }) {
  const { board: raw } = await searchParams;
  const board: Board = raw === "scout" ? "scout" : "creator";
  const season = await memo("points:public-season", 10_000, publicSeason);
  const t = await getTranslations("account");

  if (!season) {
    return (
      <main className={shell.page}>
        <section className="rounded-2xl border border-line bg-card p-6 sm:p-10">
          <p className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-line px-3 text-xs font-medium text-body"><Trophy size={14} className="text-brand" aria-hidden="true" />{t("leaderboard.seasonPoints")}</p>
          <h1 className="mt-5 max-w-2xl text-[32px] font-bold leading-[1.1] tracking-[-0.04em] text-ink text-balance sm:text-[44px]">{t("leaderboard.soonTitle")}</h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-body text-pretty">{t("leaderboard.soonCopy", { days: RULES.eligibleMinAgeDays, followers: RULES.eligibleMinFollowers })}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/me" className={shell.action}>{t("leaderboard.createProfile")} <ArrowRight size={15} aria-hidden="true" /></Link>
            <Link href="/rules#points" className={shell.textLink}>{t("points.howItWorks")}</Link>
          </div>
        </section>
        {/* a teaser left open shows the boards once the season is published */}
        <BoardRefresh />
      </main>
    );
  }

  const data = await memo(`points:board:${season.id}:${board}`, 30_000, () => boardRows(season.id, board));
  const left = daysLeft(season.ends_at);
  const ended = seasonEnded(season);
  const final = seasonFinal(season); // the final compute ran: until then the board may still move
  // "en" formats as "en-US" did: "Oct 14"; Chinese reads "10月14日"
  const endDate = new Date(season.ends_at).toLocaleDateString(await getLocale(), { month: "short", day: "numeric", timeZone: "UTC" });
  const tab = (b: Board, label: string) => (
    <Link href={b === "creator" ? "/leaderboard" : "/leaderboard?board=scout"} aria-current={board === b ? "page" : undefined} className={`inline-flex min-h-10 items-center rounded-xl px-4 text-sm font-semibold ${board === b ? "bg-ink text-inverse" : "text-body hover:bg-paper hover:text-ink"}`}>{label}</Link>
  );
  const names = Object.fromEntries(data.rows.map((r) => [r.wallet, data.names[r.wallet] ?? null]));

  return (
    <NamesProvider names={names}>
      <main className={shell.page}>
        <section className="rounded-2xl border border-line bg-card p-6 sm:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-line px-3 text-xs font-medium text-body"><Trophy size={14} className="text-brand" aria-hidden="true" />{season.name}</p>
              <h1 className="mt-4 text-[32px] font-bold leading-[1.1] tracking-[-0.04em] text-ink sm:text-[44px]">{t("leaderboard.title")}</h1>
              <p className="mt-2 max-w-xl text-sm text-body text-pretty">{t.rich("leaderboard.intro", { link: (chunks) => <Link href="/rules#points" className="underline underline-offset-4 hover:text-ink">{chunks}</Link> })}</p>
            </div>
            <div className="text-left sm:text-right">
              {ended ? (
                <>
                  <p className="text-[22px] font-bold leading-none text-ink">{final ? t("leaderboard.final") : t("leaderboard.over")}</p>
                  <p className="mt-1 text-xs text-muted">{final ? t("leaderboard.ended", { date: endDate }) : t("leaderboard.endedWaiting", { date: endDate })}</p>
                </>
              ) : (
                <>
                  <p className="font-mono text-[44px] font-bold leading-none tracking-[-0.03em] text-ink tnum sm:text-[56px]">{left}</p>
                  <p className="mt-1 text-xs text-muted">{t("leaderboard.daysLeft", { count: left, date: endDate })}</p>
                </>
              )}
            </div>
          </div>
          <nav aria-label={t("leaderboard.boards")} className="mt-6 flex gap-1">{tab("creator", t("points.creators"))}{tab("scout", t("points.scouts"))}</nav>
        </section>

        <YourStanding board={board} />
        <BoardRefresh />

        <section aria-label={board === "creator" ? t("leaderboard.topCreators") : t("leaderboard.topScouts")} className="mt-4 overflow-hidden rounded-2xl border border-line bg-card">
          {data.rows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted">{t("leaderboard.empty")}</p>
          ) : (
            <ol className="divide-y divide-line">
              {data.rows.map((r) => (
                <li key={r.wallet} className="flex items-center gap-3 px-4 py-3 sm:gap-4 sm:px-5">
                  <span className={`w-8 shrink-0 text-right font-mono text-sm tnum ${r.rank <= 3 ? "font-bold text-brand" : "text-muted"}`}>{r.rank}</span>
                  <WhoAvatar address={r.wallet} size={32} />
                  <div className="min-w-0 flex-1">
                    <WhoName address={r.wallet} className="text-[14px]" />
                    {r.why ? <p className="mt-0.5 truncate text-xs text-muted">{whyText(r.why, (key, values) => t(`points.why.${key}`, values))}</p> : null}
                  </div>
                  <span className="shrink-0 font-mono text-[15px] font-bold text-ink tnum">{r.points.toLocaleString("en-US")}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </NamesProvider>
  );
}
