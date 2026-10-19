import { Sk } from "@/components/Skeleton";
import { getTranslations } from "@/i18n/server";

export default async function Loading() {
  const t = await getTranslations("launch");
  return (
    <main className="mx-auto max-w-6xl px-4 pt-8 sm:pt-10 pb-16 space-y-6" aria-busy="true" aria-label={t("page.loading")}>
      <header className="space-y-3">
        <Sk className="h-10 w-72 max-w-full" />
        <Sk className="h-5 w-3/4 max-w-2xl" />
      </header>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem] gap-6 lg:gap-8 items-start">
        <div className="space-y-6">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-2xl bg-card border border-line shadow-card p-5 space-y-4">
              <Sk className="h-5 w-24" />
              <div className="grid sm:grid-cols-2 gap-4">
                <Sk className="h-24 rounded-xl" />
                <Sk className="h-24 rounded-xl" />
              </div>
              <Sk className="h-12 w-full rounded-xl" />
            </div>
          ))}
        </div>
        <aside className="rounded-2xl bg-card border border-line shadow-card p-4 space-y-3">
          <Sk className="h-3 w-16" />
          <div className="flex items-center gap-3">
            <Sk className="h-12 w-12 rounded-xl" />
            <div className="space-y-2 flex-1">
              <Sk className="h-4 w-32" />
              <Sk className="h-3 w-16" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {Array.from({ length: 4 }, (_, i) => (
              <Sk key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
