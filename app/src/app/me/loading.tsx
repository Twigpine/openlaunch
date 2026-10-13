import { Sk, SkRow, SkStat } from "@/components/Skeleton";
import shell from "@/components/sections/SectionShell.module.css";

/* The dashboard page's own frame (its SectionIntro header), then the wallet card, the figures and the rows, so nothing
   shifts when the dashboard arrives. */
export default function Loading() {
  return (
    <main className={shell.page} aria-busy="true" aria-label="loading dashboard">
      <header className={shell.intro}>
        <Sk className="h-7 w-36 rounded-full" />
        <div className={shell.introRow}>
          <div className={`${shell.introCopy} w-full`}>
            <Sk className="h-9 w-80 max-w-full sm:h-[50px]" />
            <div className="mt-3.5 space-y-2.5">
              <Sk className="h-4 w-full max-w-[620px]" />
              <Sk className="h-4 w-2/3 max-w-[420px]" />
            </div>
          </div>
        </div>
      </header>
      <Sk className="h-16 w-full rounded-2xl" />
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <SkStat key={i} />
        ))}
      </dl>
      <ul className="mt-5 overflow-hidden rounded-2xl border border-line bg-card">
        {Array.from({ length: 4 }, (_, i) => (
          <SkRow key={i} i={i} />
        ))}
      </ul>
    </main>
  );
}
