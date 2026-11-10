import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Info } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import { BRAND, BRAND_DOMAIN, BRAND_GITHUB, BRAND_X, LEGACY_DOMAIN } from "@/lib/brand";
import { CHAIN_KEYS, CHAIN_LABELS, CHAINS } from "@/lib/chainPublic";
import { chainLandingPath } from "@/lib/chainLanding";
import { hasChainPage } from "@/lib/launchpad/config";
import { getTranslations } from "@/i18n/server";

/**
 * The entity page: the one URL that answers "what is openlaunch" in plain words, names the
 * official channels, and separates the brand from look-alikes. Facts only (CONTRIBUTING.md):
 * what the contracts do, where the code is, which accounts are ours. No claims about value.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("info");
  return pageMetadata({
    path: "/about",
    title: t("about.meta.title", { brand: BRAND }),
    description: t("about.meta.description", { brand: BRAND }),
  });
}

// title and body are messages: info.about.different.<key>
const DIFFERENCES = ["noFee", "locked", "noAdmin", "openSource", "creatorFee", "agents"] as const;

const inlineLink = "text-brand underline decoration-line-strong underline-offset-4 hover:text-ink";

export default async function AboutPage() {
  const t = await getTranslations("info");
  const tc = await getTranslations("common");
  return (
    <main className={shell.page}>
      <SectionIntro
        eyebrow={t("about.eyebrow")}
        icon={<Info />}
        title={t("about.title", { brand: BRAND })}
        description={t("about.description", { brand: BRAND })}
      >
        <Link href="/launch" className={shell.action}>{tc("launchToken")} <ArrowRight size={15} aria-hidden="true" /></Link>
        <Link href="/rules" className={shell.textLink}>{t("about.howItWorks")} <ArrowRight size={14} aria-hidden="true" /></Link>
      </SectionIntro>

      <section className={shell.anchorSection} id="different" aria-labelledby="different-heading">
        <h2 id="different-heading" className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">{t("about.different.heading", { brand: BRAND })}</h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {DIFFERENCES.map((key) => (
            <li key={key} className="rounded-2xl border border-line bg-paper p-5">
              <h3 className="text-sm font-semibold text-ink">{t(`about.different.${key}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted text-pretty">{t(`about.different.${key}.body`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${shell.anchorSection} mt-14`} id="chains" aria-labelledby="chains-heading">
        <h2 id="chains-heading" className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">{t("about.chains.heading")}</h2>
        <p className="mt-4 max-w-[40rem] text-base leading-relaxed text-body text-pretty">{t.rich("about.chains.body", { link: (chunks) => <Link href="/rules#contracts" className={inlineLink}>{chunks}</Link> })}</p>
        <dl className="mt-6 grid gap-3 sm:grid-cols-3">
          {CHAIN_KEYS.map((chain) => (
            <div key={chain} className="rounded-2xl border border-line bg-paper p-5">
              <dt className="text-sm font-semibold text-ink">{hasChainPage(chain) ? <Link href={chainLandingPath(chain)} className="hover:text-brand underline decoration-line-strong underline-offset-4">{CHAIN_LABELS[chain]}</Link> : CHAIN_LABELS[chain]}</dt>
              <dd className="mt-1 font-mono text-xs text-muted tnum">{t("about.chains.chainId", { id: CHAINS[chain].id })}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={`${shell.anchorSection} mt-14`} id="who" aria-labelledby="who-heading">
        <h2 id="who-heading" className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">{t("about.who.heading")}</h2>
        <p className="mt-4 max-w-[40rem] text-base leading-relaxed text-body text-pretty">{t("about.who.body", { brand: BRAND })}</p>
        <p className="mt-3 max-w-[40rem] text-base leading-relaxed text-body text-pretty">{t.rich("about.who.launchers", { brand: BRAND, link: (chunks) => <Link href="/rules#know" className={inlineLink}>{chunks}</Link> })}</p>
      </section>

      <section className={`${shell.anchorSection} mt-14`} id="official" aria-labelledby="official-heading">
        <h2 id="official-heading" className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-ink">{t("about.official.heading")}</h2>
        <p className="mt-4 max-w-[40rem] text-base leading-relaxed text-body text-pretty">{t("about.official.body", { brand: BRAND })}</p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-3">
          <li className="rounded-2xl border border-line bg-paper p-5">
            <p className="text-xs uppercase tracking-wide text-muted">{t("about.official.website")}</p>
            <Link href="/" className="mt-1 inline-flex items-center gap-1 font-mono text-sm text-ink hover:text-brand">{BRAND_DOMAIN}</Link>
            <p className="mt-2 text-xs leading-relaxed text-muted">{t("about.official.formerly", { legacy: LEGACY_DOMAIN })}</p>
          </li>
          <li className="rounded-2xl border border-line bg-paper p-5">
            <p className="text-xs uppercase tracking-wide text-muted">X</p>
            <a href={`https://x.com/${BRAND_X}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-sm text-ink hover:text-brand">@{BRAND_X} <ArrowUpRight size={13} aria-hidden="true" /></a>
            <p className="mt-2 text-xs leading-relaxed text-muted">{t("about.official.updates")}</p>
          </li>
          <li className="rounded-2xl border border-line bg-paper p-5">
            <p className="text-xs uppercase tracking-wide text-muted">{t("about.official.source")}</p>
            <a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-sm text-ink hover:text-brand">Twigpine/openlaunch <ArrowUpRight size={13} aria-hidden="true" /></a>
            <p className="mt-2 text-xs leading-relaxed text-muted">{t("about.official.original")}</p>
          </li>
        </ul>
      </section>

      <div className="mt-12 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Link href="/launch" className={shell.action}>{tc("launchToken")} <ArrowRight size={15} aria-hidden="true" /></Link>
        <Link href="/agents" className={shell.textLink}>{t("about.fromAgent")} <ArrowRight size={14} aria-hidden="true" /></Link>
      </div>
    </main>
  );
}
