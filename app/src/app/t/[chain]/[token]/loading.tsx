import { Sk } from "@/components/Skeleton";
import PendingTokenHeader from "@/components/launchpad/PendingTokenHeader";

/* Same frame as page.tsx (main padding, breadcrumb row, header): the token header that the market-row
   morph lands on must sit exactly where the real one renders, or the second hop would jump. */
export default function Loading() {
  return <main className="mx-auto max-w-6xl px-4 pt-5 pb-28 sm:pt-7 lg:pb-16" aria-busy="true" aria-label="Loading token market">
    <div className="mb-5 flex min-h-8 items-center"><Sk className="h-4 w-24" /></div>
    <PendingTokenHeader />
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-6">
      <div className="min-w-0 space-y-4">
        <div className="overflow-hidden rounded-2xl border border-line p-5"><Sk className="h-3 w-24" /><Sk className="mt-3 h-10 w-44" /><Sk className="mt-6 h-10 w-full" /><Sk className="mt-3 h-72 w-full sm:h-[360px] xl:h-[390px]" /></div>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-card p-4 sm:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="space-y-2"><Sk className="h-3 w-16" /><Sk className="h-5 w-full" /></div>)}</div>
      </div>
      <aside className="space-y-4">
        <div className="space-y-5 rounded-2xl border border-line-strong p-5"><Sk className="h-5 w-24" /><Sk className="h-11 w-full" /><Sk className="h-32 w-full rounded-xl" /><Sk className="h-24 w-full rounded-xl" /><Sk className="h-12 w-full rounded-xl" /></div>
        <Sk className="h-60 w-full rounded-2xl" />
      </aside>
    </div>
  </main>;
}
