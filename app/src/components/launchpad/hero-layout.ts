/**
 * Class strings the home hero (LaunchHero) and its loading skeleton (app/(home)/loading.tsx) both render,
 * so the placeholder cannot drift from the real layout. Whole strings: Tailwind only ships what it can read here.
 */
export const HERO = {
  /** tighter from lg: the totals strip under the hero has to stay on a laptop's first screen */
  section: "relative pt-6 sm:pt-8 lg:pt-4",
  /** one column below 768px; from md the text sits left and the locker right, centred on each other */
  grid: "grid items-center gap-x-10 gap-y-6 md:grid-cols-[minmax(0,1.06fr)_minmax(0,1fr)] xl:gap-x-14",
  /** stepped so "We take nothing." never wraps: the headline is two lines at every width from 320 to 1920. Sized for Geist
      (the page's display face): "We take nothing." is about 7.6em wide, so each step keeps it inside its column. */
  headline: "font-display text-[34px] font-bold leading-[1.02] tracking-[-0.04em] text-ink min-[400px]:text-[40px] min-[480px]:text-[48px] sm:text-[60px] md:text-[44px] lg:text-[56px] xl:text-[68px]",
  /** 16px again beside the locker (768 to 1023px), where the headline is 34px and 18px copy would outweigh it */
  copy: "mt-6 max-w-[34rem] text-pretty text-base leading-relaxed text-body sm:text-lg md:text-base lg:text-lg",
  actions: "mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6",
  proofs: "mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted",
  /** the gap between the hero grid and the totals strip */
  strip: "mt-5 sm:mt-8 lg:mt-5",
} as const;
