import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowDownLeft, ArrowUpRight, CalendarDays, Layers3, Repeat2, Users } from "lucide-react";
import shell from "@/components/sections/SectionShell.module.css";
import LaunchCard from "@/components/launchpad/LaunchCard";
import CopyChip from "@/components/launchpad/CopyChip";
import { XMark } from "@/components/launchpad/BrandMarks";
import NamesProvider from "@/components/profile/NamesProvider";
import { VerifiedTick, WhoAvatar } from "@/components/profile/Who";
import { getProfile } from "@/lib/profiles/server";
import { walletFacts } from "@/lib/profiles/stats";
import { usernameFromPath } from "@/lib/profiles/validate";
import { getWalletTrades, listLaunches } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { memo } from "@/lib/launchpad/memo";
import { fmtUsd } from "@/lib/launchpad/math";
import { agoParts, nowMs } from "@/lib/launchpad/time";
import { CHAIN_SHORT, SITE_URL, explorerTx } from "@/lib/chainPublic";
import { BRAND_DOMAIN, BRAND_X } from "@/lib/brand";
import { publicSeason, walletPoints } from "@/lib/points/server";
import { getLocale, getTranslations } from "@/i18n/server";
import { Trophy } from "lucide-react";

export const dynamic = "force-dynamic";

/** The profile behind a /u/<username> path (normalized; 5 s memo), or null. */
async function load(raw: string) {
  const username = usernameFromPath(raw);
  if (!username) return null;
  return memo(`u:${username}`, 5_000, () => getProfile({ username }));
}

/** Title and link-card metadata for a profile; unverified profiles stay out of search. */
export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  const p = await load(username);
  const t = await getTranslations("account");
  if (!p) return { title: t("profile.notFound"), robots: { index: false } };
  const title = `${p.display_name} (${p.username})`;
  const description = p.bio || t("profile.description", { name: p.display_name, domain: BRAND_DOMAIN });
  return {
    title,
    description,
    alternates: { canonical: `${SITE_URL}/u/${p.username}` },
    // unverified profiles stay out of search: anyone can make one, only the X post proves who it is
    robots: p.x_state === "verified" ? undefined : { index: false, follow: true },
    openGraph: { siteName: BRAND_DOMAIN, type: "profile", title, description, url: `${SITE_URL}/u/${p.username}` },
    twitter: { card: "summary_large_image", site: `@${BRAND_X}`, title, description },
  };
}

