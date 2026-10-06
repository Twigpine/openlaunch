/**
 * Class strings the home hero (LaunchHero) and its loading skeleton (app/(home)/loading.tsx) both render,
 * so the placeholder cannot drift from the real layout. Whole strings: Tailwind only ships what it can read here.
 */
export const HERO = {
  /** tighter from lg: the totals strip under the hero has to stay on a laptop's first screen */
  section: "relative pt-6 sm:pt-8 lg:pt-4",
  /** one column below 768px; from md the text sits left and the locker right, centred on each other */
  grid: "grid items-center gap-x-10 gap-y-6 md:grid-cols-[minmax(0,1.06fr)_minmax(0,1fr)] xl:gap-x-14",
  /** stepped so "We take nothing." never wraps: the headline is two lines at every width from 320 to 1920 */
  headline: "font-display text-[28px] font-bold leading-[1.02] tracking-[-0.04em] text-ink min-[360px]:text-[32px] min-[400px]:text-[36px] min-[480px]:text-[44px] sm:text-[56px] md:text-[34px] lg:text-[42px] xl:text-[52px]",
  /** 16px again beside the locker (768 to 1023px), where the headline is 34px and 18px copy would outweigh it */
  copy: "mt-6 max-w-[34rem] text-pretty text-base leading-relaxed text-body sm:text-lg md:text-base lg:text-lg",
  actions: "mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6",
  proofs: "mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted",
  /** the gap between the hero grid and the totals strip */
  strip: "mt-5 sm:mt-8 lg:mt-5",
} as const;
