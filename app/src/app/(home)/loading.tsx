import { Sk, SkPost, SkRow } from "@/components/Skeleton";

/** Home skeleton: hero + totals, list header, rows, side column. Same grid as page.tsx so nothing shifts. */
export default function Loading() {
  return (
    <main className="bb-mid bb-page relative pb-16 space-y-8" aria-busy="true" aria-label="loading">
      <section className="pt-10 sm:pt-14 pb-2 grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-8 gap-y-8 xl:gap-x-12 lg:gap-y-0 lg:grid-rows-[min-content_1fr]">
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
      <div className="space-y-3"><Sk className="h-4 w-40" /><Sk className="h-16 w-full rounded-xl" /></div>
      <div className="grid xl:grid-cols-[minmax(0,1fr)_17rem] gap-6 items-start">
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
