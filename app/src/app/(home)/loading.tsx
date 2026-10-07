import { Sk, SkPost, SkRow } from "@/components/Skeleton";
import { HERO } from "@/components/launchpad/hero-layout";
import hero from "@/components/launchpad/LaunchHero.module.css";
import machine from "@/components/launchpad/LaunchMachine.module.css";
import totals from "@/components/launchpad/LaunchMechanism.module.css";
import trend from "@/components/launchpad/TrendingStrip.module.css";

/**
 * Home skeleton, in the page's own order: hero (text, the locker in its stage and the totals, in the real grid), the live
 * line, Trending board, live panel, then the launches list with its side column. The hero's class strings come from
 * hero-layout.ts and its grid, stage, locker and totals from the real components' stylesheets, so heights follow the
 * real layout (including the short-screen compaction) instead of copying it. Only the Trending and live-panel blocks
 * are sized by hand.
 */
/** One compact board card (a runner, or the leader below 1024px) at the heights the real card has. */
function SkBoardCard() {
  return (
    <div className="flex h-[138px] flex-col justify-between rounded-2xl border border-line bg-card px-4 py-3.5 sm:h-[144px] sm:py-4 lg:h-[156px]">
      <div className="flex items-center gap-2.5"><Sk className="h-[38px] w-[38px] shrink-0 rounded-xl" /><div className="min-w-0 flex-1 space-y-2"><Sk className="h-3.5 w-2/3" /><Sk className="h-2.5 w-20" /></div><Sk className="h-3.5 w-14" /></div>
      <div className="space-y-2.5"><Sk className="h-[3px] w-full rounded-full" /><Sk className="h-2.5 w-3/4" /></div>
    </div>
  );
}

