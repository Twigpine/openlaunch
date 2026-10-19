import Link from "next/link";
import { ArrowRight } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import { CommunityPairBadge } from "@/components/launchpad/QuoteBadge";
import { pageMetadata } from "@/lib/seo";
import { loadPairs, pairStats, type PairStats } from "@/lib/launchpad/pairsServer";
import { PAIR_CHAINS, PAIR_COPY, pairPath, pairVolumeLabel, type PairPublic } from "@/lib/launchpad/pairs";
import { fmtUsd, units } from "@/lib/launchpad/math";
import { CHAIN_LABELS } from "@/lib/chainPublic";
import { applicationsOpen } from "@/lib/launchpad/pairApplyServer";
import { pairListingUsd } from "@/lib/launchpad/pairApply";

export const metadata = pageMetadata({
  path: "/pairs",
  title: "Community pairs",
  description: "Tokens a launch on openlaunch can be paired with besides ETH and TWIG. Each is listed after public checks, priced from one named pool and watched every hour.",
});
export const dynamic = "force-dynamic";

/** The community pairs (lib/launchpad/pairs.ts): listed ones first, then suspended ones with the reason. */
export default async function PairsPage() {
  const all = (await loadPairs()).filter((p) => p.status !== "delisted");
  const stats = new Map<string, PairStats>();
  for (const chain of PAIR_CHAINS) {
    const got = await pairStats(chain, all.filter((p) => p.chain === chain).map((p) => p.address)).catch(() => new Map<string, PairStats>());
    for (const [a, v] of got) stats.set(`${chain}:${a}`, v);
  }
  const listed = all.filter((p) => p.status === "listed");
  const suspended = all.filter((p) => p.status === "suspended");
  return (
    <main className={shell.page}>
      <SectionIntro eyebrow="Launchpad" title={PAIR_COPY.indexTitle} description={PAIR_COPY.indexLead}>
        <Link href="/rules" className={shell.textLink}>How launches work <ArrowRight size={14} aria-hidden="true" /></Link>
      </SectionIntro>
      <section className={`${shell.anchorSection} mt-10`} aria-labelledby="pairs-listed">
        <h2 id="pairs-listed" className="font-display text-2xl font-bold tracking-tight text-ink">Listed</h2>
        {listed.length === 0 ? <p className="mt-4 text-sm text-muted">{PAIR_COPY.indexEmpty}</p> : null}
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {listed.map((p) => <PairCard key={`${p.chain}:${p.address}`} p={p} s={stats.get(`${p.chain}:${p.address}`)} />)}
        </ul>
        <p className="mt-6 text-sm text-muted">{PAIR_COPY.noForm}</p>
        {applicationsOpen() ? (
          <p className="mt-2 text-sm text-body">
            Your community&apos;s token here?{" "}
            <Link href="/pairs/apply" className="font-semibold text-brand hover:text-ink">Check it for free and apply →</Link>{" "}
            <span className="text-muted">The fee is ${pairListingUsd()} in TWIG, burned, for a review.</span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">{PAIR_COPY.applySoon}</p>
        )}
      </section>
      {suspended.length ? (
        <section className={`${shell.anchorSection} mt-12`} aria-labelledby="pairs-suspended">
          <h2 id="pairs-suspended" className="font-display text-xl font-bold tracking-tight text-ink">Suspended</h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {suspended.map((p) => <PairCard key={`${p.chain}:${p.address}`} p={p} s={stats.get(`${p.chain}:${p.address}`)} />)}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function PairCard({ p, s }: { p: PairPublic; s: PairStats | undefined }) {
  const volUsd = s && p.usd !== null ? units(s.volume_quote, p.decimals) * p.usd : null;
  return (
    <li className="rounded-2xl border border-line bg-paper p-5">
      <div className="flex items-center justify-between gap-3">
        <Link href={pairPath(p.chain, p.address)} className="flex min-w-0 items-center gap-3">
          {p.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.logo} alt="" width={40} height={40} className="shrink-0 rounded-xl border border-line" />
          ) : (
            <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-line font-mono text-body">{p.symbol.slice(0, 1)}</span>
          )}
          <span className="min-w-0">
            <span className="block truncate font-semibold text-ink">{p.name}</span>
            <span className="block font-mono text-xs text-muted">{p.symbol} · {CHAIN_LABELS[p.chain]}</span>
          </span>
        </Link>
        {p.status === "listed" ? <CommunityPairBadge symbol={p.symbol} logo={p.logo} /> : <span className="rounded-full border border-warm/30 bg-warm-soft px-2 py-0.5 text-[11px] text-warm-ink">Suspended</span>}
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-muted">Price</dt><dd className="font-mono text-ink tnum">{p.usd !== null ? fmtUsd(p.usd) : "–"}</dd></div>
        <div><dt className="text-muted">Launches</dt><dd className="font-mono text-ink tnum">{(s?.launches ?? 0).toLocaleString("en-US")}</dd></div>
        <div><dt className="text-muted">Volume</dt><dd className="font-mono text-ink tnum">{pairVolumeLabel(volUsd)}</dd></div>
      </dl>
      {p.status === "suspended" && p.status_reason ? <p className="mt-3 text-xs text-warm-ink">{p.status_reason}</p> : null}
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        <Link href={pairPath(p.chain, p.address)} className="font-semibold text-brand hover:text-ink">Launches, checks and record →</Link>
      </div>
    </li>
  );
}
