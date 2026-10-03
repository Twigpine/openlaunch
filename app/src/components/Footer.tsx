import Link from "next/link";
import { ArrowRight, ArrowUp, ArrowUpRight, FileCode2 } from "lucide-react";
import { BRAND, BRAND_DOMAIN, BRAND_GITHUB, BRAND_X } from "@/lib/brand";
import { CHAIN_KEYS, CHAIN_LABELS, CHAINS, explorerAddress } from "@/lib/chainPublic";
import { hasChainPage, launchpad } from "@/lib/launchpad/config";
import { chainLandingPath } from "@/lib/chainLanding";
import Mark from "./launchpad/Mark";
import styles from "./Footer.module.css";

const EXPLORE = [
  { href: "/", label: "Launchpad" },
  { href: "/rules", label: "How it works" },
  { href: "/about", label: "About openlaunch" },
  { href: "/feed", label: "Community posts" },
  { href: "/me", label: "Your dashboard" },
];
const BUILD = [
  { href: "/agents", label: "Developers & agents" },
  { href: BRAND_GITHUB, label: "Source code", external: true },
  { href: "/llms.txt", label: "LLM reference" },
  { href: `https://x.com/${BRAND_X}`, label: "Updates on X", external: true },
];

/** Shared server-rendered footer. Proof links come from the deployed configuration. */
export default function Footer() {
  return (
    <footer id="site-footer" className={`bb-footer ${styles.footer}`} aria-label="Site footer">
      <div className={styles.shell}>
        <div className={styles.main}>
          <div className={styles.invitation}>
            <div className={styles.eyebrow}>
              <span aria-hidden="true"><Mark size={24} /></span>
              Open to your next idea
            </div>
            <h2 className={styles.heading}>Make it yours.<br /><span>Keep it open.</span></h2>
            <p className={styles.description}>Launch on Base, Robinhood Chain or Arc.<br />No platform cut. You only pay gas.</p>
            <Link href="/launch" className={styles.launch}>
              Launch a token <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>

          <nav className={styles.navigation} aria-label="Footer navigation">
            <LinkGroup title="Explore" links={EXPLORE} />
            <LinkGroup title="Build & connect" links={BUILD} />
          </nav>
        </div>

        <div className={styles.proof}>
          <div className={styles.proofIntro}>
            <FileCode2 size={20} aria-hidden="true" />
            <div>
              <p className={styles.proofTitle}>The code is the commitment.</p>
              <Link href="/rules#contracts" className={styles.verification}>Verify the contracts <ArrowUpRight size={13} aria-hidden="true" /></Link>
            </div>
          </div>
          {CHAIN_KEYS.map((chain) => {
            const { factory, locker } = launchpad(chain);
            return (
              <div className={styles.chain} key={chain}>
                <div className={styles.chainName}>{hasChainPage(chain) ? <Link href={chainLandingPath(chain)} className="hover:underline underline-offset-4">{CHAIN_LABELS[chain]}</Link> : CHAIN_LABELS[chain]}<span className={styles.chainId}>{CHAINS[chain].id}</span></div>
                <div className={styles.contracts}>
                  {factory ? <a href={explorerAddress(chain, factory)} target="_blank" rel="noreferrer" aria-label={`${CHAIN_LABELS[chain]} factory on explorer`} title={factory}>Factory <ArrowUpRight size={12} aria-hidden="true" /></a> : <span className={styles.unconfigured}>Factory not configured</span>}
                  {locker ? <a href={explorerAddress(chain, locker)} target="_blank" rel="noreferrer" aria-label={`${CHAIN_LABELS[chain]} locker on explorer`} title={locker}>Locker <ArrowUpRight size={12} aria-hidden="true" /></a> : <span className={styles.unconfigured}>Locker not configured</span>}
                </div>
              </div>
            );
          })}
        </div>

        <Link href="/" aria-label={`${BRAND_DOMAIN} home`} className={styles.signature}>
          <span aria-hidden="true">{BRAND}</span>
        </Link>

        <div className={styles.bottom}>
          <p>Open source. Open participation.</p>
          <div className={styles.utilities}>
            <a href={`${BRAND_GITHUB}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={styles.license}>MIT licensed <ArrowUpRight size={12} aria-hidden="true" /></a>
            <a href="#site-top" className={styles.backTop}>Back to top <ArrowUp size={14} aria-hidden="true" /></a>
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
