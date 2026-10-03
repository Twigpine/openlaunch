import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, ChevronDown, FileCode2, LockKeyhole } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import styles from "@/components/sections/RulesGuide.module.css";
import { launchpad } from "@/lib/launchpad/config";
import { CHAINS, CHAIN_KEYS, CHAIN_LABELS, explorerAddress } from "@/lib/chainPublic";
import { BRAND_GITHUB } from "@/lib/brand";

export const metadata: Metadata = pageMetadata({ path: "/rules", title: "How it works", description: "What a launch does on-chain, what it costs (gas), and what can never happen to your liquidity." });

const STEPS = [
  { title: "Your token is deployed", description: "A plain ERC-20 with EIP-2612 permit. Fixed supply, 1 billion by default. No mint, no pause, no blacklist, no transfer tax, no owner.", value: "1B", label: "default supply" },
  { title: "A market opens", description: "A Uniswap v4 pool pairs your token with ETH, GITLAWB, a tokenized stock (Coinbase stocks on Base, Robinhood Stock Tokens on Robinhood Chain), USDG on Robinhood Chain, or USDC on Arc. No hook. The pool starts at the market cap you pick.", value: "v4", label: "Uniswap pool" },
  { title: "The liquidity position is locked", description: "100% of the supply goes into one single-sided position at launch. Its NFT is minted to an ownerless locker that has no function to withdraw, transfer or shrink it. Ever.", value: "100%", label: "deposited at launch" },
  { title: "Fee routing is written in", description: "The trading fee you choose (0%, 1% or 3%) goes 100% to the beneficiaries you name, or is burned if you name none. Fixed at launch, unchangeable.", value: "0 / 1 / 3%", label: "your trading fee" },
] as const;

const FIXED = [
  ["No platform fee", "There is no fee address, fee variable or treasury anywhere in the factory or the locker. Nothing to switch on later. It cannot be added to immutable code."],
  ["No liquidity withdrawal", "Nobody can remove liquidity: not the creator, not us. Collecting fees removes zero liquidity."],
  ["No pre-mine", "Every token starts inside the pool. There is no creator-reserved allocation."],
  ["No admin", "No owner, no pause, no upgrade, no allowlist. The contracts are the same for everyone, forever."],
] as const;

