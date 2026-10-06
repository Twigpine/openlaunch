import { Sk, SkFeedPost } from "@/components/Skeleton";
import shell from "@/components/sections/SectionShell.module.css";
import styles from "@/components/sections/CommunityFeed.module.css";

/**
 * /feed skeleton. Same shell, intro, two-column grid and post rhythm as FeedPage + CommunityFeed
 * (it borrows their CSS modules, so breakpoints stay in sync) so nothing shifts when the posts arrive.
 */
export default function Loading() {
  return (
    <main className={shell.page} aria-busy="true" aria-label="Loading posts">
      <header className={shell.intro}>
        <Sk className="h-7 w-40 rounded-full" />
        <div className={shell.introRow}>
          <div className={`${shell.introCopy} w-full`}>
            <Sk className="h-9 w-72 max-w-full sm:h-[50px]" />
            <div className="mt-4">
              <div className="flex h-[26px] items-center sm:h-[27px]"><Sk className="h-4 w-full max-w-[620px]" /></div>
              <div className="flex h-[26px] items-center sm:h-[27px]"><Sk className="h-4 w-3/4 max-w-[460px]" /></div>
            </div>
          </div>
          <Sk className="h-11 w-40 rounded-xl" />
        </div>
      </header>
      <div className={styles.layout}>
        <section className={shell.panel} aria-label="Loading recent community posts">
          <div className={styles.toolbar}><Sk className="h-4 w-44 max-w-full" /><Sk className="h-11 w-11 rounded-full" /></div>
          <div className={styles.filters}><Sk className="h-[54px] w-60 max-w-full rounded-xl" /><Sk className="h-11 min-w-[180px] flex-1 rounded-xl" /></div>
          <div className={styles.resultLine}><p className="flex h-4 items-center"><Sk className="h-3 w-24" /></p><span className="flex h-4 items-center"><Sk className="h-3 w-36" /></span></div>
          <ul>
            {Array.from({ length: 6 }, (_, i) => (
              <SkFeedPost key={i} i={i} />
            ))}
          </ul>
          <div className={styles.feedFoot}><Sk className="h-3 w-80 max-w-full" /></div>
        </section>
        <aside className={styles.aside} aria-hidden="true">
          <section className={styles.guide}>
            <div className="flex h-[23px] items-center"><Sk className="h-5 w-48 max-w-full" /></div>
            <div className="mt-2">
              <div className="flex h-[23px] items-center"><Sk className="h-3.5 w-full" /></div>
              <div className="flex h-[23px] items-center"><Sk className="h-3.5 w-5/6" /></div>
            </div>
            <ul className={styles.steps}>
              {[0, 1, 2].map((i) => (
                <li key={i}><Sk className="size-8 shrink-0 rounded-[10px]" /><div className="min-w-0 flex-1"><div className="flex h-5 items-center"><Sk className="h-3.5 w-32 max-w-full" /></div><div className="mt-1 flex h-5 items-center"><Sk className="h-3 w-44 max-w-full" /></div></div></li>
              ))}
            </ul>
            <div className="flex h-11 items-center"><Sk className="h-3.5 w-32" /></div>
          </section>
          <section className={styles.note}>
            <Sk className="size-8 rounded-[10px]" />
            <div className="mt-3.5 flex h-[21px] items-center"><Sk className="h-4 w-44 max-w-full" /></div>
            <div className="mt-2.5">
              {["w-full", "w-full", "w-full", "w-2/3"].map((w, i) => <div key={i} className="flex h-[21px] items-center"><Sk className={`h-3 ${w}`} /></div>)}
            </div>
            <div className={styles.caution}>
              {["w-full", "w-full", "w-1/2"].map((w, i) => <div key={i} className="flex h-[21px] items-center"><Sk className={`h-3 ${w}`} /></div>)}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
