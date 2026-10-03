import { Sk, SkPost, SkRow } from "@/components/Skeleton";
import { LaunchListHeader } from "@/components/launchpad/LaunchRow";

/** The readable hero, open market toolbar and support rail follow page.tsx. */
export default function Loading() {
  return (
    <main className="relative pb-16 space-y-8" aria-busy="true" aria-label="loading">
      <section className="mx-auto max-w-6xl px-4 pt-10 sm:pt-14 pb-2 grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-8 gap-y-8 xl:gap-x-12 lg:gap-y-0 lg:grid-rows-[min-content_1fr]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <Sk key={i} className="h-11 sm:h-14 lg:h-12 xl:h-14 w-11/12" />)}
          </div>
          <div className="mt-6 space-y-2">{[0, 1, 2].map((i) => <Sk key={i} className="h-5 w-11/12" />)}</div>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 sm:gap-5"><Sk className="h-12 w-full sm:w-48 rounded-xl" /><Sk className="h-5 w-28 self-center" /></div>
          <Sk className="mt-6 h-4 w-64 max-w-full" />
        </div>
        <div className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2 self-center">
          <div className="mx-auto max-w-[560px]">
            <div className="flex h-9 items-center"><Sk className="h-3 w-48" /></div>
            <div className="aspect-[560/398] flex items-center justify-center"><Sk className="h-2/3 w-3/4 rounded-2xl" /></div>
            <div className="grid grid-cols-3 gap-4 border-b border-line py-4">{[0, 1, 2].map((i) => <Sk key={i} className="h-3 w-20 max-w-full" />)}</div>
            <div className="h-[105px] space-y-3 pt-4"><Sk className="h-4 w-56 max-w-full" /><Sk className="h-3 w-full" /><Sk className="h-3 w-4/5" /></div>
            <Sk className="h-4 w-4/5" />
          </div>
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-start-2 lg:mt-9 border-t border-line pt-4">
          <Sk className="h-4 w-full" />
          <div className="mt-5 grid grid-cols-3 gap-4">{[0, 1, 2].map((i) => <div key={i} className="space-y-3"><Sk className="h-3 w-24 max-w-full" /><Sk className="h-7 w-24 max-w-full" /></div>)}</div>
          <Sk className="mt-5 h-3 w-44" />
        </div>
      </section>
      <div className="workspace-shell space-y-6">
      <div className="space-y-2">
        <Sk className="h-4 w-40" />
        <div className="grid grid-flow-col auto-cols-[minmax(15rem,1fr)] divide-x divide-line overflow-hidden border-y border-line lg:auto-cols-fr">
          {[0, 1, 2].map((i) => <div key={i} className="space-y-3 px-4 py-3"><div className="flex items-center gap-2"><Sk className="size-7 shrink-0 rounded-lg" /><Sk className="h-3 w-28" /></div><div className="flex justify-between gap-4"><Sk className="h-4 w-20" /><Sk className="h-3 w-12" /></div><Sk className="h-2.5 w-full" /></div>)}
        </div>
      </div>
      <div className="grid xl:grid-cols-[minmax(0,1fr)_17rem] gap-6 items-start">
        <section className="min-w-0">
          <div className="flex flex-col items-start justify-between gap-4 border-t border-line pb-5 pt-6 sm:flex-row sm:items-end">
            <div className="space-y-2"><Sk className="h-2.5 w-20" /><Sk className="h-7 w-64 max-w-full" /><Sk className="h-3 w-72 max-w-full" /></div>
            <Sk className="h-12 w-52 max-w-full rounded-xl" />
          </div>
          <div className="market-toolbar grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pb-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <Sk className="col-span-2 h-11 w-full min-w-0 rounded-xl sm:col-span-1" /><Sk className="h-11 w-28 shrink-0 rounded-xl" /><Sk className="h-11 w-24 shrink-0 rounded-xl" />
          </div>
          <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 pb-3">
            <div className="flex gap-2 overflow-hidden">{[0, 1, 2, 3, 4, 5].map((i) => <Sk key={i} className="h-9 w-16 shrink-0 rounded-lg" />)}</div>
            <Sk className="h-3 w-36" />
          </div>
          <LaunchListHeader window="all" />
          <ul>
            {Array.from({ length: 8 }, (_, i) => (
              <SkRow key={i} i={i} ledger />
            ))}
          </ul>
        </section>
        <aside className="grid min-w-0 gap-6 border-t border-line pt-4 md:grid-cols-2 xl:grid-cols-1 xl:border-t-0 xl:border-l xl:pt-0">
          <div className="min-w-0">
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
          <div className="min-w-0 space-y-6">
          <div>
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
          <div className="space-y-4 border-t border-line px-4 pt-6">
            <Sk className="h-4 w-24" />
            <div className="space-y-2"><Sk className="h-3 w-full" /><Sk className="h-3 w-4/5" /></div>
            <div className="space-y-3">{[0, 1].map((i) => <div key={i} className="flex justify-between gap-4"><Sk className="h-3 w-20" /><Sk className="h-3 w-12" /></div>)}</div>
            <Sk className="h-3 w-4/5" />
          </div>
          </div>
        </aside>
      </div>
      </div>
    </main>
  );
}
