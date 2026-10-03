"use client";

import { type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Star } from "lucide-react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/vendor/tabs";
import { useWatchlist } from "./useWatchlist";
import WatchlistPanel from "./WatchlistPanel";
import styles from "./LaunchBrowser.module.css";

export default function LaunchBrowser({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const router = useRouter();
  const { entries, ready } = useWatchlist();
  const view = params.get("view") === "watchlist" ? "watchlist" : "all";
  function select(value: unknown) {
    const next = new URLSearchParams(params);
    if (value === "watchlist") next.set("view", "watchlist");
    else next.delete("view");
    router.replace(`/${next.size ? `?${next}` : ""}#launches`, { scroll: false });
  }
  return (
    <Tabs id="launches" value={view} onValueChange={select} className={`${styles.market} min-w-0 scroll-mt-24`}>
      <header className={styles.header}>
        <div className="min-w-0">
          <div className={styles.kicker}><span className={`${styles.liveDot} bb-beacon`} aria-hidden="true" />Open market</div>
          <h2 className={styles.title}>Markets, live onchain.</h2>
          <p className={styles.subtitle}>From first block to first buyer, every launch stays visible.</p>
        </div>
        <TabsList aria-label="Launch browser" className={`${styles.viewTabs} gap-0 overflow-visible rounded-xl border-0 p-1`}>
          <TabsTab value="all" className={`${styles.viewTab} min-h-10 border-0 px-3`}>Market</TabsTab>
          <TabsTab value="watchlist" className={`${styles.viewTab} min-h-10 border-0 px-3`}><Star size={14} aria-hidden="true" /> Saved <span className={styles.savedCount}>{ready ? entries.length : ""}</span></TabsTab>
        </TabsList>
      </header>
      <TabsPanel value="all" keepMounted>{children}</TabsPanel>
      <TabsPanel value="watchlist"><WatchlistPanel onBrowse={() => select("all")} /></TabsPanel>
    </Tabs>
  );
}