const CONTENTS = [
  ["launchpad", "The launch"], ["fees", "Fees & routing"], ["immutable", "What stays fixed"], ["know", "Before you begin"], ["contracts", "Contracts"],
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

export default function RulesPage() {
  return (
    <main className={`${shell.page} ${styles.guide}`}>
      <SectionIntro eyebrow="The protocol, explained" title="How it works" description="One transaction on Base, Robinhood Chain or Arc. Your token, a market, and a permanently locked liquidity position. You only pay gas.">
        <Link href="/launch" className={shell.action}>Launch a token <ArrowRight size={15} aria-hidden="true" /></Link>
        <a href="#contracts" className={shell.textLink}>Verify the contracts <ArrowDown size={14} aria-hidden="true" /></a>
      </SectionIntro>

      <div className={styles.layout}>
        <aside className={styles.contents}>
          <nav aria-label="On this page">
            <p className={styles.eyebrow}>In this guide</p>
            <ol>
              {CONTENTS.map(([id, title], i) => <li key={id}><a href={`#${id}`}><span>{String(i + 1).padStart(2, "0")}</span>{title}</a></li>)}
            </ol>
          </nav>
          <a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className={styles.sourceLink}><FileCode2 size={16} aria-hidden="true" /> Read the source <ArrowUpRight size={13} aria-hidden="true" /></a>
        </aside>

        <div className={styles.article}>
          <section className={shell.anchorSection} id="launchpad" aria-labelledby="launch-heading">
            <div className={styles.sectionHeading}>
              <div><p className={styles.eyebrow}>01 / The launch</p><h2 id="launch-heading">One signature.<br />Four things happen.</h2></div>
              <p>All in the same transaction.<br />No separate setup. No platform fee.</p>
            </div>
            <ol className={styles.steps}>
              {STEPS.map(({ title, description, value, label }, i) => (
                <li key={title} className={styles.step}>
                  <span className={styles.stepNumber} aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  <div className={styles.stepCopy}><h3>{title}</h3><p>{description}</p></div>
                  <div className={styles.stepValue}><strong>{value}</strong><span>{label}</span></div>
                </li>
              ))}
            </ol>
            <p className={styles.mechanismNote}><LockKeyhole size={15} aria-hidden="true" /><span>The position stays locked. Tokens remain tradeable.</span><a href="#contracts">Inspect the locker <ArrowUpRight size={13} aria-hidden="true" /></a></p>
          </section>

          <section className={shell.anchorSection} id="fees" aria-labelledby="fees-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>02 / Fees & routing</p><h2 id="fees-heading">Know where it goes.</h2></div></div>
            <div className={styles.feePanel}>
              <div className={styles.platformFee}><span className={styles.eyebrow}>Platform fee</span><strong>0%</strong><p>We take nothing.<br />Gas is paid to the network.</p><a href="#contracts">Check the code <ArrowUpRight size={13} aria-hidden="true" /></a></div>
              <div className={styles.tradingFees}>
                <h3>The creator chooses the trading fee</h3>
                <dl>
                  <div><dt>0%</dt><dd>No pool trading fee. Network gas still applies. Nobody earns fees from volume, including the creator.</dd></div>
                  <div><dt>1% or 3%</dt><dd>Uniswap charges it on every trade and it accrues to the locked position. The platform takes no share.</dd></div>
                </dl>
                <p>Beneficiaries and shares are set at launch and can never be changed. A promise like &ldquo;half the fees go to this address&rdquo; is enforced by the contract, not by us.</p>
              </div>
            </div>
            <div className={styles.collectNote}>
              <div><h3>Anyone can collect. The routing decides who receives.</h3><p>Press <em>Collect</em> on the token page. Accrued fees leave the pool and are paid straight to the beneficiaries in the same transaction, or burned to <span className={styles.mono}>0x…dEaD</span> if the launch has no beneficiary.</p></div>
              <p>If a beneficiary cannot receive the payment, their share is credited to them and can be claimed any time. It is never lost and never blocks the others.</p>
            </div>
          </section>

          <section className={shell.anchorSection} id="immutable" aria-labelledby="fixed-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>03 / What stays fixed</p><h2 id="fixed-heading">Code, not a promise.</h2></div><a href="#contracts" className={shell.textLink}>Read the contracts <ArrowUpRight size={14} aria-hidden="true" /></a></div>
            <ul className={styles.fixedList}>{FIXED.map(([title, description]) => <li key={title}><span className={styles.fixedMark} aria-hidden="true">×</span><div><h3>{title}</h3><p>{description}</p></div></li>)}</ul>
          </section>

          <section className={shell.anchorSection} id="know" aria-labelledby="know-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>04 / Before you begin</p><h2 id="know-heading">Locked liquidity.<br />Not a guarantee of value.</h2></div></div>
            <p className={styles.riskIntro}>Tokens launched here are created by their launchers, not by openlaunch. Do your own research; a locked pool does not make a token valuable. Nothing is refundable.</p>
            <div className={styles.questions}>
              <details open><summary>How does the price move?<ChevronDown size={17} aria-hidden="true" /></summary><div><p>Price follows a single-sided Uniswap v4 curve: the first buyers get the most tokens per unit of the quote asset, and every buy moves the price up. Sells move it down.</p><p>There is no anti-snipe mechanism. Bots can buy in the first block like anyone else.</p><p>The launch form suggests a small first buy (about $25) so your token opens with a holder and a price; clear it and the launch stays free.</p></div></details>
              <details open><summary>Why is my token under &ldquo;quiet launches&rdquo;?<ChevronDown size={17} aria-hidden="true" /></summary><div><p>The home page ranks by facts, not by launch order. A token is <strong>live</strong> once a wallet other than its launcher has traded it in the last 24 hours; trades in the launch block and the next three blocks (snipe bots) don&apos;t count, and neither do the launcher&apos;s own. Live tokens rank by outside wallets in the last hour, then today, then by their last outside trade. A wallet&apos;s newest launch gets its first hour on the board regardless; after that it sits under quiet launches, one row per wallet, until someone trades it.</p><p>Nothing is hidden: every launch stays in the New tab, in search and in the API. The only way up is a trade from an outside wallet.</p></div></details>
              <details open><summary>What can change after launch?<ChevronDown size={17} aria-hidden="true" /></summary><div><p>Nothing on-chain can be edited after launch: not the name, not the fee, not the beneficiaries. Metadata (image, description, links) is stored by this site and can change; the token itself cannot.</p></div></details>
              <details open><summary>What is a GITLAWB-quoted pool?<ChevronDown size={17} aria-hidden="true" /></summary><div><p>GITLAWB is Gitlawb&apos;s token on Base, bridged 1:1 to Robinhood Chain over LayerZero (one supply, two chains): an ordinary ERC-20 with no transfer restrictions and no issuer switch. Pick it as the quote and buyers pay in GITLAWB; any trading fee is paid in GITLAWB to the beneficiaries named at launch (by their shares), and a launch that names none burns GITLAWB on every trade.</p><p>Dollar figures for these pools come from the Uniswap v4 WETH/GITLAWB pool price on Base, cross-checked against a 30-minute on-chain average, and ETH/USD, on both chains. They are for display and sorting only; nothing on-chain depends on them.</p></div></details>
              <details open><summary>What should I know about stock-quoted pools?<ChevronDown size={17} aria-hidden="true" /></summary><div><p>Stock-quoted pools use tokenized stocks as the quote asset: Coinbase tokenized stocks (B20) on Base, recognised here only from Base&apos;s official list and priced from Chainlink&apos;s on-chain feeds; Robinhood Stock Tokens on Robinhood Chain, recognised only from Robinhood&apos;s own registry.</p><p>Both are securities issued by third parties under Regulation S and are not offered to US persons. Coinbase&apos;s also exclude the UK, Canada, Australia, Singapore and Switzerland. Their issuers can pause transfers or freeze wallets in restricted jurisdictions. Holding or trading them is subject to the issuer&apos;s terms, not ours.</p></div></details>
            </div>
          </section>

          <section className={shell.anchorSection} id="contracts" aria-labelledby="contracts-heading">
            <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>05 / The source of truth</p><h2 id="contracts-heading">Don&apos;t take our word for it.</h2></div><FileCode2 size={28} className={styles.contractIcon} aria-hidden="true" /></div>
            <p className={styles.contractIntro}>Contracts, addresses and source verification. The same contract design on every chain, with chain-specific Uniswap deployments.</p>
            <div className={styles.registry}>
              {CHAIN_KEYS.map((chain) => {
                const config = launchpad(chain);
                return <section key={chain} className={styles.network} aria-labelledby={`${chain}-contracts`}>
                  <header><h3 id={`${chain}-contracts`}>{CHAIN_LABELS[chain]}</h3><span>Chain ID <strong>{CHAINS[chain].id}</strong></span></header>
                  <dl className={styles.addresses}>{(["factory", "locker"] as const).map((kind) => {
                    const address = config[kind];
                    return <div key={kind}><dt>{kind === "factory" ? "Factory" : "Locker"}</dt><dd>{address ? <a href={explorerAddress(chain, address)} target="_blank" rel="noreferrer" aria-label={`${CHAIN_LABELS[chain]} ${kind}: ${address}`}><span>{address}</span><ArrowUpRight size={14} aria-hidden="true" /></a> : <span className={styles.notDeployed}>Not deployed yet</span>}</dd></div>;
                  })}</dl>
                  {config.factory && config.locker ? <div className={styles.verifiers}><p>Source verified</p>{VERIFIERS[chain].map((verifier) => <div key={verifier.name}><span>{verifier.name}</span><a href={verifier.url(config.factory!)} target="_blank" rel="noreferrer" aria-label={`${CHAIN_LABELS[chain]} factory source on ${verifier.name}`}>Factory <ArrowUpRight size={12} aria-hidden="true" /></a><a href={verifier.url(config.locker!)} target="_blank" rel="noreferrer" aria-label={`${CHAIN_LABELS[chain]} locker source on ${verifier.name}`}>Locker <ArrowUpRight size={12} aria-hidden="true" /></a></div>)}</div> : null}
                </section>;
              })}
            </div>
            <p className={styles.contractNote}>Uniswap v4&apos;s PoolManager, PositionManager, Permit2 and Universal Router are Uniswap&apos;s canonical deployments. MIT-licensed source on <a href={BRAND_GITHUB} target="_blank" rel="noreferrer">GitHub ↗</a>; the verification records for each chain are linked above.</p>
          </section>

          <div className={styles.closing}><div><p className={styles.eyebrow}>Your next move</p><h2>Make something of your own.</h2></div><Link href="/launch" className={shell.action}>Launch a token <ArrowRight size={15} aria-hidden="true" /></Link></div>
        </div>
      </div>
    </main>
  );
}
