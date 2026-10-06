"use client";

import { useEffect, useState } from "react";
import LiveNumber from "../LiveNumber";

type Pulse = { visits: number; online: number };

/** "56.9K" in the narrow pill; the full count from md up. */
const COMPACT = { notation: "compact", maximumFractionDigits: 1 } as const;

/**
 * "12,480 visits · 3 online". Sends a cookie-free beacon on mount and every 30s
 * (only while the tab is visible), then shows the live numbers. `initial` is the
 * server-rendered value so the pill never flashes empty.
 */
export default function LivePulse({ initial, block = false }: { initial: Pulse; block?: boolean }) {
  const [p, setP] = useState<Pulse>(initial);

  useEffect(() => {
    let alive = true;
    const beat = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/presence", { method: "POST", cache: "no-store", keepalive: true });
        if (res.ok && alive) setP((await res.json()) as Pulse);
      } catch {
        /* offline */
      }
    };
    void beat();
    const t = setInterval(() => void beat(), 30_000);
    const onVis = () => void beat();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const live = p.online > 0;
  const online = (
    <span className="inline-flex items-center gap-1.5">
      {/* beacon: solid dot + an expanding, fading ring (only while someone is here; static under reduced motion) */}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${live ? "bg-up bb-beacon" : "bg-line-strong"}`} aria-hidden />
      {/* the count rolls to its new value when people arrive or leave */}
      <LiveNumber value={p.online} className="font-mono tnum text-ink" /> online
    </span>
  );

  if (block) {
    // the phone menu's footer line: quiet, under the buttons
    return (
      <div className="flex items-center justify-between gap-3 px-3 pb-1 pt-3 text-xs text-muted" title="cookie-free: all-time visits · people here right now">
        <span>
          <LiveNumber value={p.visits} className="font-mono tnum text-body" /> visits
        </span>
        {online}
      </div>
    );
  }
  return (
    <span
      className="hidden sm:inline-flex items-center gap-2 h-6 px-2.5 rounded-full border border-line bg-card text-[11px] font-medium text-muted whitespace-nowrap"
      title="cookie-free: all-time visits · people here right now"
    >
      <span>
        <span className="font-mono tnum text-ink">
          <span className="md:hidden"><LiveNumber value={p.visits} format={COMPACT} /></span>
          <span className="hidden md:inline"><LiveNumber value={p.visits} /></span>
        </span>{" "}
        visits
      </span>
      <span className="text-line-strong" aria-hidden>
        ·
      </span>
      {online}
    </span>
  );
}
