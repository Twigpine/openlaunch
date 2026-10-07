/**
 * Class strings the home hero (LaunchHero) and its loading skeleton (app/(home)/loading.tsx) both render,
 * so the placeholder cannot drift from the real layout. Whole strings: Tailwind only ships what it can read here.
 * The hero's grid itself (copy, locker, totals, in three arrangements) is in LaunchHero.module.css.
 */
export const HERO = {
  /** tighter from lg: the totals now sit in the hero's left column, and all of it has to stay on a laptop's first screen */
  section: "relative pt-6 sm:pt-8 lg:pt-4",
  /** the chain chip above the headline: from 640px only, because on a phone the copy right below names the same three chains */
  chip: "group hidden max-w-full items-center gap-2 rounded-full border border-line bg-card/70 py-1 pr-3 pl-1.5 text-xs backdrop-blur hover:border-line-strong sm:inline-flex",
  /** stepped so "We take nothing." never wraps: the headline is two lines at every width from 320 to 1920. Sized for Geist
      (the page's display face): "We take nothing." is about 7.6em wide, so each step keeps it inside its column. */
  headline: "font-display text-[34px] font-bold leading-[1.02] tracking-[-0.04em] text-ink min-[400px]:text-[40px] min-[480px]:text-[48px] sm:mt-5 sm:text-[60px] md:text-[44px] lg:text-[56px] xl:text-[68px] [@media(min-width:1024px)_and_(max-height:700px)]:text-[52px]",
  /** 16px again beside the locker (768 to 1023px), where the headline is 34px and 18px copy would outweigh it, and on a laptop's shortest
      browser window (about 657px under the toolbars), where the totals have to stay in view */
  copy: "mt-5 max-w-[34rem] text-pretty text-[15px] leading-relaxed text-body sm:mt-6 sm:text-lg md:text-base lg:text-lg [@media(min-width:1024px)_and_(max-height:700px)]:text-base",
  /** phones: the two buttons share one row, so the first screen keeps its room */
  actions: "mt-6 flex items-center gap-2.5 sm:mt-8 sm:gap-4 lg:mt-6",
  proofs: "mt-5 flex flex-wrap gap-2 lg:mt-4",
  /** the live ticker that closes the hero */
  ticker: "mt-4 sm:mt-5",
} as const;
