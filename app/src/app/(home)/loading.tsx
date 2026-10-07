import { Sk, SkPost, SkRow } from "@/components/Skeleton";
import { HERO } from "@/components/launchpad/hero-layout";
import hero from "@/components/launchpad/LaunchHero.module.css";
import machine from "@/components/launchpad/LaunchMachine.module.css";
import totals from "@/components/launchpad/LaunchMechanism.module.css";

/**
 * Home skeleton, in the page's own order: hero (text and the locker in its stage), totals strip, Trending board,
 * live panel, then the launches list with its side column. The hero grid comes from hero-layout.ts and the stage,
 * locker and strip boxes from the real components' stylesheets, so heights follow the real layout (including the
 * short-screen compaction) instead of copying it. Only the Trending and live-panel blocks are sized by hand.
 */
export default function Loading() {
  return (
    <main className="bb-mid bb-page relative pb-16 space-y-8" aria-busy="true" aria-label="loading">
      <section className={`${HERO.section} ${hero.hero}`}>
        <div className={HERO.grid}>
          <div className="min-w-0">
            {/* the headline's own classes: each bar sits in one line of its line-height, so two bars are as tall as the two lines */}
            <div className={HERO.headline}>{[0, 1].map((i) => <span key={i} className="flex h-[1.02em] items-center"><Sk className={`h-[0.74em] ${i ? "w-11/12" : "w-10/12"}`} /></span>)}</div>
            {/* the copy wraps to 7 lines at 320px, 6 from 340px, 5 from 420px and 4 from 520px; beside the locker (md) the locker is the taller column */}
            <div className={HERO.copy}>
              {["", "", "", "min-[520px]:hidden", "min-[420px]:hidden", "min-[340px]:hidden", "w-2/3"].map((line, i) => <span key={i} className={`flex h-lh items-center ${line.includes("hidden") ? line : ""}`}><Sk className={`h-[0.7em] ${line.startsWith("w-") ? line : "w-full"}`} /></span>)}
            </div>
            <div className={HERO.actions}><Sk className="h-12 w-full rounded-xl sm:w-44" /><span className="flex h-11 items-center justify-center sm:h-5"><Sk className="h-4 w-36" /></span></div>
            <div className={HERO.proofs}>{["w-[76px]", "w-[120px]", "w-[104px]"].map((w) => <span key={w} className="flex h-6 items-center"><Sk className={`h-3 ${w}`} /></span>)}</div>
          </div>
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
        </div>
        <div className={`${HERO.strip} ${hero.strip}`}>
          <div className={totals.panel}>
            <div className={totals.readings}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={i ? totals.reading : `${totals.reading} ${totals.lead}`}>
                  <div className={`${totals.label} flex items-center sm:min-h-[1.4em]`}><Sk className="h-2.5 w-20" /></div>
                  <div className={`${totals.figure} flex items-center justify-end sm:justify-start`}><Sk className={i ? "h-4 w-16 sm:h-5" : "h-6 w-32 sm:h-8 sm:w-44 lg:h-10 lg:w-56"} /></div>
                  <div className={`${totals.note} ${i ? "min-h-[3em]" : "min-h-[1.5em]"}`}><Sk className="mt-[0.4em] h-[0.8em] w-4/5" /></div>
                </div>
              ))}
            </div>
            <div className={`${totals.breakdown} flex min-h-11 items-center lg:min-h-9`}><Sk className="h-3 w-64 max-w-full" /></div>
          </div>
        </div>
      </section>
      {/* Trending: the board's grid (TrendingStrip.tsx), a leader and four runners at the heights its cards have today */}
      <section className="min-w-0">
        <div className="mb-3 flex h-8 items-center gap-3"><Sk className="h-4 w-20" /><Sk className="h-5 w-24 rounded-full" /></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-10 lg:grid-rows-2">
          <div className="flex h-[324px] flex-col justify-between rounded-2xl border border-line bg-card p-5 sm:col-span-2 sm:h-[197px] lg:col-span-4 lg:row-span-2 lg:h-[324px]">
            <div className="space-y-4"><Sk className="h-3 w-40" /><div className="flex items-center gap-3.5"><Sk className="h-[52px] w-[52px] shrink-0 rounded-2xl" /><div className="min-w-0 flex-1 space-y-2"><Sk className="h-4 w-2/3" /><Sk className="h-3 w-20" /></div></div></div>
            <div className="space-y-3"><Sk className="h-4 w-36" /><Sk className="h-1.5 w-full rounded-full" /><Sk className="h-3 w-3/4" /></div>
          </div>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex h-[138px] flex-col justify-between rounded-2xl border border-line bg-card px-4 py-3.5 sm:h-[144px] sm:py-4 lg:col-span-3 lg:h-[156px]">
              <div className="flex items-center gap-2.5"><Sk className="h-[38px] w-[38px] shrink-0 rounded-xl" /><div className="min-w-0 flex-1 space-y-2"><Sk className="h-3.5 w-2/3" /><Sk className="h-2.5 w-20" /></div><Sk className="h-3.5 w-14" /></div>
              <div className="space-y-2.5"><Sk className="h-[3px] w-full rounded-full" /><Sk className="h-2.5 w-3/4" /></div>
            </div>
          ))}
        </div>
      </section>
      {/* the live panel (LiveRiver.tsx): a rounded card, 687px on phones and 463px on desktop with its bubbles view open */}
      <section className="relative h-[687px] rounded-3xl border border-line bg-card/70 p-4 shadow-card sm:h-[463px] sm:p-6">
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
