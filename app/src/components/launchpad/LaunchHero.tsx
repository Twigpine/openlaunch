import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { btn } from "@/components/ui";
import LaunchMechanism from "./LaunchMechanism";
import LaunchMachine from "./LaunchMachine";
import { BRAND_GITHUB } from "@/lib/brand";

/**
 * First viewport of the home page. Left: the promise and the one filled CTA.
 * Right: a code-native isometric launch mechanism. Live totals remain outside
 * the illustrative scene, with source links and an accessible breakdown.
 */
export default function LaunchHero({ configured }: { ethUsd?: number | null; configured: boolean }) {
  return (
    <section className="relative pt-10 sm:pt-14 pb-2">
      <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-8 gap-y-8 xl:gap-x-12 lg:gap-y-0 lg:grid-rows-[min-content_1fr]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <h1 className="font-display font-bold leading-[1.02] tracking-[-0.04em] text-ink text-[40px] min-[400px]:text-5xl sm:text-6xl lg:text-[48px] xl:text-[56px]">
            Launch a token.
            <br />
            <span className="text-brand">Free.</span> On Base, Robinhood or Arc.
          </h1>
          <p className="mt-6 text-base sm:text-lg text-body max-w-[32rem] leading-relaxed text-pretty">
            {/* the brand as a plain word, once, above the fold: the title and footer alone read as a domain */}
            <Link href="/about" className="font-semibold text-ink hover:text-brand underline decoration-line-strong underline-offset-4">openlaunch</Link> is the free, open-source launchpad. One transaction: your token, a Uniswap v4 pool, and a liquidity position locked forever. 100% of the supply goes into the pool at launch. We take nothing. You only pay gas.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
            {/* the header watches this id: while it is on screen the header CTA stays quiet (one filled blue per screen) */}
            <Link id="hero-cta" href="/launch" className={`${btn.primary} w-full sm:w-auto min-h-12 px-7 text-[15px]`}>
              Launch a token
              <ArrowRight size={16} strokeWidth={2.4} aria-hidden className="ml-1" />
            </Link>
            <Link href="/rules#launchpad" className="text-sm font-medium text-brand hover:underline underline-offset-4 text-center sm:text-left">
              How it works
            </Link>
          </div>
          {/* the proofs that used to be chips: quiet, linkable, one line */}
          <p className="mt-6 font-mono text-xs tnum text-muted">
            MIT
            <span aria-hidden> · </span>
            <a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className="hover:text-ink underline underline-offset-2 decoration-line-strong">
              source ↗
            </a>
            <span aria-hidden> · </span>
            <Link href="/rules#contracts" className="hover:text-ink underline underline-offset-2 decoration-line-strong">
              verified contracts
            </Link>
          </p>
          {!configured ? (
            <p className="mt-5 inline-block rounded-xl bg-warm-soft border border-warm/30 text-warm-ink text-sm px-3 py-2">
              Launchpad contracts are not configured yet. Read-only until NEXT_PUBLIC_LAUNCH_FACTORY / _LOCKER are set.
            </p>
          ) : null}
        </div>

        <div className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2 self-center">
          <LaunchMachine />
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-start-2 lg:mt-9">
          <LaunchMechanism />
        </div>
      </div>
    </section>
  );
}
