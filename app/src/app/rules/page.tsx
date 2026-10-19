import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, CircleAlert, Coins, FileCode2, LockKeyhole, Rocket, Trophy } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import styles from "@/components/sections/RulesGuide.module.css";
import { launchpad } from "@/lib/launchpad/config";
import { CHAINS, CHAIN_KEYS, CHAIN_LABELS, explorerAddress } from "@/lib/chainPublic";
import { BRAND_GITHUB } from "@/lib/brand";
import LaunchMachine from "@/components/launchpad/LaunchMachine";
import { ChainLogo } from "@/components/launchpad/ChainLogo";
import BoostRulesEntry from "@/components/launchpad/BoostRulesEntry";
import { boostEnabled } from "@/lib/launchpad/boostServer";
import { RULES } from "@/lib/points/score";
import { getTranslations } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("info");
  return pageMetadata({ path: "/rules", title: t("rules.meta.title"), description: t("rules.meta.description") });
}

// title, description and label are messages: info.rules.launch.steps.<key>
const STEPS = [
  { key: "token", value: "1B" },
  { key: "market", value: "v4" },
  { key: "lock", value: "100%" },
  { key: "fees", value: "0 / 1 / 3%" },
] as const;

// title and description are messages: info.rules.fixed.<key>
const FIXED = ["noFee", "noWithdrawal", "noPremine", "noAdmin", "anyPair"] as const;

/** The guide's sections, each with the mark its heading carries (titles: info.rules.contents.<id>). */
const CONTENTS = [
  ["launchpad", Rocket], ["fees", Coins], ["immutable", LockKeyhole], ["points", Trophy], ["know", CircleAlert], ["contracts", FileCode2],
] as const;

/** Verification records stay chain-specific and point to each deployed contract. */
const VERIFIERS: Record<(typeof CHAIN_KEYS)[number], { name: string; url: (addr: string) => string }[]> = {
  base: [
    { name: "Basescan", url: (a) => `https://basescan.org/address/${a}#code` },
    { name: "Blockscout", url: (a) => `https://base.blockscout.com/address/${a}?tab=contract` },
    { name: "Sourcify", url: (a) => `https://repo.sourcify.dev/8453/${a}` },
  ],
  robinhood: [
    { name: "Blockscout", url: (a) => `https://robinhoodchain.blockscout.com/address/${a}?tab=contract` },
    { name: "Sourcify", url: (a) => `https://repo.sourcify.dev/4663/${a}` },
  ],
  arc: [
    { name: "Arc Explorer", url: (a) => `https://explorer.arc.io/address/${a}?tab=contract` },
    { name: "Sourcify", url: (a) => `https://repo.sourcify.dev/5042/${a}` },
  ],
};

