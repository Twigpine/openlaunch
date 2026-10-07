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
import { getProfile, namesFor } from "@/lib/profiles/server";
import { walletFacts } from "@/lib/profiles/stats";
import { normalizeUsername } from "@/lib/profiles/validate";
import { getWalletTrades, listLaunches } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { memo } from "@/lib/launchpad/memo";
import { fmtUsd } from "@/lib/launchpad/math";
import { ago, nowMs } from "@/lib/launchpad/time";
import { CHAIN_SHORT, SITE_URL, explorerTx } from "@/lib/chainPublic";
import { BRAND_DOMAIN, BRAND_X } from "@/lib/brand";

export const dynamic = "force-dynamic";

/** The profile behind a /u/<username> path (normalized; 5 s memo), or null. */
async function load(raw: string) {
  const username = normalizeUsername(decodeURIComponent(raw));
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return null;
  return memo(`u:${username}`, 5_000, () => getProfile({ username }));
}

/** Title and link-card metadata for a profile; unverified profiles stay out of search. */
export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  const p = await load(username);
  if (!p) return { title: "Profile not found", robots: { index: false } };
  const title = `${p.display_name} (${p.username})`;
  const description = p.bio || `${p.display_name} on ${BRAND_DOMAIN}: tokens launched and trades, straight from the chain.`;
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
  const names = await namesFor([p.wallet]);
  const now = nowMs();
  const joined = new Date(p.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

  return (
    <NamesProvider names={{ [p.wallet]: names[p.wallet] ?? null }}>
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
                    {p.x.post_id ? <span className="sr-only">, verified by a public post</span> : null}
                  </a>
                ) : null}
                <CopyChip value={p.wallet} />
                <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line px-3 text-muted"><CalendarDays size={13} aria-hidden="true" />Joined {joined}</span>
              </div>
            </div>
          </div>
          <dl className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line">
            {[
              { k: "Tokens launched", v: facts.launches, icon: <Layers3 size={14} aria-hidden="true" /> },
              { k: "Holders of their tokens", v: facts.holders, icon: <Users size={14} aria-hidden="true" /> },
              { k: "Trades", v: facts.trades, icon: <Repeat2 size={14} aria-hidden="true" /> },
            ].map((s) => (
              <div key={s.k} className="min-w-0 bg-card px-4 py-4 sm:px-5">
                <dt className="flex items-center gap-1.5 truncate text-[12px] text-muted">{s.icon}{s.k}</dt>
                <dd className="mt-1.5 font-mono text-[22px] font-bold text-ink tnum sm:text-[26px]">{s.v.toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] text-muted">Every number here is read from the chain. {p.x ? "The ✓ means this wallet posted a one-time code from that X account." : "No ✓: this profile has not verified an X account."}</p>
        </section>

        <section aria-labelledby="profile-launches" className="mt-8">
          <h2 id="profile-launches" className="text-[15px] font-semibold text-ink">Launched</h2>
          {launches.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-line bg-card px-5 py-8 text-center text-sm text-muted">No launches yet.</p>
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
          <h2 id="profile-trades" className="text-[15px] font-semibold text-ink">Recent trades</h2>
          {trades.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-line bg-card px-5 py-8 text-center text-sm text-muted">No trades yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card">
              {trades.map((t) => {
                const Icon = t.is_buy ? ArrowDownLeft : ArrowUpRight;
                return (
                  <li key={t.tx_hash + t.token} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <span className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-semibold ${t.is_buy ? "bg-up-soft text-up" : "bg-down-soft text-down-ink"}`}><Icon size={12} aria-hidden="true" />{t.is_buy ? "Buy" : "Sell"}</span>
                    <Link href={`/t/${t.chain}/${t.token}`} className="min-w-0 truncate font-medium text-ink hover:underline underline-offset-2">{t.name} <span className="font-mono text-muted">{t.symbol}</span></Link>
                    <span className="ml-auto shrink-0 font-mono text-body tnum">{t.usd !== null ? fmtUsd(t.usd) : t.quote_symbol}</span>
                    <span className="hidden shrink-0 text-xs text-muted sm:inline">{CHAIN_SHORT[t.chain]}</span>
                    <a href={explorerTx(t.chain, t.tx_hash)} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-xs text-muted hover:text-ink tnum">{ago(t.block_time, now)}<span className="sr-only"> ago, view transaction</span></a>
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
