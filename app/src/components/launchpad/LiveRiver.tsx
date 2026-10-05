"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { List, LockKeyhole, Waves } from "lucide-react";
import { useLive } from "./LiveProvider";
import TokenAvatar from "./TokenAvatar";
import { TapeList } from "./LaunchTape";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import type { FeedItem } from "@/lib/launchpad/queries";
import { RIVER_TICKS, RIVER_WINDOW_MS, feedKey, initialRiver, layoutRiver, mergeRiver, pruneRiver, riverSummary, riverUsd, type RiverMark } from "@/lib/launchpad/river";
import { fmtQuote } from "@/lib/launchpad/math";
import { CHAIN_LABELS, CHAIN_SHORT } from "@/lib/chainPublic";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import { ago } from "@/lib/launchpad/time";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import styles from "./LiveRiver.module.css";

/** Re-places marks under reduced motion and drops the ones that left the window. */
const CLOCK_MS = 10_000;
/** Label fitting before the field is measured: the server render and the first client paint must agree. */
const ESTIMATED_WIDTH = { wide: 1086, compact: 343 };
const NAMES = VISIBLE_CHAINS.map((k) => CHAIN_LABELS[k]);
const WHERE = NAMES.length <= 1 ? (NAMES[0] ?? "") : `${NAMES.slice(0, -1).join(", ")} and ${NAMES[NAMES.length - 1]}`;
const newestAt = (items: readonly FeedItem[], from = 0) => items.reduce((max, item) => Math.max(max, new Date(item.at).getTime() || 0), from);

/**
 * The last half hour of real launches and trades, flowing right to left. Fed by the page's one poller;
 * nothing here fetches. The drawing is decorative for assistive tech: the list view carries the same
 * events as links.
 */
export default function LiveRiver({ initial, serverNow, coveredSince = null, lastActivityAt = 0 }: { initial: FeedItem[]; serverNow: number; coveredSince?: number | null; lastActivityAt?: number }) {
  const { subscribe } = useLive();
  const [entries, setEntries] = useState(() => initialRiver(initial, serverNow));
  const [now, setNow] = useState(serverNow);
  const [lastAt, setLastAt] = useState(() => newestAt(initial, lastActivityAt));
  const [width, setWidth] = useState<number | null>(null);
  const [view, setView] = useState<"river" | "list">("river");
  const field = useRef<HTMLDivElement>(null);

  useEffect(() => subscribe((snap) => {
    const feed = snap.feed ?? [];
    const t = Date.now();
    setEntries((cur) => mergeRiver(cur, feed, t));
    setLastAt((cur) => newestAt(feed, cur));
  }), [subscribe]);

  useEffect(() => {
    const clock = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setEntries((cur) => pruneRiver(cur, t));
    }, CLOCK_MS);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  const marks = useMemo(() => layoutRiver(entries, width === null ? ESTIMATED_WIDTH : { wide: width, compact: width }), [entries, width]);
  const fresh = useMemo(() => new Set(entries.filter((e) => e.fresh).map((e) => feedKey(e.item))), [entries]);
  const tickLeft = (minutes: number) => `${(1 - (minutes * 60_000) / RIVER_WINDOW_MS) * 100}%`;
  // a cut-off seed claims no window total until the window has moved past its oldest event
  const complete = coveredSince === null || now - RIVER_WINDOW_MS >= coveredSince;

  return (
    <section aria-labelledby="river-heading" className="-mx-4 border-y border-line px-4 py-4 sm:mx-0 sm:px-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="river-heading" className="flex items-center gap-2.5 text-sm font-medium text-ink">
          <span aria-hidden="true" className="bb-beacon relative h-2 w-2 shrink-0 rounded-full bg-up" />
          Live on {WHERE}
        </h2>
        <div className="flex items-center gap-3">
          <p className="font-mono text-[11px] text-muted tnum">{riverSummary(entries, complete)}</p>
          <ToggleGroup aria-label="Activity view" value={[view]} onValueChange={(values) => { const next = values[0]; if (next === "river" || next === "list") setView(next); }}>
            <ToggleGroupItem value="river" aria-label="Show as a river" title="Show as a river" className="px-2.5"><Waves size={14} aria-hidden="true" /></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="Show as a list" title="Show as a list" className="px-2.5"><List size={14} aria-hidden="true" /></ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {view === "river" ? (
        <>
          <p className="sr-only">A drawing of the last 30 minutes of trades and launches. Choose Show as a list for the same events as links.</p>
          <div ref={field} aria-hidden="true" className={`${styles.field} mt-3`}>
            {RIVER_TICKS.map((m) => <span key={m} className={styles.tick} style={{ left: tickLeft(m) }} />)}
            <span className={styles.line} />
            {/* oldest first, so the newest mark paints on top */}
            {[...marks].reverse().map((m) => <Mark key={m.key} m={m} now={now} />)}
            {entries.length === 0 ? (
              <div className={styles.empty}>
                <p className="mx-auto w-fit bg-paper px-2 text-sm font-medium text-ink">Quiet for the last 30 minutes</p>
                <p className="mx-auto w-fit bg-paper px-2 text-xs text-muted">{lastAt ? `The last trade or launch was ${ago(new Date(lastAt).toISOString(), now)} ago. ` : ""}New ones flow in from the right.</p>
              </div>
            ) : null}
          </div>
          <div aria-hidden="true" className={styles.axis}>
            {RIVER_TICKS.map((m) => <span key={m} className={m % 10 ? styles.compactHide : undefined} style={{ left: tickLeft(m) }}>{m} min ago</span>)}
            <span className={styles.now} style={{ left: "100%" }}>now</span>
          </div>
          <p className="mt-3 text-pretty text-[11px] leading-relaxed text-muted">Buys rise above the line and sells sit below it. New launches land on the line with a lock. A bigger dot is a bigger trade.</p>
        </>
      ) : (
        <TapeList items={entries.map((e) => e.item)} now={now} fresh={fresh} label="Trades and launches in the last 30 minutes" className="mt-3 max-h-80 rounded-xl border border-line" />
      )}
    </section>
  );
}

