import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowRight, ArrowUpRight, Play, Rocket, Scale, ShieldCheck } from "lucide-react";
import LaunchMechanism from "./LaunchMechanism";
import HeroCtaLink from "./HeroCtaLink";
import { BRAND_GITHUB } from "@/lib/brand";
import { AnimatedShinyText } from "@/components/vendor/animated-shiny-text";
import { BorderBeam } from "@/components/vendor/border-beam";
import { ChainLogoStack } from "./ChainLogo";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";

const rise = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;
const proof = "inline-flex min-h-9 items-center gap-2 rounded-full border border-line bg-card/70 px-3.5 text-xs font-medium text-body backdrop-blur transition-[color,border-color,background-color,transform] duration-150 hover:border-line-strong hover:bg-card hover:text-ink active:scale-[0.98] motion-reduce:transition-colors motion-reduce:active:scale-100";

/** GitHub's mark (lucide has no brand icons), for the link to the source. */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="currentColor" aria-hidden="true" className="shrink-0 text-ink">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * First viewport of the home page. Left: the promise and the one filled CTA, rising in on first paint (pure CSS,
 * so it is all there before any script). Right: the network's real totals as one sentence in a glass card with a
 * travelling border. The flickering grid and glow behind it live in HeroBackdrop.
 */
export default function LaunchHero({ configured }: { configured: boolean }) {
  return (
    <section className="relative grid gap-x-14 gap-y-10 pt-12 pb-4 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)] lg:items-center">
      <div className="min-w-0">
        <Link href="/rules#launchpad" style={rise(0)} className="bb-rise group inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-card/70 py-1 pr-3 pl-1.5 text-xs backdrop-blur hover:border-line-strong">
          <ChainLogoStack chains={VISIBLE_CHAINS} size={18} />
          <AnimatedShinyText className="truncate"><span className="sm:hidden">Free on Base, Robinhood Chain &amp; Arc</span><span className="hidden sm:inline">Free to launch on Base, Robinhood Chain and Arc</span></AnimatedShinyText>
          <ArrowRight size={12} aria-hidden="true" className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
        </Link>
        <h1 className="mt-6 font-display font-bold leading-[1.04] tracking-[-0.04em] text-ink text-[32px] min-[400px]:text-[36px] min-[480px]:text-[44px] sm:text-[56px] lg:text-[50px] xl:text-[64px]">
          <span style={rise(80)} className="bb-rise block">Launch a token.</span>
          <span style={rise(180)} className="bb-rise block text-dim">We take nothing.</span>
        </h1>
        <p style={rise(280)} className="bb-rise mt-6 max-w-[34rem] text-[15px] leading-relaxed text-body text-pretty sm:text-lg">
          {/* the brand as a plain word, once, above the fold: the title and footer alone read as a domain */}
          <Link href="/about" className="font-semibold text-ink hover:text-brand underline decoration-line-strong underline-offset-4">openlaunch</Link> is the free, open-source launchpad on Base, Robinhood Chain and Arc. One transaction: your token, a Uniswap v4 pool, and a liquidity position locked forever. 100% of the supply goes into the pool at launch. You only pay gas.
        </p>
        <div style={rise(380)} className="bb-rise mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          {/* the header watches this id: while it is on screen the header CTA stays quiet (one filled blue per screen) */}
          <HeroCtaLink id="hero-cta" href="/launch" className="bb-sheen group relative inline-flex min-h-13 w-full items-center justify-center gap-3 overflow-hidden rounded-2xl bg-brand py-2 pr-7 pl-2.5 text-[15px] font-semibold text-inverse shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_14px_34px_-14px_var(--color-glow)] transition-[transform,background-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-brand-strong hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_20px_40px_-14px_var(--color-glow)] active:translate-y-0 active:scale-[0.98] motion-reduce:transition-colors motion-reduce:hover:translate-y-0 sm:w-auto">
            {/* the rocket lifts off on hover */}
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-xl bg-inverse/15 transition-transform duration-300 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:-rotate-12 motion-reduce:transition-none"><Rocket size={17} strokeWidth={2.2} /></span>
            Launch a token
          </HeroCtaLink>
          <Link href="/rules#launchpad" className="group inline-flex min-h-13 items-center justify-center gap-3 rounded-2xl border border-line-strong bg-card/70 py-2 pr-6 pl-2.5 text-[15px] font-semibold text-ink backdrop-blur transition-[transform,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-ink/40 hover:bg-card active:translate-y-0 active:scale-[0.98] motion-reduce:transition-colors motion-reduce:hover:translate-y-0">
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-xl bg-ink text-inverse transition-transform duration-300 ease-out group-hover:scale-110 motion-reduce:transition-none"><Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" /></span>
            See how it works
          </Link>
        </div>
        {/* the proofs: three small chips, each one a place to check the claim */}
        <ul style={rise(460)} className="bb-rise mt-6 flex flex-wrap gap-2">
          <li><a href={`${BRAND_GITHUB}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={proof}><Scale size={14} aria-hidden="true" className="text-muted" />MIT licensed</a></li>
          <li><a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className={proof}><GithubMark />Source on GitHub<ArrowUpRight size={12} aria-hidden="true" className="text-muted" /></a></li>
          <li><Link href="/rules#contracts" className={proof}><ShieldCheck size={14} aria-hidden="true" className="text-up" />Verified contracts</Link></li>
        </ul>
        {!configured ? (
          <p className="mt-5 inline-block rounded-xl border border-warm/30 bg-warm-soft px-3 py-2 text-sm text-warm-ink">
            Launchpad contracts are not configured yet. Read-only until NEXT_PUBLIC_LAUNCH_FACTORY / _LOCKER are set.
          </p>
        ) : null}
      </div>
      <div style={rise(320)} className="bb-rise relative min-w-0">
        {/* a soft glow behind the panel lifts it off the grid */}
        <div aria-hidden="true" className="pointer-events-none absolute -inset-10 -z-10 rounded-[4rem] bg-[radial-gradient(closest-side,var(--color-glow),transparent)] opacity-30 blur-2xl" />
        <div className="relative rounded-3xl border border-line bg-card/80 p-6 shadow-card backdrop-blur-xl sm:p-7">
          <BorderBeam size={150} duration={11} />
          <LaunchMechanism />
        </div>
      </div>
    </section>
  );
}