export default function Loading() {
  return (
    <main className="bb-mid bb-page relative space-y-6 pb-16 sm:space-y-8" aria-busy="true" aria-label="loading">
      <section className={`${HERO.section} ${hero.hero}`}>
        <div className={hero.layout}>
          <div className={hero.copyArea}>
            <span className="hidden h-7 w-80 max-w-full items-center sm:flex"><Sk className="h-7 w-full rounded-full" /></span>
            {/* the headline's own classes: each bar sits in one line of its line-height, so two bars are as tall as the two lines */}
            <div className={HERO.headline}>{[0, 1].map((i) => <span key={i} className="flex h-[1.02em] items-center"><Sk className={`h-[0.74em] ${i ? "w-11/12" : "w-10/12"}`} /></span>)}</div>
            {/* the copy's real wrap, in lines: 6 up to 380px, 5 up to 460px, then 4; beside the locker 6 at 768-790px, 5 to 950px, 4 to 1023px,
                5 again at 1024-1069px, then 4. The last placeholder is the short final line. */}
            <div className={HERO.copy}>
              {[
                { show: "flex" },
                { show: "flex" },
                { show: "flex" },
                { show: "hidden max-[459px]:flex min-[768px]:max-[949px]:flex min-[1024px]:max-[1069px]:flex" },
                { show: "hidden max-[380px]:flex min-[768px]:max-[790px]:flex" },
                { show: "flex", width: "w-2/3" },
              ].map((line, i) => <span key={i} className={`h-lh items-center ${line.show}`}><Sk className={`h-[0.7em] ${line.width ?? "w-full"}`} /></span>)}
            </div>
            <div className={HERO.actions}><Sk className="h-12 min-w-0 flex-1 rounded-2xl sm:h-[54px] sm:w-52 sm:flex-none" /><Sk className="h-12 w-[149px] shrink-0 rounded-2xl max-[379px]:w-12 sm:h-[54px] sm:w-56" /></div>
            <div className={HERO.proofs}>{["w-[106px] sm:w-[122px]", "w-[96px] sm:w-[170px]", "w-[133px] sm:w-[152px]"].map((w) => <Sk key={w} className={`h-8 rounded-full sm:h-9 ${w}`} />)}</div>
          </div>
          <div className={hero.stageCol}>
          <div className={hero.stage}>
            <div className={machine.machine}>
              <div className="flex h-9 items-center"><Sk className="h-3 w-44" /></div>
              <div className="flex aspect-[560/398] items-center justify-center"><Sk className="h-2/3 w-3/4 rounded-2xl" /></div>
              <div className="grid grid-cols-3 border-b border-line">{[0, 1, 2].map((i) => <span key={i} className="flex h-11 items-center px-2"><Sk className="h-3 w-20 max-w-full" /></span>)}</div>
              <div className={machine.detail}><div className="space-y-2.5"><Sk className="h-4 w-56 max-w-full" /><Sk className="h-3 w-full max-w-[390px]" /><Sk className="h-3 w-3/5" /></div></div>
              {/* the locker's proof links drop to a second row on the narrowest phones */}
              <div className="flex h-[53px] items-center px-2 min-[340px]:h-[30px]"><Sk className="h-2.5 w-full" /></div>
            </div>
          </div>
          <div className={hero.tickerStage}><Sk className="h-10 w-full rounded-xl" /></div>
          </div>
          <div className={hero.totalsArea}>
            <div className={totals.panel}>
              <div className={totals.readings}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className={i ? totals.reading : `${totals.reading} ${totals.lead}`}>
                    <div className={`${totals.label} flex min-h-[1.4em] items-center max-[359px]:min-h-[2.8em] lg:max-[1179px]:min-h-[2.8em]`}><Sk className="h-2.5 w-20" /></div>
                    <div className={`${totals.figure} flex items-center justify-end sm:justify-start`}><Sk className={i ? "h-4 w-16 sm:h-5" : "h-6 w-32 sm:h-8 sm:w-44 lg:h-10 lg:w-36"} /></div>
                    <div className={`${totals.note} ${i ? "min-h-[3em]" : "min-h-[1.5em]"}`}><Sk className="mt-[0.4em] h-[0.8em] w-4/5" /></div>
                  </div>
                ))}
              </div>
              <div className={`${totals.breakdown} flex min-h-11 items-center lg:min-h-9`}><Sk className="h-3 w-64 max-w-full" /></div>
            </div>
          </div>
          <div className={hero.tickerArea}><Sk className="h-10 w-full rounded-xl" /></div>
        </div>
      </section>
      {/* Trending (TrendingStrip.tsx): a row to swipe below 1024px, a leader over four runners from there. The row's own stylesheet
          class is used, so its padding, gap and card width are the real ones. */}
      <section className="min-w-0">
        <div className="mb-3 flex h-8 items-center gap-3"><Sk className="h-4 w-20" /><Sk className="h-5 w-24 rounded-full" /></div>
        <ol className={`${trend.board} lg:grid-cols-10 lg:grid-rows-2`}>
          <li className="lg:col-span-4 lg:row-span-2">
            <div className="lg:hidden"><SkBoardCard /></div>
            <div className="hidden h-[324px] flex-col justify-between rounded-2xl border border-line-strong bg-card p-5 lg:flex">
              <div className="space-y-4"><Sk className="h-3 w-40" /><div className="flex items-center gap-3.5"><Sk className="h-[52px] w-[52px] shrink-0 rounded-2xl" /><div className="min-w-0 flex-1 space-y-2"><Sk className="h-4 w-2/3" /><Sk className="h-3 w-20" /></div></div></div>
              <div className="space-y-3"><Sk className="h-4 w-36" /><Sk className="h-1.5 w-full rounded-full" /><Sk className="h-3 w-3/4" /></div>
            </div>
          </li>
          {[0, 1, 2, 3].map((i) => <li key={i} className="lg:col-span-3"><SkBoardCard /></li>)}
        </ol>
      </section>
      {/* the live panel (LiveRiver.tsx): a rounded card, 510px on phones, 588px on tablets and 463px on desktop with its bubbles view open */}
      <section className="relative h-[510px] rounded-3xl border border-line bg-card/70 p-4 shadow-card sm:h-[588px] sm:p-6 lg:h-[463px]">
        <div className="flex h-8 items-center justify-between gap-4"><Sk className="h-4 w-56 max-w-[60%]" /><Sk className="h-8 w-40 rounded-lg" /></div>
        <Sk className="mt-4 h-[calc(100%-3.5rem)] w-full rounded-2xl" />
      </section>
      <div className="grid items-start gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="overflow-hidden rounded-2xl border border-line bg-paper">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-5">
            <Sk className="h-7 w-32" />
            <Sk className="h-11 w-full sm:w-64 rounded-xl" />
          </div>
          <div className="space-y-4 px-4 py-4">
            <Sk className="h-10 w-full max-w-md" />
            <Sk className="h-11 w-64 max-w-full rounded-xl" />
            <Sk className="h-10 w-64 max-w-full" />
            <Sk className="h-3 w-36" />
          </div>
          <ul>
            {Array.from({ length: 8 }, (_, i) => (
              <SkRow key={i} i={i} ledger />
            ))}
          </ul>
        </section>
        <aside className="space-y-4">
          <div className="rounded-2xl bg-card border border-line shadow-card overflow-hidden">
            <div className="flex min-h-14 items-center justify-between border-b border-line px-4">
              <Sk className="h-4 w-14" />
              <Sk className="h-3 w-16" />
            </div>
            <ul>
              {Array.from({ length: 4 }, (_, i) => (
                <SkPost key={i} i={i} avatar="tile" />
              ))}
            </ul>
          </div>
          <div className="rounded-2xl bg-card border border-line shadow-card overflow-hidden">
            <div className="flex min-h-14 items-center justify-between gap-2 border-b border-line px-4">
              <Sk className="h-4 w-20" />
              <div className="flex items-center gap-2"><Sk className="h-3 w-14" /><Sk className="h-10 w-10 rounded-lg" /></div>
            </div>
            <ul>
              {Array.from({ length: 5 }, (_, i) => (
                <SkPost key={i} i={i} />
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