function Mark({ m, now }: { m: RiverMark; now: number }) {
  const { item } = m;
  const age = Math.min(1, Math.max(0, (now - m.at) / RIVER_WINDOW_MS));
  const style = { "--y": m.y, "--r": m.r, "--nudge": `${m.nudge}px`, "--delay": `-${m.ageAtSeen}ms`, "--age": age, "--fade": age > 0.85 ? (1 - age) / 0.15 : 1 } as CSSProperties;
  const amount = item.kind === "swap" ? (item.usd !== null ? riverUsd(item.usd) : fmtQuote(item.quote_wei, item.quote_decimals, item.quote_symbol)) : "";
  const title = item.kind === "launch" ? `${item.symbol} launched on ${CHAIN_SHORT[item.chain]}` : `${item.is_buy ? "Bought" : "Sold"} ${amount} of ${item.symbol} on ${CHAIN_SHORT[item.chain]}`;
  const tone = m.kind === "launch" ? styles.launch : m.kind === "buy" ? styles.buy : styles.sell;
  return (
    <Link
      href={`/t/${item.chain}/${item.token}`}
      prefetch={false}
      tabIndex={-1}
      title={title}
      onClick={() => setPendingToken({ chain: item.chain, token: item.token, name: item.name, symbol: item.symbol, image: item.image_url })}
      className={`${styles.mark} ${tone} ${m.fresh ? styles.ping : ""}`}
      style={style}
    >
      {m.kind === "launch" ? (
        <>
          <span className={styles.avatar}><TokenAvatar chain={item.chain} token={item.token} symbol={item.symbol} image={item.image_url} size={22} className="rounded-full" /></span>
          <span className={styles.lock}><LockKeyhole size={8} strokeWidth={2.4} /></span>
        </>
      ) : <span className={styles.dot} />}
      {m.label ? <span className={`${styles.label} ${m.kind === "launch" ? styles.launchLabel : ""}`} data-side={m.side} data-wide={m.showLabel.wide} data-compact={m.showLabel.compact}>{m.label}</span> : null}
    </Link>
  );
}
