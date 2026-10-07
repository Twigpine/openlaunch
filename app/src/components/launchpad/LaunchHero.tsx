import Link from "next/link";
import { ArrowRight, ArrowUpRight, Play, Rocket, Scale, ShieldCheck } from "lucide-react";
import LaunchMechanism from "./LaunchMechanism";
import HeroLocker from "./HeroLocker";
import HeroCtaLink from "./HeroCtaLink";
import LiveTicker from "./LiveTicker";
import { ChainLogoStack } from "./ChainLogo";
import { BRAND_GITHUB } from "@/lib/brand";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import { coinPicturesEnabled, imagePublicBase } from "@/lib/launchpad/imageStore";
import { HERO } from "./hero-layout";
import styles from "./LaunchHero.module.css";

const proof = "inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-card/70 px-2.5 text-[11px] font-medium text-body backdrop-blur transition-[color,border-color,background-color,transform] duration-150 hover:border-line-strong hover:bg-card hover:text-ink active:scale-[0.98] motion-reduce:transition-colors motion-reduce:active:scale-100 sm:min-h-9 sm:gap-2 sm:px-3.5 sm:text-xs";

/** GitHub's mark (lucide has no brand icons), for the link to the source. */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="currentColor" aria-hidden="true" className="shrink-0 text-ink">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * First viewport of the home page. Left: the promise, the two ways in, the places to check the claim and, from 1024px, the
 * network's real totals. Right: the launch mechanism itself (token, pool, lock) as a looping drawing. Below: one live line,
 * the newest thing on the network. Trending and the live panel follow, so the proof is the market itself.
 * The class strings live in hero-layout.ts, and the grid in LaunchHero.module.css, because the loading skeleton renders the same.
 */
export default function LaunchHero({ configured }: { configured: boolean }) {
  return (
    <section className={`${HERO.section} ${styles.hero}`}>
      <div className={styles.layout}>
        <div className={styles.copyArea}>
          <Link href="/rules#launchpad" className={HERO.chip}>
            <ChainLogoStack chains={VISIBLE_CHAINS} size={18} />
            <span className="truncate text-body">Free to launch on Base, Robinhood Chain and Arc</span>
            <ArrowRight size={12} aria-hidden="true" className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </Link>
          <h1 className={HERO.headline}>
            Launch a token.
            <br />
            We take <span className="text-brand">nothing.</span>
          </h1>
          <p className={HERO.copy}>
            {/* the brand as a plain word, once, above the fold: the title and footer alone read as a domain */}
            <Link href="/about" className="font-semibold text-ink hover:text-brand underline decoration-line-strong underline-offset-4">openlaunch</Link> is the free, open-source launchpad on Base, Robinhood Chain and Arc. One transaction: your token, a Uniswap v4 pool, and a liquidity position locked forever. 100% of the supply goes into the pool at launch. You only pay gas.
          </p>
          <div className={HERO.actions}>
            {/* the header watches this id: while it is on screen the header CTA stays quiet (one filled blue per screen) */}
            <HeroCtaLink id="hero-cta" href="/launch" className="group relative inline-flex min-h-12 min-w-0 max-sm:min-w-[10.5rem] flex-1 items-center justify-center gap-2.5 overflow-hidden rounded-2xl bg-brand py-1.5 pr-4 pl-2 text-sm font-semibold sm:min-h-13 sm:gap-3 sm:py-2 sm:pl-2.5 sm:text-[15px] text-inverse shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_14px_34px_-14px_var(--color-glow)] transition-[transform,background-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-brand-strong hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_20px_40px_-14px_var(--color-glow)] active:translate-y-0 active:scale-[0.98] motion-reduce:transition-colors motion-reduce:hover:translate-y-0 sm:flex-none sm:pr-7">
              {/* the rocket lifts off on hover */}
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-xl bg-inverse/15 transition-transform sm:size-9 duration-300 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:-rotate-12 motion-reduce:transition-none"><Rocket size={17} strokeWidth={2.2} /></span>
              <span className="truncate">Launch a token</span>
            </HeroCtaLink>
            {/* the way in for someone who wants it explained first: the rules guide. Below 380px just the tile, so the filled button keeps its words */}
            <Link href="/rules#launchpad" aria-label="See how it works" className="group inline-flex min-h-12 shrink-0 max-sm:max-w-full items-center justify-center gap-2.5 rounded-2xl border border-line-strong bg-card/70 py-1.5 pr-3.5 pl-2 text-sm font-semibold text-ink sm:min-h-13 sm:gap-3 sm:py-2 sm:pl-2.5 sm:text-[15px] backdrop-blur transition-[transform,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-ink/40 hover:bg-card active:translate-y-0 active:scale-[0.98] motion-reduce:transition-colors motion-reduce:hover:translate-y-0 max-[379px]:pr-2 sm:pr-6">
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-xl bg-ink text-inverse transition-transform sm:size-9 duration-300 ease-out group-hover:scale-110 motion-reduce:transition-none"><Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" /></span>
              <span aria-hidden="true" className="truncate max-[379px]:hidden sm:hidden">How it works</span>
              <span aria-hidden="true" className="hidden truncate sm:inline">See how it works</span>
            </Link>
          </div>
          {/* the proofs: three small chips, each one a place to check the claim */}
          <ul className={HERO.proofs}>
            <li><a href={`${BRAND_GITHUB}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={proof}><Scale size={14} aria-hidden="true" className="text-muted" />MIT licensed</a></li>
            <li><a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className={proof}><GithubMark /><span className="sm:hidden">Source</span><span className="hidden sm:inline">Source on GitHub</span><ArrowUpRight size={12} aria-hidden="true" className="text-muted" /></a></li>
            <li><Link href="/rules#contracts" className={proof}><ShieldCheck size={14} aria-hidden="true" className="text-up" />Verified contracts</Link></li>
          </ul>
          {!configured ? (
            <p className="mt-5 inline-block rounded-xl border border-warm/30 bg-warm-soft px-3 py-2 text-sm text-warm-ink">
              Launchpad contracts are not configured yet. Read-only until NEXT_PUBLIC_LAUNCH_FACTORY / _LOCKER are set.
            </p>
          ) : null}
        </div>
        {/* the stage: a faint plotting grid and four corner marks frame the mechanism like a drawing on a bench */}
        <div className={styles.stage}>
          <span className={styles.grid} aria-hidden="true" />
          {["tl", "tr", "bl", "br"].map((corner) => <span key={corner} className={styles.corner} data-corner={corner} aria-hidden="true" />)}
          <div className="relative"><HeroLocker imageBase={coinPicturesEnabled() ? imagePublicBase() : null} /></div>
        </div>
        <div className={styles.totalsArea}>
          <LaunchMechanism />
        </div>
      </div>
      <LiveTicker className={HERO.ticker} />
    </section>
  );
}
