"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { Bubbles, List, LockKeyhole, Waves } from "lucide-react";
import { useLive } from "./LiveProvider";
import TokenAvatar from "./TokenAvatar";
import { TapeList } from "./LaunchTape";
import RiverFeed from "./RiverFeed";
import LiveBubbles from "./LiveBubbles";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import type { FeedItem } from "@/lib/launchpad/queries";
import { RIVER_TICKS, RIVER_WINDOW_MS, feedKey, inRiverWindow, initialRiver, layoutRiver, mergeRiver, pruneRiver, riverFlow, riverSummary, type RiverMark } from "@/lib/launchpad/river";
import { BUBBLE_HISTORY_MS, aggregateBubbles, bubbleSummary, bubbleWindow, bubbleWindowLabel } from "@/lib/launchpad/bubbles";
import { fmtQuote, fmtUsd } from "@/lib/launchpad/math";
import { CHAIN_LABELS, CHAIN_SHORT, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import { ago } from "@/lib/launchpad/time";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import styles from "./LiveRiver.module.css";
import { ShineBorder } from "@/components/vendor/shine-border";
import { ChainCorner, ChainLogoStack } from "./ChainLogo";
import LiveNumber, { COMPACT_USD } from "../LiveNumber";

/** Re-places marks under reduced motion and drops the ones that left the window. */
const CLOCK_MS = 10_000;
/** Label fitting before the time track is measured: the server render and the first client paint must agree. */
const ESTIMATED_WIDTH = { wide: 760, compact: 302 };
const CARD_W = 252;
const NAMES = VISIBLE_CHAINS.map((k) => CHAIN_LABELS[k]);
const WHERE = NAMES.length <= 1 ? (NAMES[0] ?? "") : `${NAMES.slice(0, -1).join(", ")} and ${NAMES[NAMES.length - 1]}`;
const newestAt = (items: readonly FeedItem[], from = 0) => items.reduce((max, item) => Math.max(max, new Date(item.at).getTime() || 0), from);

/** The mark under a mouse pointer, in the stage's coordinates; drives the card and the same-token highlight. */
type Hover = { key: string; token: string; chain: ChainKey; x: number; top: number; bottom: number; below: boolean; stage: number };

/**
 * The last half hour of real launches and trades, flowing right to left, with the newest few beside it. Fed by the
 * page's one poller; nothing here fetches. The drawing is decorative for assistive tech: the list view carries the
 * same events as links.
 */
export default function LiveRiver({ initial, recent: seed = initial, serverNow, coveredSince = null, lastActivityAt = 0 }: { initial: FeedItem[]; recent?: FeedItem[]; serverNow: number; coveredSince?: number | null; lastActivityAt?: number }) {
  const { subscribe } = useLive();
  const [entries, setEntries] = useState(() => initialRiver(initial, serverNow));
  // the bubble map and the Latest column look back up to a day, so a quiet half hour never leaves them empty
  const [recent, setRecent] = useState(() => initialRiver(seed, serverNow, BUBBLE_HISTORY_MS));
  const [now, setNow] = useState(serverNow);
  const [lastAt, setLastAt] = useState(() => newestAt(initial, lastActivityAt));
  const [width, setWidth] = useState<number | null>(null);
  const [view, setView] = useState<"bubbles" | "river" | "list">("bubbles");
  const [hover, setHover] = useState<Hover | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // the list takes the drawing's exact height, so switching views never moves the page
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const centre = useRef(0);
  const tilt = useMotionValue(0);

  useEffect(() => subscribe((snap) => {
    const feed = snap.feed ?? [];
    const t = Date.now();
    setEntries((cur) => mergeRiver(cur, feed, t));
    setRecent((cur) => mergeRiver(cur, feed, t, BUBBLE_HISTORY_MS));
    setLastAt((cur) => newestAt(feed, cur));
  }), [subscribe]);

  useEffect(() => {
    const clock = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setEntries((cur) => pruneRiver(cur, t));
      setRecent((cur) => pruneRiver(cur, t, BUBBLE_HISTORY_MS));
    }, CLOCK_MS);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    const el = lane.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  const marks = useMemo(() => layoutRiver(entries, width === null ? ESTIMATED_WIDTH : { wide: width, compact: width }), [entries, width]);
  const fresh = useMemo(() => new Set(recent.filter((e) => e.fresh).map((e) => feedKey(e.item))), [recent]);
  // the bubble map's window: the shortest that holds enough activity, so a quiet market still shows its last movers
  const windowMs = useMemo(() => bubbleWindow(recent.map((e) => e.item), now), [recent, now]);
  const inView = useMemo(() => recent.filter((e) => inRiverWindow(e.item, now, windowMs)), [recent, now, windowMs]);
  const tokens = useMemo(() => aggregateBubbles(inView.map((e) => e.item), now, windowMs), [inView, now, windowMs]);
  const flow = useMemo(() => riverFlow(view === "river" ? entries : inView), [view, entries, inView]);
  const tickLeft = (minutes: number) => `${(1 - (minutes * 60_000) / RIVER_WINDOW_MS) * 100}%`;
  // a cut-off seed claims no window total until the window has moved past its oldest event
  const complete = coveredSince === null || now - RIVER_WINDOW_MS >= coveredSince;
  const bubblesComplete = coveredSince === null || now - windowMs >= coveredSince;

  const onEnter = useCallback((m: RiverMark, el: HTMLElement) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const r = el.getBoundingClientRect();
    centre.current = r.left + r.width / 2;
    tilt.jump(0);
    // the card opens away from the nearer edge: below a mark in the top of the field, above the rest
    setHover({ key: m.key, token: m.item.token, chain: m.item.chain, x: r.left + r.width / 2 - box.left, top: r.top - box.top, bottom: r.bottom - box.top, below: r.top + r.height / 2 - box.top < box.height * 0.4, stage: box.width });
  }, [tilt]);
  const onLeave = useCallback((key: string) => setHover((h) => (h?.key === key ? null : h)), []);

  const hovered = hover ? marks.find((m) => m.key === hover.key) : undefined;
  const sameToken = hovered ? entries.filter((e) => e.item.kind === "swap" && e.item.token === hovered.item.token && e.item.chain === hovered.item.chain).length : 0;

  return (
    <section aria-labelledby="river-heading" className="relative rounded-3xl border border-line bg-card/70 p-4 shadow-card backdrop-blur-xl sm:p-6">
      <ShineBorder duration={18} />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="river-heading" className="group flex items-start gap-2.5 text-[15px] font-semibold leading-snug tracking-tight text-ink">
            <span className="mt-0.5"><ChainLogoStack chains={VISIBLE_CHAINS} size={17} /></span>
            {/* phones read "Live now" (the full name wrapped to three lines); the heading keeps its full name for assistive tech */}
            <span className="text-pretty"><span aria-hidden="true" className="sm:hidden">Live now</span><span className="sr-only sm:not-sr-only">Live on {WHERE}</span></span>
          </h2>
          <p className="mt-1 text-xs text-muted tnum">{view === "river" ? riverSummary(entries, complete) : bubbleSummary(tokens, windowMs, bubblesComplete)}</p>
          <Flow bought={flow.bought} sold={flow.sold} unpriced={flow.unpriced} className="mt-2.5 flex w-full lg:hidden" />
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <Flow bought={flow.bought} sold={flow.sold} unpriced={flow.unpriced} className="hidden lg:flex" />
          <ToggleGroup aria-label="Activity view" value={[view]} onValueChange={(values) => {
            const next = values[0];
            if (next !== "bubbles" && next !== "river" && next !== "list") return;
            if (next === "list" && body.current) setBodyHeight(body.current.offsetHeight);
            setView(next);
          }}>
            <ToggleGroupItem value="bubbles" aria-label="Show as bubbles" title="Show as bubbles" className="px-2.5"><Bubbles size={14} aria-hidden="true" /><span className="hidden sm:inline">Bubbles</span></ToggleGroupItem>
            <ToggleGroupItem value="river" aria-label="Show as a river" title="Show as a river" className="px-2.5"><Waves size={14} aria-hidden="true" /><span className="hidden sm:inline">River</span></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="Show as a list" title="Show as a list" className="px-2.5"><List size={14} aria-hidden="true" /><span className="hidden sm:inline">List</span></ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {view === "bubbles" ? (
        <div ref={body} className="grid gap-x-6 gap-y-4 pt-4 sm:gap-y-5 sm:pt-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0">
            <p className="sr-only">A bubble for each token traded or launched in the last {bubbleWindowLabel(windowMs)}, sized by the dollars traded. Choose Show as a list for the same events as links.</p>
            <LiveBubbles tokens={tokens} entries={recent} now={now} complete={bubblesComplete} />
            <ul aria-hidden="true" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              <li className="max-sm:hidden">Bigger bubble, more dollars traded</li>
              <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-up" />More bought</li>
              <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-down" />More sold</li>
              <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-brand" />Launched, no trades yet</li>
            </ul>
          </div>
          <RiverFeed entries={recent} now={now} />
        </div>
      ) : view === "river" ? (
        <div ref={body} className="grid gap-x-6 gap-y-5 pt-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0">
            <p className="sr-only">A drawing of the last 30 minutes of trades and launches. Choose Show as a list for the same events as links.</p>
            <div ref={stage} className="relative" onPointerMove={(e) => { if (hover) tilt.set(e.clientX - centre.current); }}>
              <div ref={field} aria-hidden="true" className={styles.field} data-hovering={hover ? "" : undefined}>
                <span className={styles.line} />
                {hover ? <span className={styles.cross} style={{ left: hover.x }} /> : null}
                <div ref={lane} className={styles.lane}>
                  <span className={styles.grid} />
                  {RIVER_TICKS.map((m) => <span key={m} className={styles.tick} style={{ left: tickLeft(m) }} />)}
                  <span className={styles.now} />
                  <span className={`${styles.nowDot} bb-beacon`} />
                  {/* oldest first, so the newest mark paints on top */}
                  {[...marks].reverse().map((m) => <Mark key={m.key} m={m} now={now} match={hover !== null && m.item.token === hover.token && m.item.chain === hover.chain} onEnter={onEnter} onLeave={onLeave} />)}
                </div>
                {entries.length === 0 ? (
                  <div className={styles.empty}>
                    <p className="mx-auto w-fit rounded-md bg-card px-2 text-sm font-medium text-ink">Quiet for the last 30 minutes</p>
                    <p className="mx-auto w-fit rounded-md bg-card px-2 text-xs text-muted">{lastAt ? `The last trade or launch was ${ago(new Date(lastAt).toISOString(), now)} ago. ` : ""}New ones flow in from the right.</p>
                  </div>
                ) : null}
              </div>
              <AnimatePresence>
                {hover && hovered ? <MarkCard key={hover.key} hover={hover} mark={hovered} now={now} trades={sameToken} complete={complete} tilt={tilt} /> : null}
              </AnimatePresence>
            </div>
            <div aria-hidden="true" className={styles.axis}>
              {RIVER_TICKS.map((m) => <span key={m} className={m % 10 ? styles.compactHide : undefined} style={{ left: tickLeft(m) }}>{m} min ago</span>)}
              <span className={styles.nowLabel} style={{ left: "100%" }}>now</span>
              {hover && hovered ? <span className={styles.crossLabel} style={{ left: hover.x }}>{minutesAgo(now - hovered.at)}</span> : null}
            </div>
            <ul aria-hidden="true" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-up" />Buys stand above the line</li>
              <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-down" />Sells hang below it</li>
              <li className="flex items-center gap-1.5"><LockKeyhole size={11} className="text-ink" />Launches sit on it</li>
              <li>Bigger and taller means more dollars</li>
            </ul>
          </div>
          <RiverFeed entries={recent} now={now} />
        </div>
      ) : (
        <div className="pt-5" style={{ height: bodyHeight ?? undefined }}>
          <TapeList items={inView.map((e) => e.item)} now={now} fresh={fresh} label={`Trades and launches in the last ${bubbleWindowLabel(windowMs)}`} className={`rounded-xl border border-line ${bodyHeight ? "h-full" : "max-h-80"}`} />
        </div>
      )}
    </section>
  );
}

