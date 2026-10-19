import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import LaunchList from "@/components/launchpad/LaunchList";
import BoostedLane from "@/components/launchpad/BoostedLane";
import { boostLaneOrNull } from "@/lib/launchpad/boostServer";
import { BOOST_CHAIN } from "@/lib/launchpad/boost";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import { CHAIN_KEYS, CHAIN_LABELS, CHAINS, EXPLORERS, explorerAddress, type ChainKey } from "@/lib/chainPublic";
import { BRAND } from "@/lib/brand";
import { CHAIN_LANDING, chainLandingPath } from "@/lib/chainLanding";
import { hasChainPage, launchpad } from "@/lib/launchpad/config";
import { getLaunchTotalsForRequest, listLaunchesPage } from "@/lib/launchpad/queries";
import { PAGE_SIZE } from "@/lib/launchpad/paging";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { dbConfigured } from "@/lib/db";
import { pageMetadata } from "@/lib/seo";
import { nowMs } from "@/lib/launchpad/time";
import { LAYOUT_COOKIE, parseLayout } from "@/lib/launchpad/list-layout";
import { getTranslations } from "@/i18n/server";

/**
 * Metadata for /<chain>: its own title, snippet and canonical (never "/", see app/metadata.test.ts). The words are
 * messages (info.chain.<chain>); in English they are CHAIN_LANDING's, which lib/chainLanding.test.ts sizes for search.
 */
export async function chainLandingMetadata(chain: ChainKey): Promise<Metadata> {
  const t = await getTranslations("info");
  return pageMetadata({ path: chainLandingPath(chain), title: t(`chain.${chain}.title`), description: t(`chain.${chain}.description`) });
}

/**
 * The per-chain landing page: the chain's launches (the same list as the home page, pre-filtered),
 * with a heading and facts that name the chain, so "launch a token on <chain>" has a page to rank.
 */
export default async function ChainLanding({ chain }: { chain: ChainKey }) {
  if (!hasChainPage(chain)) notFound();
  const t = await getTranslations("info");
  const label = CHAIN_LABELS[chain];
  const lp = launchpad(chain);
  const usd = await ethUsd();
  const [page, totals, boost] = await Promise.all([
    listLaunchesPage({ sort: "live", window: "all", chain, filter: null, limit: PAGE_SIZE, ethUsd: usd }),
    getLaunchTotalsForRequest(usd), // the root layout already ran it this request: shared, not repeated
    chain === BOOST_CHAIN ? boostLaneOrNull(usd) : null, // boosts exist on Base only
  ]);
  const launches = totals.by_chain[chain].launches;
  const now = nowMs();
  const layout = parseLayout((await cookies()).get(LAYOUT_COOKIE)?.value);
  const others = CHAIN_KEYS.filter((k) => k !== chain && hasChainPage(k));

  return (
    <main className={shell.page}>
      <SectionIntro eyebrow={label} title={t(`chain.${chain}.heading`)} description={t(`chain.${chain}.intro`)}>
        <Link href={`/launch?chain=${chain}`} className={shell.action}>{t("chain.launchOn", { chain: label })} <ArrowRight size={15} aria-hidden="true" /></Link>
        <Link href="/rules#launchpad" className={shell.textLink}>{t("chain.howItWorks")} <ArrowRight size={14} aria-hidden="true" /></Link>
      </SectionIntro>

      <section className={shell.anchorSection} aria-labelledby="facts-heading">
        <h2 id="facts-heading" className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">{t("chain.glance", { chain: label })}</h2>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact term={t("chain.platformFee")} value="$0" note={t("chain.gas", { chain: label, gas: CHAIN_LANDING[chain].gas })} />
          <Fact term={t("chain.quotes")} value={lp.quotes.map((q) => q.symbol).join(" · ")} note={t("chain.quotesNote")} />
          <Fact term={t("chain.launches")} value={launches.toLocaleString("en-US")} note={t("chain.launchesNote", { chain: label })} />
          <Fact term={t("chain.chainId")} value={String(CHAINS[chain].id)} note={t("chain.liquidity", { chain: label })} />
        </dl>
        {lp.factory ? (
          <p className="mt-4 text-sm text-muted">
            {t.rich("chain.factory", {
              address: lp.factory,
              explorer: EXPLORERS[chain].name,
              link: (chunks) => <a href={explorerAddress(chain, lp.factory!)} target="_blank" rel="noopener noreferrer" className="font-mono text-body underline decoration-line-strong underline-offset-4 hover:text-ink break-all">{chunks}</a>,
            })}{" "}
            <ArrowUpRight size={12} aria-hidden="true" className="inline" />
          </p>
        ) : null}
      </section>

      {/* always mounted on Base, so a switch-on reaches an open tab; the margin goes with the lane (empty:hidden) */}
      {chain === BOOST_CHAIN ? <div className="mt-14 empty:hidden"><BoostedLane initial={boost ?? { enabled: false }} serverNow={now} source="base" /></div> : null}

      <section className={`${shell.anchorSection} mt-14`} aria-labelledby="chain-launches-heading">
        <h2 id="chain-launches-heading" className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">{t("chain.tokens", { chain: label })}</h2>
        <div className="mt-6">
          <LaunchList initial={page.items} initialHasMore={page.hasMore} initialSort="live" initialWindow="all" initialChain={chain} initialFilter={null} initialLayout={layout} hasDb={dbConfigured()} serverNow={now} />
        </div>
      </section>

      {others.length ? (
        <nav className={`${shell.anchorSection} mt-10`} aria-label={t("chain.others")}>
          <p className="text-sm text-muted">
            {t("chain.alsoOn")}{" "}
            {others.map((k, i) => (
              <span key={k}>
                {i ? " · " : null}
                <Link href={chainLandingPath(k)} className="text-brand underline decoration-line-strong underline-offset-4 hover:text-ink">{t("chain.brandOn", { brand: BRAND, chain: CHAIN_LABELS[k] })}</Link>
              </span>
            ))}
          </p>
        </nav>
      ) : null}
    </main>
  );
}

function Fact({ term, value, note }: { term: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <dt className="text-xs uppercase tracking-wide text-muted">{term}</dt>
      <dd className="mt-1 font-mono text-lg font-bold text-ink tnum">{value}</dd>
      <dd className="mt-2 text-xs leading-relaxed text-muted text-pretty">{note}</dd>
    </div>
  );
}