/** The rules: launching, fees, posting, and how Season points are earned (no cash value, not a token). */
export default async function RulesPage() {
  const t = await getTranslations("info");
  const tc = await getTranslations("common");
  // the numbers the points rules quote, under the names their messages use
  const points = { ...RULES, sniperSeconds: RULES.sniperMs / 1000 };
  return (
    <main className={`${shell.page} ${styles.guide}`}>
      <SectionIntro eyebrow={t("rules.eyebrow")} icon={<BookOpen />} title={t("rules.title")} description={t("rules.description")}>
        <Link href="/launch" className={shell.action}>{tc("launchToken")} <ArrowRight size={15} aria-hidden="true" /></Link>
        <a href="#contracts" className={shell.textLink}>{t("rules.verify")} <ArrowDown size={14} aria-hidden="true" /></a>
      </SectionIntro>

      <div className={styles.layout}>
        <aside className={styles.contents}>
          <nav aria-label={t("rules.onThisPage")}>
            <p className={styles.eyebrow}>{t("rules.inThisGuide")}</p>
            <ol>
              {CONTENTS.map(([id, Icon]) => <li key={id}><a href={`#${id}`}><span aria-hidden="true"><Icon size={13} /></span>{t(`rules.contents.${id}`)}</a></li>)}
            </ol>
          </nav>
          <a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className={styles.sourceLink}><FileCode2 size={16} aria-hidden="true" /> {t("rules.readSource")} <ArrowUpRight size={13} aria-hidden="true" /></a>
        </aside>

        <div className={styles.article}>
          <section className={shell.anchorSection} id="launchpad" aria-labelledby="launch-heading">
            <div className={styles.sectionHeading}>
              <div><p className={styles.eyebrow}><Rocket size={14} aria-hidden="true" />{t("rules.contents.launchpad")}</p><h2 id="launch-heading">{t("rules.launch.headingTop")}<br />{t("rules.launch.headingBottom")}</h2></div>
              <p>{t("rules.launch.sameTransaction")} <br />{t("rules.launch.noSetup")}</p>
            </div>
            {/* the animated walk-through that also opens the home page: token, pool, lock */}
            <div className={styles.machine}><LaunchMachine /></div>
            <ol className={styles.steps}>
              {STEPS.map(({ key, value }, i) => (
                <li key={key} className={styles.step}>
                  <span className={styles.stepNumber} aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  <div className={styles.stepCopy}><h3>{t(`rules.launch.steps.${key}.title`)}</h3><p>{t(`rules.launch.steps.${key}.description`)}</p></div>
                  <div className={styles.stepValue}><strong>{value}</strong><span>{t(`rules.launch.steps.${key}.label`)}</span></div>
                </li>
              ))}
            </ol>
            <p className={styles.mechanismNote}><LockKeyhole size={15} aria-hidden="true" /><span>{t("rules.launch.note")}</span><a href="#contracts">{t("rules.launch.inspect")} <ArrowUpRight size={13} aria-hidden="true" /></a></p>
          </section>

          <section className={shell.anchorSection} id="fees" aria-labelledby="fees-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}><Coins size={14} aria-hidden="true" />{t("rules.contents.fees")}</p><h2 id="fees-heading">{t("rules.fees.heading")}</h2></div></div>
            <div className={styles.feePanel}>
              <div className={styles.platformFee}><span className={styles.eyebrow}>{t("rules.fees.platformFee")}</span><strong>0%</strong><p>{t("rules.fees.takeNothing")}<br />{t("rules.fees.gasToNetwork")}</p><a href="#contracts">{t("rules.fees.checkCode")} <ArrowUpRight size={13} aria-hidden="true" /></a></div>
              <div className={styles.tradingFees}>
                <h3>{t("rules.fees.creatorChooses")}</h3>
                <dl>
                  <div><dt>0%</dt><dd>{t("rules.fees.zero")}</dd></div>
                  <div><dt>{t("rules.fees.oneOrThree")}</dt><dd>{t("rules.fees.oneOrThreeBody")}</dd></div>
                </dl>
                <p>{t("rules.fees.fixed")}</p>
              </div>
            </div>
            <div className={styles.collectNote}>
              <div><h3>{t("rules.fees.collectHeading")}</h3><p>{t.rich("rules.fees.collect", { em: (chunks) => <em>{chunks}</em>, mono: (chunks) => <span className={styles.mono}>{chunks}</span>, dead: "0x…dEaD" })}</p></div>
              <p>{t("rules.fees.credited")}</p>
            </div>
          </section>

          <section className={shell.anchorSection} id="immutable" aria-labelledby="fixed-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}><LockKeyhole size={14} aria-hidden="true" />{t("rules.contents.immutable")}</p><h2 id="fixed-heading">{t("rules.fixed.heading")}</h2></div><a href="#contracts" className={shell.textLink}>{t("rules.fixed.readContracts")} <ArrowUpRight size={14} aria-hidden="true" /></a></div>
            <ul className={styles.fixedList}>{FIXED.map((key) => <li key={key}><span className={styles.fixedMark} aria-hidden="true"><Check size={12} strokeWidth={3} /></span><div><h3>{t(`rules.fixed.${key}.title`)}</h3><p>{t(`rules.fixed.${key}.description`)}</p></div></li>)}</ul>
          </section>

          <section className={shell.anchorSection} id="points" aria-labelledby="points-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}><Trophy size={14} aria-hidden="true" />{t("rules.contents.points")}</p><h2 id="points-heading">{t("rules.points.headingTop")}<br />{t("rules.points.headingBottom")}</h2></div><Link href="/leaderboard" className={shell.textLink}>{t("rules.points.leaderboard")} <ArrowRight size={14} aria-hidden="true" /></Link></div>
            <p className={styles.riskIntro}>{t("rules.points.intro")}</p>
            <div className={styles.questions}>
              <details open><summary>{t("rules.points.realBuyer.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t("rules.points.realBuyer.who", points)}</p><p>{t("rules.points.realBuyer.holding")}</p></div></details>
              <details open><summary>{t("rules.points.creators.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t("rules.points.creators.holders", points)}</p><p>{t("rules.points.creators.fees", points)}</p></div></details>
              <details open><summary>{t("rules.points.traders.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t("rules.points.traders.early", points)}</p><p>{t("rules.points.traders.hold", points)}</p></div></details>
              <details open><summary>{t("rules.points.board.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t("rules.points.board.answer", points)}</p></div></details>
            </div>
          </section>

          <section className={shell.anchorSection} id="know" aria-labelledby="know-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}><CircleAlert size={14} aria-hidden="true" />{t("rules.contents.know")}</p><h2 id="know-heading">{t("rules.know.headingTop")}<br />{t("rules.know.headingBottom")}</h2></div></div>
            <p className={styles.riskIntro}>{t("rules.know.intro")}</p>
            <div className={styles.questions}>
              <details open><summary>{t("rules.know.price.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t("rules.know.price.curve")}</p><p>{t("rules.know.price.snipers")}</p><p>{t("rules.know.price.firstBuy")}</p></div></details>
              <details open><summary>{t("rules.know.quiet.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t.rich("rules.know.quiet.ranking", { strong: (chunks) => <strong>{chunks}</strong> })}</p><p>{t("rules.know.quiet.hidden")}</p></div></details>
              {boostEnabled() ? <BoostRulesEntry /> : null}
              <details open><summary>{t("rules.know.change.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t("rules.know.change.answer")}</p></div></details>
              <details open><summary>{t("rules.know.twig.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t("rules.know.twig.twig")}</p><p>{t("rules.know.twig.gitlawb")}</p><p>{t("rules.know.twig.prices")}</p></div></details>
              <details open><summary>{t("rules.know.stocks.question")}<ChevronDown size={17} aria-hidden="true" /></summary><div><p>{t("rules.know.stocks.quotes")}</p><p>{t("rules.know.stocks.securities")}</p></div></details>
            </div>
          </section>

          <section className={shell.anchorSection} id="contracts" aria-labelledby="contracts-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}><FileCode2 size={14} aria-hidden="true" />{t("rules.contracts.eyebrow")}</p><h2 id="contracts-heading">{t("rules.contracts.heading")}</h2></div></div>
            <p className={styles.contractIntro}>{t("rules.contracts.intro")}</p>
            <div className={styles.registry}>
              {CHAIN_KEYS.map((chain) => {
                const config = launchpad(chain);
                return <section key={chain} className={styles.network} aria-labelledby={`${chain}-contracts`}>
                  <header><h3 id={`${chain}-contracts`}><ChainLogo chain={chain} size={18} />{CHAIN_LABELS[chain]}</h3><span>{t("rules.contracts.chainId")} <strong>{CHAINS[chain].id}</strong></span></header>
                  <dl className={styles.addresses}>{(["factory", "locker"] as const).map((kind) => {
                    const address = config[kind];
                    return <div key={kind}><dt>{t(`rules.contracts.${kind}`)}</dt><dd>{address ? <a href={explorerAddress(chain, address)} target="_blank" rel="noreferrer" aria-label={t(`rules.contracts.${kind}Address`, { chain: CHAIN_LABELS[chain], address })}><span>{address}</span><ArrowUpRight size={14} aria-hidden="true" /></a> : <span className={styles.notDeployed}>{t("rules.contracts.notDeployed")}</span>}</dd></div>;
                  })}</dl>
                  {config.factory && config.locker ? <div className={styles.verifiers}><p>{t("rules.contracts.sourceVerified")}</p>{VERIFIERS[chain].map((verifier) => <div key={verifier.name}><span>{verifier.name}</span><a href={verifier.url(config.factory!)} target="_blank" rel="noreferrer" aria-label={t("rules.contracts.factorySource", { chain: CHAIN_LABELS[chain], verifier: verifier.name })}>{t("rules.contracts.factory")} <ArrowUpRight size={12} aria-hidden="true" /></a><a href={verifier.url(config.locker!)} target="_blank" rel="noreferrer" aria-label={t("rules.contracts.lockerSource", { chain: CHAIN_LABELS[chain], verifier: verifier.name })}>{t("rules.contracts.locker")} <ArrowUpRight size={12} aria-hidden="true" /></a></div>)}</div> : null}
                </section>;
              })}
            </div>
            <p className={styles.contractNote}>{t.rich("rules.contracts.note", { github: (chunks) => <a href={BRAND_GITHUB} target="_blank" rel="noreferrer">{chunks}</a> })}</p>
          </section>

          <div className={styles.closing}><div><p className={styles.eyebrow}>{t("rules.closing.eyebrow")}</p><h2>{t("rules.closing.heading")}</h2></div><Link href="/launch" className={shell.action}>{tc("launchToken")} <ArrowRight size={15} aria-hidden="true" /></Link></div>
        </div>
      </div>
    </main>
  );
}