/** The hovered mark's place on the time axis, in the axis's own words. */
function minutesAgo(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? "just now" : `${m} min ago`;
}

/** Dollars bought against dollars sold in view, as one split bar. Hidden until a priced trade arrives. */
function Flow({ bought, sold, unpriced, className }: { bought: number; sold: number; unpriced: number; className: string }) {
  const total = bought + sold;
  if (total <= 0) return null;
  const note = `Dollar value of the priced trades in view.${unpriced ? ` ${unpriced} with no dollar price ${unpriced === 1 ? "is" : "are"} left out.` : ""}`;
  return (
    <div title={note} className={`items-center gap-2.5 text-[11px] font-medium tnum ${className}`}>
      <span className="shrink-0 whitespace-nowrap text-right text-up lg:w-[5.75rem]"><LiveNumber value={bought} format={COMPACT_USD} /> bought</span>
      <span aria-hidden="true" className="flex h-1.5 min-w-12 flex-1 gap-0.5 lg:w-28 lg:flex-none">
        <span className="h-full rounded-full bg-up transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{ width: `${(bought / total) * 100}%` }} />
        <span className="h-full flex-1 rounded-full bg-down" />
      </span>
      <span className="shrink-0 whitespace-nowrap text-down-ink lg:w-[5.75rem]"><LiveNumber value={sold} format={COMPACT_USD} /> sold</span>
    </div>
  );
}

