import { Sk } from "@/components/Skeleton";

export default function Loading() {
  return <main className="workspace-shell space-y-6 pt-7 pb-28" aria-busy="true" aria-label="Loading token market">
    <Sk className="h-5 w-24" />
    <header className="flex items-center gap-4"><Sk className="size-14 shrink-0 rounded-2xl" /><div className="min-w-0 space-y-2"><Sk className="h-8 w-48 max-w-full" /><Sk className="h-3 w-60 max-w-full" /></div></header>
    <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-8">
      <div className="min-w-0 space-y-4">
        <div><Sk className="h-3 w-24" /><Sk className="mt-3 h-10 w-44 max-w-full" /><Sk className="mt-6 h-10 w-full" /><Sk className="mt-3 h-[390px] w-full max-sm:h-[340px] xl:h-[clamp(430px,50dvh,620px)]" /></div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-line py-4 sm:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="space-y-2"><Sk className="h-3 w-16" /><Sk className="h-5 w-full" /></div>)}</div>
      </div>
      <aside className="space-y-6">
        <div className="space-y-5 rounded-xl bg-card p-5"><Sk className="h-5 w-24" /><Sk className="h-11 w-full" /><Sk className="h-32 w-full rounded-lg" /><Sk className="h-24 w-full rounded-lg" /><Sk className="h-12 w-full rounded-lg" /></div>
        <div className="space-y-4 border-t border-line pt-5"><Sk className="h-4 w-32" /><Sk className="h-16 w-full" /><Sk className="h-10 w-full" /></div>
      </aside>
    </div>
  </main>;
}
