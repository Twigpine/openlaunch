import Link from "next/link";
import { ArrowRight, ArrowUp, ArrowUpRight, FileCode2 } from "lucide-react";
import { BRAND, BRAND_DOMAIN, BRAND_GITHUB, BRAND_X } from "@/lib/brand";
import { CHAIN_KEYS, CHAIN_LABELS, CHAINS, explorerAddress } from "@/lib/chainPublic";
import { hasChainPage, launchpad } from "@/lib/launchpad/config";
import { chainLandingPath } from "@/lib/chainLanding";
import Mark from "./launchpad/Mark";
import { getTranslations } from "@/i18n/server";
import type { Messages } from "@/i18n/messages";
import styles from "./Footer.module.css";

// labels are messages: footer.links.<key>
const EXPLORE = [
  { href: "/", key: "launchpad" },
  { href: "/rules", key: "rules" },
  { href: "/about", key: "about" },
  { href: "/feed", key: "feed" },
  { href: "/me", key: "me" },
] as const;
const BUILD = [
  { href: "/agents", key: "agents" },
  { href: BRAND_GITHUB, key: "source", external: true },
  { href: "/llms.txt", key: "llms" },
  { href: `https://x.com/${BRAND_X}`, key: "x", external: true },
] as const;

/** Shared server-rendered footer. Proof links come from the deployed configuration. */
export default async function Footer() {
  const t = await getTranslations("footer");
  const tc = await getTranslations("common");
  const label = (links: ReadonlyArray<{ href: string; key: keyof Messages["footer"]["links"]; external?: boolean }>) => links.map(({ key, ...link }) => ({ ...link, label: t(`links.${key}`) }));
  return (
    <footer id="site-footer" className={`bb-footer ${styles.footer}`} aria-label={t("label")}>
      <div className={styles.shell}>
        <div className={styles.main}>
          <div className={styles.invitation}>
            <div className={styles.eyebrow}>
              <span aria-hidden="true"><Mark size={24} /></span>
              {t("eyebrow")}
            </div>
            <h2 className={styles.heading}>{t("headingTop")}<br /><span>{t("headingBottom")}</span></h2>
            <p className={styles.description}>{t("descriptionTop")}<br />{t("descriptionBottom")}</p>
            <Link href="/launch" className={styles.launch}>
              {tc("launchToken")} <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>

          <nav className={styles.navigation} aria-label={t("navigation")}>
            <LinkGroup title={t("explore")} links={label(EXPLORE)} />
            <LinkGroup title={t("build")} links={label(BUILD)} />
          </nav>
        </div>

        <div className={styles.proof}>
          <div className={styles.proofIntro}>
            <FileCode2 size={20} aria-hidden="true" />
            <div>
              <p className={styles.proofTitle}>{t("proofTitle")}</p>
              <Link href="/rules#contracts" className={styles.verification}>{t("verify")} <ArrowUpRight size={13} aria-hidden="true" /></Link>
            </div>
          </div>
          {CHAIN_KEYS.map((chain) => {
            const { factory, locker } = launchpad(chain);
            return (
              <div className={styles.chain} key={chain}>
                <div className={styles.chainName}>{hasChainPage(chain) ? <Link href={chainLandingPath(chain)} className="hover:underline underline-offset-4">{CHAIN_LABELS[chain]}</Link> : CHAIN_LABELS[chain]}<span className={styles.chainId}>{CHAINS[chain].id}</span></div>
                <div className={styles.contracts}>
                  {factory ? <a href={explorerAddress(chain, factory)} target="_blank" rel="noreferrer" aria-label={t("factoryOnExplorer", { chain: CHAIN_LABELS[chain] })} title={factory}>{t("factory")} <ArrowUpRight size={12} aria-hidden="true" /></a> : <span className={styles.unconfigured}>{t("factoryMissing")}</span>}
                  {locker ? <a href={explorerAddress(chain, locker)} target="_blank" rel="noreferrer" aria-label={t("lockerOnExplorer", { chain: CHAIN_LABELS[chain] })} title={locker}>{t("locker")} <ArrowUpRight size={12} aria-hidden="true" /></a> : <span className={styles.unconfigured}>{t("lockerMissing")}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <Link href="/" aria-label={t("home", { domain: BRAND_DOMAIN })} className={styles.signature}>
          <span aria-hidden="true">{BRAND}</span>
        </Link>

        <div className={styles.bottom}>
          {/* the chart library's licence credit, on every page that can show a chart */}
          <p>{t.rich("credit", { link: (chunks) => <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className={styles.credit}>{chunks}</a> })}</p>
          <div className={styles.utilities}>
            <a href={`${BRAND_GITHUB}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={styles.license}>{t("license")} <ArrowUpRight size={12} aria-hidden="true" /></a>
            <a href="#site-top" className={styles.backTop}>{t("backTop")} <ArrowUp size={14} aria-hidden="true" /></a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function LinkGroup({ title, links }: { title: string; links: { href: string; label: string; external?: boolean }[] }) {
  return (
    <div>
      <h3 className={styles.groupTitle}>{title}</h3>
      <ul className={styles.links}>
        {links.map(({ href, label, external }) => {
          // Plain-text documents and off-site destinations use native navigation.
          const Anchor = external || href === "/llms.txt" ? "a" : Link;
          return <li key={href}>
            <Anchor href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} className={styles.navLink}>
              <span>{label}</span>{external ? <ArrowUpRight size={14} aria-hidden="true" /> : <ArrowRight size={14} className={styles.internalArrow} aria-hidden="true" />}
            </Anchor>
          </li>;
        })}
      </ul>
    </div>
  );
}
