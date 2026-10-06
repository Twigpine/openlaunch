import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { btn } from "@/components/ui";
import LaunchMechanism from "./LaunchMechanism";
import LaunchMachine from "./LaunchMachine";
import HeroCtaLink from "./HeroCtaLink";
import { BRAND_GITHUB } from "@/lib/brand";
import { HERO } from "./hero-layout";
import styles from "./LaunchHero.module.css";

/**
 * First viewport of the home page. Left: the promise and the one filled CTA. Right: the launch mechanism
 * itself (token, pool, lock) as a looping drawing. Below both: the network's real totals as one instrument
 * strip. Trending and the live river follow, so the proof is the market itself.
 * The layout classes live in hero-layout.ts because the loading skeleton renders the same grid.
 */
export default function LaunchHero({ configured }: { configured: boolean }) {
  return (
    <section className={`${HERO.section} ${styles.hero}`}>
      <div className={HERO.grid}>
        <div className="min-w-0">
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
            <HeroCtaLink id="hero-cta" href="/launch" className={`${btn.primary} min-h-12 w-full px-7 text-[15px] sm:w-auto`}>
              Launch a token
            </HeroCtaLink>
            {/* a full 44px touch target on phones, where it sits alone under the button */}
            <a href="#trending" className="inline-flex min-h-11 items-center justify-center text-sm font-medium text-brand underline-offset-4 hover:underline sm:min-h-0">
              See what&apos;s trending
            </a>
          </div>
          {/* the proofs: quiet, linkable, each at least 24px tall so a wrapped row is still easy to hit */}
          <ul className={HERO.proofs}>
            <li className="flex min-h-6 items-center">MIT licensed</li>
            <li><a href={BRAND_GITHUB} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-1 underline decoration-line-strong underline-offset-2 hover:text-ink">Source on GitHub<ArrowUpRight size={12} aria-hidden="true" /></a></li>
            <li><Link href="/rules#contracts" className="inline-flex min-h-6 items-center underline decoration-line-strong underline-offset-2 hover:text-ink">Verified contracts</Link></li>
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
          <div className="relative"><LaunchMachine /></div>
        </div>
      </div>
      <div className={`${HERO.strip} ${styles.strip}`}>
        <LaunchMechanism />
      </div>
    </section>
  );
}
