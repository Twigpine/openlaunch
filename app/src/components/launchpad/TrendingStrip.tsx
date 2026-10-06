"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, Crown, Flame } from "lucide-react";
import TokenAvatar from "./TokenAvatar";
import ChangeChip from "./ChangeChip";
import { QuoteBrandBadge } from "./MuseworldBadge";
import { useLive } from "./LiveProvider";
import type { LaunchRow } from "@/lib/launchpad/queries";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { stickyKing } from "@/lib/launchpad/ranking";
import { launchKey, refreshInPlace } from "@/lib/launchpad/list-state";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import { BorderBeam } from "@/components/vendor/border-beam";
import { ChainCorner } from "./ChainLogo";

type Snap = { window: "1h" | "24h"; items: LaunchRow[] };
/** How far one arrow press moves the rail: most of a view, so the next cards land where the eye already is. */
const PAGE = 0.85;

/**
 * The trending leaderboard: a rail of cards you can swipe or page with arrows, each with its rank, its numbers and
 * why it ranks (different wallets trading, then trades). The leader holds the crown across polls (stickyKing). Live
 * updates wait while a pointer or focus is on the rail, so a card never moves out from under a click.
 */
export default function TrendingStrip({ initial }: { initial: Snap }) {
  const { subscribe } = useLive();
  const reduced = useReducedMotion();
  const [snap, setSnap] = useState(initial);
  const [crown, setCrown] = useState({ king: initial.items[0] ? launchKey(initial.items[0]) : null, streak: { token: null as string | null, n: 0 } });
  const [edges, setEdges] = useState({ start: true, end: false });
  const active = useRef({ pointer: false, focus: false });
  const pending = useRef<Snap | null>(null);
  const rail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function apply(next: Snap) {
      setCrown((prev) => stickyKing(prev.king, next.items[0] ? launchKey(next.items[0]) : null, prev.streak));
      setSnap(next);
    }
    const unsubscribe = subscribe((live) => {
      if (!live.trending) return;
      if (active.current.pointer || active.current.focus) {
        pending.current = live.trending;
        // Preserve the displayed time window too: don't relabel old rankings.
        const next = live.trending;
        setSnap((cur) => ({ ...cur, items: refreshInPlace(cur.items, next.items) }));
      } else {
        pending.current = null;
        apply(live.trending);
      }
    });
    const timer = setInterval(() => {
      if (pending.current && !active.current.pointer && !active.current.focus) {
        apply(pending.current);
        pending.current = null;
      }
    }, 1_000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [subscribe]);

  // which ends of the rail still hide cards: the arrows and the edge fades follow
  function measure(el: HTMLElement | null) {
    if (!el) return;
    const next = edgesOf(el);
    setEdges((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
  }
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const next = edgesOf(el);
      setEdges((cur) => (cur.start === next.start && cur.end === next.end ? cur : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  function page(direction: 1 | -1) {
    const el = rail.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * PAGE, behavior: reduced ? "auto" : "smooth" });
  }

  const leader = snap.items.find((row) => launchKey(row) === crown.king);
  const items = leader ? [leader, ...snap.items.filter((row) => launchKey(row) !== crown.king)] : snap.items;
  const heading = snap.window === "1h" ? "Trending this hour" : "Trending today";
  const span = snap.window === "1h" ? "this hour" : "today";
  // an edge fades only while cards hide past it
  const mask = { maskImage: `linear-gradient(to right, ${edges.start ? "#000" : "transparent"}, #000 28px, #000 calc(100% - 28px), ${edges.end ? "#000" : "transparent"})` } as CSSProperties;

  return (
    <section aria-labelledby="trending-heading" className="min-w-0">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id="trending-heading" className="flex items-center gap-2 text-sm font-semibold text-ink"><Flame size={15} aria-hidden="true" className="text-warm" />{heading}</h2>
          <p className="mt-0.5 text-[11px] text-muted">Ranked by different wallets trading, then trades and volume</p>
        </div>
        {items.length > 0 ? (
          <div className="hidden shrink-0 items-center gap-1 sm:flex">
            <button type="button" onClick={() => page(-1)} disabled={edges.start} aria-label="Show earlier trending tokens" className={arrow}><ChevronLeft size={16} aria-hidden="true" /></button>
            <button type="button" onClick={() => page(1)} disabled={edges.end} aria-label="Show more trending tokens" className={arrow}><ChevronRight size={16} aria-hidden="true" /></button>
          </div>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted">A quiet window. Tokens show here once enough different wallets trade them.</p>
      ) : (
        <div
          ref={rail}
          onScroll={(e) => measure(e.currentTarget)}
          style={mask}
          className="-mx-4 snap-x snap-mandatory overflow-x-auto scroll-px-4 px-4 py-1 [scrollbar-width:none] motion-reduce:scroll-auto sm:mx-0 sm:scroll-px-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
          onPointerEnter={(e) => { if (e.pointerType === "mouse") active.current.pointer = true; }}
          onPointerLeave={() => { active.current.pointer = false; }}
          onFocusCapture={() => { active.current.focus = true; }}
          onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) active.current.focus = false; }}
        >
          <ol aria-label="Trending tokens" className="flex w-max gap-3">
            {items.map((row, index) => {
              const trades = snap.window === "1h" ? row.trades_1h : row.trades_24h;
              const wallets = snap.window === "1h" ? row.traders_1h_ex : row.traders_24h_ex;
              const king = index === 0 && leader !== undefined;
              // `relative`: the cards hold sr-only (absolutely positioned) labels; without a positioned ancestor inside
              // the scroller they resolve against <main> and stretch the whole page sideways on phones
              return (
                <li key={launchKey(row)} className="relative w-[15.5rem] shrink-0 snap-start">
                  <Link
                    href={`/t/${row.chain}/${row.token}`}
                    onClick={() => setPendingToken({ chain: row.chain, token: row.token, name: row.name, symbol: row.symbol, image: row.image_url })}
                    title={`${row.name} on ${CHAIN_SHORT[row.chain]}, paired with ${row.quote_symbol}`}
                    className={`relative flex h-full flex-col overflow-hidden rounded-2xl border bg-card p-3.5 transition-[border-color,translate] duration-200 hover:-translate-y-0.5 hover:border-line-strong motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${king ? "border-warm/35" : "border-line"}`}
                  >
                    {/* the leader's card: a slow amber beam on its border, the crown beside its name */}
                    {king ? <BorderBeam size={90} duration={9} colorFrom="var(--color-warm)" colorTo="var(--color-warm)" /> : null}
                    <span className="sr-only">Number {index + 1}{king ? ", leading" : ""}: </span>
                    <span className="flex min-w-0 items-center gap-3">
                      <span aria-hidden="true" className={`w-5 shrink-0 text-center text-xl font-bold tracking-tight tnum ${king ? "text-warm" : index < 3 ? "text-ink" : "text-faint"}`}>{index + 1}</span>
                      <span className="relative shrink-0"><TokenAvatar chain={row.chain} token={row.token} symbol={row.symbol} image={row.image_url} size={38} className="rounded-xl" /><ChainCorner chain={row.chain} size={14} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink">{row.name}</span>
                        {/* the pair badge rides on the ticker line, so the name keeps its room */}
                        <span className="flex h-5 min-w-0 items-center gap-1.5 text-[11px] text-muted"><span className="truncate"><span className="font-mono">{row.symbol}</span> · {CHAIN_SHORT[row.chain]}</span><QuoteBrandBadge quoteKey={row.quote_key} /></span>
                      </span>
                      {king ? <Crown size={15} aria-hidden="true" className="shrink-0 self-start text-warm" /> : null}
                    </span>
                    <span className="mt-3 flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-mono text-[15px] font-bold tracking-tight text-ink tnum"><span className="sr-only">market cap </span>{capDisplay(row.fdv_quote, row.quote_usd, { key: row.quote_key, symbol: row.quote_symbol, decimals: row.quote_decimals }).compact}</span>
                      <span className="shrink-0"><span className="sr-only">change since launch </span><ChangeChip v={row.change_from_launch} /></span>
                    </span>
                    {/* why it ranks: the different wallets first, then the trades */}
                    <span className="mt-1.5 block truncate text-[11px] text-muted"><b className="font-semibold text-body tnum">{wallets.toLocaleString("en-US")}</b> {wallets === 1 ? "wallet" : "wallets"} · <span className="tnum">{trades.toLocaleString("en-US")}</span> {trades === 1 ? "trade" : "trades"} {span}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}

/** Whether the rail sits at its start, and at its end. */
function edgesOf(el: HTMLElement): { start: boolean; end: boolean } {
  return { start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 };
}

const arrow = "grid size-8 place-items-center rounded-full border border-line bg-card text-muted transition-colors hover:border-line-strong hover:text-ink disabled:pointer-events-none disabled:opacity-35 motion-reduce:transition-none";