/** A public profile: name, verified X account, on-chain counts, launches and recent trades. */
export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const p = await load(username);
  if (!p) notFound();
  const usd = await ethUsd();
  const [facts, launches, trades] = await Promise.all([
    memo(`u-facts:${p.wallet}`, 10_000, () => walletFacts(p.wallet)),
    memo(`u-launches:${p.wallet}`, 10_000, () => listLaunches({ launcher: p.wallet, limit: 24, ethUsd: usd })),
    memo(`u-trades:${p.wallet}`, 10_000, () => getWalletTrades(p.wallet, usd, 20)),
  ]);
  // the owner's name comes from the profile this page just read, not from a separately cached lookup
  const ownName = { u: p.username, d: p.display_name, a: p.avatar_url, v: p.x_state === "verified" };
  // season points, once the season is public, for a wallet that qualifies
  // fails soft: a points hiccup never takes the profile page down
  const season = await memo("points:public-season", 10_000, publicSeason).catch(() => null);
  const pts = season ? await memo(`points:me:${season.id}:${p.wallet}`, 10_000, () => walletPoints(season.id, p.wallet)).catch(() => null) : null;
  const showPts = Boolean(season && pts && pts.eligible && pts.total > 0);
  const now = nowMs();
  const [t, tc, locale] = await Promise.all([getTranslations("account"), getTranslations("common"), getLocale()]);
  // "en" formats as "en-US" did: "Oct 2026"; Chinese reads "2026年10月"
  const joined = new Date(p.created_at).toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
  /** A season board's points, with the rank when there is one: "Creator #3 · 1,234 pts". */
  const boardPoints = (board: "creator" | "scout", rank: number | null, points: number) => {
    const values = { board: t(`points.${board}`), rank: String(rank), points: points.toLocaleString("en-US") };
    const tags = { strong: (chunks: React.ReactNode) => <strong className="font-mono">{chunks}</strong>, mono: (chunks: React.ReactNode) => <span className="font-mono tnum">{chunks}</span> };
    return rank ? t.rich("profile.pointsRanked", { ...values, ...tags }) : t.rich("profile.pointsUnranked", { ...values, ...tags });
  };

  return (
    <NamesProvider names={{ [p.wallet]: ownName }}>
      <main className={shell.page}>
        <section aria-labelledby="profile-name" className="rounded-2xl border border-line bg-card p-5 sm:p-7">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <WhoAvatar address={p.wallet} size={88} />
            <div className="min-w-0 flex-1">
              <h1 id="profile-name" className="flex min-w-0 items-center gap-2 text-[28px] font-bold leading-tight tracking-[-0.03em] text-ink sm:text-[34px]">
                <span className="truncate">{p.display_name}</span>
                {p.x ? <VerifiedTick size={24} /> : null}
              </h1>
              <p className="mt-1 text-[15px] text-muted">{p.username}</p>
              {p.bio ? <p className="mt-3 max-w-2xl whitespace-pre-wrap break-words text-[14px] leading-relaxed text-body text-pretty">{p.bio}</p> : null}
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                {p.x ? (
                  <a href={`https://x.com/${p.x.handle}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line px-3 font-medium text-body hover:border-line-strong hover:text-ink">
                    <XMark />@{p.x.handle}
                    {p.x.post_id ? <span className="sr-only">{t("profile.verifiedByPost")}</span> : null}
                  </a>
                ) : null}
                <CopyChip value={p.wallet} />
                <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line px-3 text-muted"><CalendarDays size={13} aria-hidden="true" />{t("profile.joined", { date: joined })}</span>
              </div>
            </div>
          </div>
          <dl className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line">
            {[
              { k: t("profile.stats.launched"), v: facts.launches, icon: <Layers3 size={14} aria-hidden="true" /> },
              { k: t("profile.stats.holders"), v: facts.holders, icon: <Users size={14} aria-hidden="true" /> },
              { k: t("profile.stats.trades"), v: facts.trades, icon: <Repeat2 size={14} aria-hidden="true" /> },
            ].map((s) => (
              <div key={s.k} className="min-w-0 bg-card px-4 py-4 sm:px-5">
                <dt className="flex items-center gap-1.5 truncate text-[12px] text-muted">{s.icon}{s.k}</dt>
                <dd className="mt-1.5 font-mono text-[22px] font-bold text-ink tnum sm:text-[26px]">{s.v.toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
          {showPts && season && pts ? (
            <Link href="/leaderboard" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-brand/30 bg-brand-soft px-4 py-3 text-sm text-ink hover:border-brand/60">
              <span className="inline-flex items-center gap-1.5 font-semibold"><Trophy size={14} className="text-brand" aria-hidden="true" />{season.name}</span>
              {pts.creator > 0 ? <span>{boardPoints("creator", pts.rank_creator, pts.creator)}</span> : null}
              {pts.scout > 0 ? <span>{boardPoints("scout", pts.rank_scout, pts.scout)}</span> : null}
            </Link>
          ) : null}
          <p className="mt-3 text-[11px] text-muted">{p.x ? t("profile.noteVerified") : t("profile.noteUnverified")}</p>
        </section>

        <section aria-labelledby="profile-launches" className="mt-8">
          <h2 id="profile-launches" className="text-[15px] font-semibold text-ink">{t("profile.launched")}</h2>
          {launches.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-line bg-card px-5 py-8 text-center text-sm text-muted">{t("profile.noLaunches")}</p>
          ) : (
            <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-4">
              {launches.map((l) => (
                <li key={`${l.chain}:${l.token}`} className="list-none">
                  <LaunchCard l={l} now={now} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="profile-trades" className="mt-8">
          <h2 id="profile-trades" className="text-[15px] font-semibold text-ink">{t("profile.recentTrades")}</h2>
          {trades.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-line bg-card px-5 py-8 text-center text-sm text-muted">{t("profile.noTrades")}</p>
          ) : (
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card">
              {trades.map((trade) => {
                const Icon = trade.is_buy ? ArrowDownLeft : ArrowUpRight;
                const { n, unit } = agoParts(trade.block_time, now);
                return (
                  <li key={`${trade.chain}:${trade.tx_hash}:${trade.log_index}`} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <span className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-semibold ${trade.is_buy ? "bg-up-soft text-up" : "bg-down-soft text-down-ink"}`}><Icon size={12} aria-hidden="true" />{trade.is_buy ? t("profile.buy") : t("profile.sell")}</span>
                    <Link href={`/t/${trade.chain}/${trade.token}`} className="min-w-0 truncate font-medium text-ink hover:underline underline-offset-2">{trade.name} <span className="font-mono text-muted">{trade.symbol}</span></Link>
                    <span className="ml-auto shrink-0 font-mono text-body tnum">{trade.usd !== null ? fmtUsd(trade.usd) : trade.quote_symbol}</span>
                    <span className="hidden shrink-0 text-xs text-muted sm:inline">{CHAIN_SHORT[trade.chain]}</span>
                    <a href={explorerTx(trade.chain, trade.tx_hash)} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-xs text-muted hover:text-ink tnum">{t.rich("profile.tradeTime", { time: tc(`time.${unit}`, { n }), sr: (chunks) => <span className="sr-only">{chunks}</span> })}</a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </NamesProvider>
  );
}