const Mark = memo(function Mark({ m, now, match, onEnter, onLeave }: { m: RiverMark; now: number; match: boolean; onEnter: (m: RiverMark, el: HTMLElement) => void; onLeave: (key: string) => void }) {
  const { item } = m;
  const age = Math.min(1, Math.max(0, (now - m.at) / RIVER_WINDOW_MS));
  const style = { "--y": m.y, "--r": m.r, "--nudge": `${m.nudge}px`, "--delay": `-${m.ageAtSeen}ms`, "--age": age, "--fade": age > 0.85 ? (1 - age) / 0.15 : 1 } as CSSProperties;
  const tone = m.kind === "launch" ? styles.launch : m.kind === "buy" ? styles.buy : styles.sell;
  return (
    <Link
      href={`/t/${item.chain}/${item.token}`}
      prefetch={false}
      tabIndex={-1}
      onClick={() => setPendingToken({ chain: item.chain, token: item.token, name: item.name, symbol: item.symbol, image: item.image_url })}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") onEnter(m, e.currentTarget); }}
      onPointerLeave={() => onLeave(m.key)}
      className={`${styles.mark} ${tone} ${m.fresh ? styles.ping : ""}`}
      data-side={m.kind === "buy" ? "up" : m.kind === "sell" ? "down" : undefined}
      data-match={match ? "" : undefined}
      style={style}
    >
      {m.logo ? <span className={styles.avatar}><TokenAvatar chain={item.chain} token={item.token} symbol={item.symbol} image={item.image_url} size={Math.round(m.r * 2)} /></span> : <span className={styles.dot} />}
      {m.kind === "launch" ? <span className={styles.lock}><LockKeyhole size={8} strokeWidth={2.4} /></span> : null}
      {m.label ? <span className={styles.label} data-place={m.place} data-wide={m.showLabel.wide} data-compact={m.showLabel.compact}>{m.label}</span> : null}
    </Link>
  );
});

