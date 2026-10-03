import { Sk } from "@/components/Skeleton";

export default function Loading() {
  return (
    <main className="workspace-shell pt-6 sm:pt-10 pb-16 space-y-8 sm:space-y-10" aria-busy="true" aria-label="loading launch form">
      <header className="space-y-3">
        <Sk className="h-10 w-72 max-w-full" />
        <Sk className="h-5 w-3/4 max-w-2xl" />
      </header>
      <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] xl:gap-16">
        <div className="divide-y divide-line">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="space-y-5 py-8 first:pt-0">
              <Sk className="h-5 w-24" />
              <div className="grid sm:grid-cols-2 gap-4">
                <Sk className="h-24 rounded-lg" />
                <Sk className="h-24 rounded-lg" />
              </div>
              <Sk className="h-12 w-full rounded-lg" />
            </div>
          ))}
        </div>
        <aside className="space-y-5 border-t border-line pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <Sk className="h-5 w-16" />
          <div className="flex items-center gap-3">
            <Sk className="h-12 w-12 rounded-xl" />
            <div className="space-y-2 flex-1">
              <Sk className="h-4 w-32" />
              <Sk className="h-3 w-16" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-5 border-b border-line">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-2 border-t border-line py-4"><Sk className="h-3 w-16" /><Sk className="h-5 w-full" /><Sk className="h-3 w-20 max-w-full" /></div>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
