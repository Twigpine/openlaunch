import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { btn } from "@/components/ui";
import LaunchMechanism from "./LaunchMechanism";
import HeroCtaLink from "./HeroCtaLink";
import { BRAND_GITHUB } from "@/lib/brand";

/**
 * First viewport of the home page. Left: the promise and the one filled CTA.
 * Right: the network's real totals as one plain sentence, with the breakdown a tap away.
 * The live river sits directly below, so the proof is the market itself.
 */
export default function LaunchHero({ configured }: { configured: boolean }) {
  return (
    <section className="relative grid gap-x-14 gap-y-9 pt-10 pb-2 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-end">
      <div className="min-w-0">
        <h1 className="font-display font-bold leading-[1.02] tracking-[-0.04em] text-ink text-[32px] min-[400px]:text-[36px] min-[480px]:text-[44px] sm:text-[56px] lg:text-[52px] xl:text-[64px]">
          Launch a token.
          <br />
          We take nothing.
        </h1>
        <p className="mt-6 max-w-[34rem] text-base leading-relaxed text-body text-pretty sm:text-lg">
          {/* the brand as a plain word, once, above the fold: the title and footer alone read as a domain */}
          <Link href="/about" className="font-semibold text-ink hover:text-brand underline decoration-line-strong underline-offset-4">openlaunch</Link> is the free, open-source launchpad on Base, Robinhood Chain and Arc. One transaction: your token, a Uniswap v4 pool, and a liquidity position locked forever. 100% of the supply goes into the pool at launch. You only pay gas.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          {/* the header watches this id: while it is on screen the header CTA stays quiet (one filled blue per screen) */}
          <HeroCtaLink id="hero-cta" href="/launch" className={`${btn.primary} min-h-12 w-full px-7 text-[15px] sm:w-auto`}>
            Launch a token
          </HeroCtaLink>
          <Link href="/rules#launchpad" className="text-center text-sm font-medium text-brand underline-offset-4 hover:underline sm:text-left">
            See how it works
          </Link>
        </div>
        {/* the proofs: quiet, linkable, one line */}
        <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
          <li>MIT licensed</li>
          <li><a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-line-strong underline-offset-2 hover:text-ink">Source on GitHub<ArrowUpRight size={12} aria-hidden="true" /></a></li>
          <li><Link href="/rules#contracts" className="underline decoration-line-strong underline-offset-2 hover:text-ink">Verified contracts</Link></li>
        </ul>
        {!configured ? (
          <p className="mt-5 inline-block rounded-xl border border-warm/30 bg-warm-soft px-3 py-2 text-sm text-warm-ink">
            Launchpad contracts are not configured yet. Read-only until NEXT_PUBLIC_LAUNCH_FACTORY / _LOCKER are set.
          </p>
        ) : null}
      </div>
      <div className="min-w-0 lg:pb-1">
        <LaunchMechanism />
      </div>
    </section>
  );
}