/** What a mark stands for, on hover. It springs out of the mark and leans a little with the pointer. */
function MarkCard({ hover, mark, now, trades, complete, tilt }: { hover: Hover; mark: RiverMark; now: number; trades: number; complete: boolean; tilt: MotionValue<number> }) {
  const reduced = useReducedMotion();
  const lean = useSpring(useTransform(tilt, [-40, 40], [-5, 5], { clamp: true }), { stiffness: 220, damping: 18 });
  const { item } = mark;
  const left = Math.min(Math.max(hover.x, CARD_W / 2 + 4), hover.stage - CARD_W / 2 - 4);
  const from = { opacity: 0, scale: 0.9, y: hover.below ? -8 : 8 };
  const side = item.kind === "launch" ? { word: "Launch", pill: "bg-ink text-inverse" } : item.is_buy ? { word: "Buy", pill: "bg-up-soft text-up" } : { word: "Sell", pill: "bg-down-soft text-down-ink" };
  return (
    <div aria-hidden="true" className="pointer-events-none absolute z-20" style={{ left, top: hover.below ? hover.bottom + 10 : hover.top - 10, width: CARD_W, transform: `translate(-50%, ${hover.below ? "0" : "-100%"})` }}>
      <motion.div
        initial={reduced ? false : from}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { ...from, transition: { duration: 0.12 } }}
        transition={{ type: "spring", stiffness: 420, damping: 26 }}
        style={{ rotate: reduced ? 0 : lean, transformOrigin: hover.below ? "50% 0%" : "50% 100%" }}
        className="rounded-2xl border border-line bg-raised p-3 shadow-dialog"
      >
        <div className="flex items-center gap-2.5">
          <span className="relative shrink-0">
            <TokenAvatar chain={item.chain} token={item.token} symbol={item.symbol} image={item.image_url} size={32} className="rounded-full" />
            <ChainCorner chain={item.chain} size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight text-ink">{item.name}</span>
            <span className="block truncate text-[11px] leading-tight text-muted">{item.symbol} on {CHAIN_SHORT[item.chain]}</span>
          </span>
          <span className="shrink-0 self-start font-mono text-[10px] text-muted tnum">{ago(item.at, now)}</span>
        </div>
        <div className="mt-2.5 flex items-center gap-2 border-t border-line pt-2.5">
          <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${side.pill}`}>{side.word}</span>
          {item.kind === "swap" ? (
            <>
              <span className="text-[15px] font-semibold tracking-tight text-ink tnum">{item.usd !== null ? fmtUsd(item.usd) : fmtQuote(item.quote_wei, item.quote_decimals, item.quote_symbol)}</span>
              {item.usd !== null ? <span className="min-w-0 truncate text-[11px] text-muted tnum">{fmtQuote(item.quote_wei, item.quote_decimals, item.quote_symbol)}</span> : null}
            </>
          ) : <span className="text-[13px] font-medium text-ink">{item.lp_fee / 10_000}% trading fee</span>}
        </div>
        <p className="mt-1.5 truncate text-[11px] text-muted">
          {item.kind === "launch" ? "Liquidity locked forever" : item.is_dev ? <span className="text-warm-ink">Traded by the creator</span> : item.trader ? `Trader ${shortAddr(item.trader)}` : null}
        </p>
        {item.kind === "swap" && trades > 1 ? <p className="mt-0.5 text-[11px] text-muted">{trades} trades {complete ? "in the last 30 minutes" : "in view"}</p> : null}
      </motion.div>
    </div>
  );
}
