"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import TokenAvatar from "./TokenAvatar";
import { ChainCorner } from "./ChainLogo";
import { QuoteBrandBadge, hasQuoteBrandBadge } from "./MuseworldBadge";
import ChangeChip from "./ChangeChip";
import Roll from "./Roll";
import { useLive } from "./LiveProvider";
import type { LaunchRow } from "@/lib/launchpad/queries";
import { fmtQuote } from "@/lib/launchpad/math";
import { marketUsd } from "@/lib/launchpad/market-format";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { CHAIN_LABELS, CHAIN_SHORT } from "@/lib/chainPublic";
import { ago } from "@/lib/launchpad/time";
import { SNIPER_BLOCKS } from "@/lib/launchpad/holders";
import { FRESH_HOURS, MIN_STRIP, MIN_TRADERS_1H, MIN_TRADES_1H, stickyKing } from "@/lib/launchpad/ranking";
import { BOARD_RUNNERS, barScale, barWidth, boardCells, changeWords, holdOnPoll, sameBoard, type BoardCell, type BoardHold } from "@/lib/launchpad/trending-board";
import { launchKey, refreshInPlace } from "@/lib/launchpad/list-state";
import { FX_LIFE_MS, HANDOVER_LIFE_MS, MOVE_LIFE_MS, PIPS_LEADER, PIPS_RUNNER, applyPlan, bumpOf, cascadeMs, lastTradeAt, pipMagnitude, planHits, rankMoves, streakOf, type CardFx, type CardsState, type TapePip } from "@/lib/launchpad/trending-live";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import styles from "./TrendingStrip.module.css";

type Snap = { window: "1h" | "24h"; items: LaunchRow[]; tape?: Record<string, TapePip[]> };
/**
 * `moves`: places a card gained (positive) or lost at the poll that moved it. `from`: the leader the current leader took
 * over from, once the leader's card has changed hands since the page loaded (so its hand-over means something).
 */
type Board = { snap: Snap; crown: ReturnType<typeof stickyKing>; moves: Record<string, { delta: number; since: number }>; from: { name: string; since: number } | null };

const WINDOW_NOTE = "Wallets other than the launcher that traded in this window. Trades and volume count every swap.";
const count = (n: number) => n.toLocaleString("en-US");
const cap = (row: LaunchRow) => capDisplay(row.fdv_quote, row.quote_usd, { key: row.quote_key, symbol: row.quote_symbol, decimals: row.quote_decimals });
const href = (row: LaunchRow) => `/t/${row.chain}/${row.token}`;
// a sentence, so the chain's full name: bare "Robinhood" reads like a listing on the broker
const hint = (row: LaunchRow) => `${row.name} on ${CHAIN_LABELS[row.chain]}, paired with ${row.quote_symbol}`;
const open = (row: LaunchRow) => () => setPendingToken({ chain: row.chain, token: row.token, name: row.name, symbol: row.symbol, image: row.image_url });

// whole strings: Tailwind only ships the classes it can read in the source
const SPAN_LG: Record<BoardCell["lg"], string> = { half: "lg:col-span-3", wide: "lg:col-span-6", block: "lg:col-span-6 lg:row-span-2" };
const NO_HOLD: BoardHold = { pointer: false, focus: false, focusPolls: 0 };

/** The window's own numbers for one token: outside wallets (the ranking's first key), trades and volume. */
function activity(row: LaunchRow, window: Snap["window"]) {
  const hour = window === "1h";
  const usd = hour ? row.volume_1h_usd : row.volume_24h_usd;
  return {
    wallets: hour ? row.traders_1h_ex : row.traders_24h_ex,
    trades: hour ? row.trades_1h : row.trades_24h,
    volume: usd !== null ? marketUsd(usd) : fmtQuote(hour ? row.volume_1h : row.volume_24h, row.quote_decimals, row.quote_symbol),
  };
}

/** "now" for a trade under ten seconds old, else its age: "3m". */
const since = (ms: number, now: number) => (now - ms < 10_000 ? "now" : ago(new Date(ms).toISOString(), now));
/** The tapes the page seeded, one per card on the board. */
const seedTape = (snap: Snap): Record<string, TapePip[]> => Object.fromEntries(snap.items.map((row) => [launchKey(row), snap.tape?.[launchKey(row)] ?? []]));

/** The token on the leader's card: the crowned one while it is still ranked, else the top of the ranking. */
function leadKey(snap: Snap, king: string | null): string | null {
  const lead = snap.items.find((row) => launchKey(row) === king) ?? snap.items[0];
  return lead ? launchKey(lead) : null;
}

/** The cards on screen, in order: the leader first, then the rest of the ranking. */
function shownItems(snap: Snap, king: string | null): LaunchRow[] {
  const lead = leadKey(snap, king);
  return [...snap.items.filter((row) => launchKey(row) === lead), ...snap.items.filter((row) => launchKey(row) !== lead)].slice(0, BOARD_RUNNERS + 1);
}

/**
 * A fresh ranking: the new order, and a new leader only once a challenger has led two polls (stickyKing). `at` is the
 * poll's clock: it stamps which cards moved (their ▲ / ▼ lasts MOVE_LIFE_MS) and the leader they took over from.
 */
function advance(board: Board, next: Snap, at: number): Board {
  const crown = stickyKing(board.crown.king, next.items[0] ? launchKey(next.items[0]) : null, board.crown.streak);
  // 1h and 24h are two different rankings: moving from one to the other shows a new list, not a race, so nobody moved and nobody took the lead
  if (next.window !== board.snap.window) return { snap: next, crown, moves: {}, from: null };
  const was = shownItems(board.snap, board.crown.king);
  const shown = shownItems(next, crown.king);
  const moves: Board["moves"] = {};
  for (const [token, m] of Object.entries(board.moves)) if (at - m.since < MOVE_LIFE_MS) moves[token] = m;
  for (const [token, delta] of Object.entries(rankMoves(was.map(launchKey), shown.map(launchKey)))) moves[token] = { delta, since: at };
  const handed = was.length > 0 && shown.length > 0 && launchKey(shown[0]) !== launchKey(was[0]);
  return { snap: next, crown, moves, from: handed ? { name: was[0].name, since: at } : board.from };
}

/**
 * The reaction a card plays. A change of leader swaps a token's card between the leader's cell and a runner's, which
 * mounts a new card: whatever reaction the token already had played on the card it replaced, so the new card starts
 * without it and plays only the ones that come after.
 */
function useFreshFx(fx: CardFx | undefined): CardFx | undefined {
  const [atMount] = useState(fx?.id);
  return fx && fx.id !== atMount ? fx : undefined;
}

/** The card that has keyboard focus, by its link: a re-sort can unmount it, and focus must not fall to the page. */
function focusedCard(list: HTMLElement | null): string | null {
  const at = document.activeElement;
  return list && at && list.contains(at) ? at.getAttribute("href") : null;
}

/**
 * Trending as a leaderboard: the leader on a large card, up to four runners beside it, every bar on one scale.
 * Existing on-chain ranking and two-poll leader hold, with chain-scoped identity. The order holds still under a mouse
 * or a keyboard focus (lib/launchpad/trending-board.ts) and the figures keep refreshing in place meanwhile. A hold
 * keeps the order only: when the window changes or a shown token drops out of the ranking, the board re-sorts anyway.
 */
export default function TrendingStrip({ initial, serverNow, seenKeys = [] }: { initial: Snap; serverNow: number; seenKeys?: readonly string[] }) {
  const { subscribe } = useLive();
  const reduced = useReducedMotion();
  const [board, setBoard] = useState<Board>({ snap: initial, crown: { king: initial.items[0] ? launchKey(initial.items[0]) : null, streak: { token: null, n: 0 } }, moves: {}, from: null });
  const [now, setNow] = useState(serverNow);
  const [cards, setCards] = useState<CardsState>(() => ({ tape: seedTape(initial), fx: {}, flips: {} }));
  // the trades the page already drew (the seeded tapes) and the ones its feed held (a runner's tape is shorter than the feed,
  // so a busy runner's older trades are only there): the first polls must not announce either again
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set([...Object.values(seedTape(initial)).flatMap((pips) => pips.map((p) => p.key)), ...seenKeys]);
  const hold = useRef<BoardHold>(NO_HOLD);
  const pending = useRef<Snap | null>(null);
  const settle = useRef(0);
  const lastAt = useRef(serverNow);
  const list = useRef<HTMLOListElement>(null);
  const focused = useRef<string | null>(null);

  /** The mouse left, focus moved out, or a poll's reactions have finished: show the ranking that arrived meanwhile instead of waiting for the next poll. */
  const release = useCallback(() => {
    const next = pending.current;
    if (!next || hold.current.pointer || hold.current.focus) return;
    pending.current = null;
    focused.current = focusedCard(list.current);
    const at = lastAt.current;
    // a snapshot the board already moved on to (a hold that gave way) must not count as a second poll for the crown
    setBoard((cur) => (cur.snap === next ? cur : advance(cur, next, at)));
  }, []);

  useEffect(() => subscribe((live) => {
    setNow(live.at); // the shared poll is the clock for every "ago" label and every reaction: no timer decides what is shown
    lastAt.current = live.at;
    const next = live.trending;
    if (!next) return;
    // what this poll's trades do to the cards: the tapes and the reactions (trending-live.ts decides, this only draws)
    const onBoard = next.items.slice(0, BOARD_RUNNERS + 2).map(launchKey);
    const plan = planHits({ feed: live.feed, seen: seen.current ?? new Set(), board: onBoard, at: live.at });
    seen.current = plan.seen;
    setCards((cur) => applyPlan(cur, plan, live.at, onBoard));
    // an empty board has no cards, so the mouse can never leave it: drop a hold left over from the board that emptied
    if (!list.current) hold.current = NO_HOLD;
    const { held, ...kept } = holdOnPoll(hold.current);
    hold.current = kept;
    // a trade lands before its card climbs: while the reactions play (a moment, never past the next poll) the order
    // waits, as it does under the mouse. Reduced motion has no reactions to wait for.
    const settling = !reduced && plan.hits.length > 0;
    pending.current = held || settling ? next : null;
    focused.current = focusedCard(list.current);
    // a hold keeps the order and nothing else: the figures refresh in place, and the board still moves on when the
    // window changed or a shown token left the ranking (its label and that card would otherwise describe the past)
    setBoard((cur) => ((held || settling) && sameBoard(cur.snap, next) ? { ...cur, snap: { ...cur.snap, items: refreshInPlace(cur.snap.items, next.items) } } : advance(cur, next, live.at)));
    window.clearTimeout(settle.current);
    if (settling && !held) settle.current = window.setTimeout(release, cascadeMs(plan.hits));
  }), [subscribe, release, reduced]);
  useEffect(() => () => window.clearTimeout(settle.current), []);

  const { snap, crown } = board;
  const items = shownItems(snap, crown.king);
  const [first, ...rest] = items;
  const cells = boardCells(rest.length);
  const order = items.map(launchKey).join("|");
  const top = barScale(items.map((row) => activity(row, snap.window).wallets));

  // A change of leader swaps the card between the leader's cell and a runner's, which unmounts the focused link and
  // drops focus to the page. Put it back on the same token's card, or on the leader's when that token left the board.
  useEffect(() => {
    const was = focused.current;
    focused.current = null;
    if (!was || document.activeElement !== document.body) return;
    const cards = [...(list.current?.querySelectorAll("a") ?? [])].filter((card) => card.getClientRects().length > 0);
    (cards.find((card) => card.getAttribute("href") === was) ?? cards[0])?.focus({ preventScroll: true });
  }, [order]);

  return (
    <section id="trending" aria-labelledby="trending-heading" className="min-w-0 scroll-mt-24">
      <div className="mb-3 flex flex-wrap items-center gap-x-3">
        <h2 id="trending-heading" className="text-base font-semibold leading-8 tracking-tight text-ink">{snap.window === "1h" ? "Trending this hour" : "Trending today"}</h2>
        <span className="rounded-full border border-line bg-card px-2.5 py-0.5 text-[11px] text-body">{snap.window === "1h" ? "Last hour" : "Last 24 hours"}</span>
        <p className="ml-auto hidden text-[11px] text-muted sm:block">Ranked by wallets trading, trades and volume</p>
        {/* the rule itself, reachable by touch and keyboard (it used to be a hover title); the numbers are the ranking's own
            constants. Everything in this row is in flow, so larger text spacing wraps it instead of overlapping. The summary
            is a 44px target on phones (the margins keep the row at 32px), where it is the only way to the rule */}
        <details className="group peer ml-auto sm:ml-0">
          <summary className="-my-1.5 flex h-11 cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-body hover:text-ink sm:my-0 sm:h-8 [&::-webkit-details-marker]:hidden">How it&apos;s ranked<ChevronDown size={12} aria-hidden="true" className="group-open:rotate-180" /></summary>
        </details>
        {/* a sibling of the disclosure, shown while it is open: the panel takes the board's full width under the header */}
        <p className="mt-2 hidden basis-full text-pretty rounded-xl border border-line bg-card px-3.5 py-3 text-xs leading-relaxed text-body peer-open:block">
          Wallets other than the launcher count most; swaps in the launch block and the next {SNIPER_BLOCKS} blocks are left out of that count. Trades, dollar volume and holders add on a log scale, and tokens under {FRESH_HOURS} hours old get a boost. To qualify, a token needs {MIN_TRADES_1H} trades and {MIN_TRADERS_1H} such wallets in the last hour. When fewer than {MIN_STRIP} tokens do, the board shows the last 24 hours, where {MIN_TRADES_1H} trades and one such wallet are enough. Tokens paired with an unlisted asset are not ranked.
        </p>
      </div>
      {!first ? (
        // from 1024px as tall as the board (the leader card sets that: 324px), so the page below does not jump when the first token arrives
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-2xl border border-dashed border-line-strong px-4 py-5 lg:min-h-[324px] lg:flex-col lg:justify-center lg:gap-y-3 lg:text-center">
          <p className="text-xs text-muted">A quiet window. Tokens show here once enough different wallets trade them.</p>
          <a href="#launches" className="inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-body hover:text-ink">Explore launches <ArrowUpRight size={13} aria-hidden="true" /></a>
        </div>
      ) : (
        <ol
          ref={list}
          aria-label="Trending tokens"
          aria-describedby="trending-note"
          className={`${styles.board} lg:grid-cols-10 lg:grid-rows-2`}
          onPointerEnter={(e) => { if (e.pointerType === "mouse") hold.current = { ...hold.current, pointer: true }; }}
          onPointerLeave={() => { hold.current = { ...hold.current, pointer: false }; release(); }}
          // a click focuses a card too, but only keyboard focus (:focus-visible) may hold the order
          onFocusCapture={(e) => {
            if (!e.target.matches(":focus-visible")) return;
            hold.current = { ...hold.current, focus: true, focusPolls: 0 };
            // the browser scrolls a card into view only when it is wholly outside the row: bring a partly visible one in too
            e.target.closest("li")?.scrollIntoView({ inline: "nearest", block: "nearest" });
          }}
          onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { hold.current = { ...hold.current, focus: false, focusPolls: 0 }; release(); } }}
        >
          {/* `relative`: the cards hold sr-only (absolutely positioned) labels; without a positioned ancestor they
              resolve against <main> and stretch the whole page sideways on phones */}
          {/* below 1024px the board is a row to swipe and the leader is its first card, drawn like the others; from 1024px the big card.
              Both are always in the page and CSS shows one, so nothing differs between the server and the browser */}
          <li className="relative min-w-0 lg:col-span-4 lg:row-span-2">
            <div className="hidden h-full lg:block"><Leader key={launchKey(first)} row={first} window={snap.window} now={now} top={top} pips={cards.tape[launchKey(first)] ?? []} fx={cards.fx[launchKey(first)]} from={board.from} /></div>
            <div className="h-full lg:hidden"><Runner key={launchKey(first)} lead row={first} rank={1} window={snap.window} top={top} now={now} pips={cards.tape[launchKey(first)] ?? []} fx={cards.fx[launchKey(first)]} move={undefined} from={board.from} /></div>
          </li>
          {cells.map((cell, index) => {
            const row = rest[index];
            const span = SPAN_LG[cell.lg];
            if (cell.kind === "open" || !row) {
              // a filler for sighted layout only: the list a screen reader counts holds tokens
              return <li key="open" aria-hidden="true" className={`hidden min-w-0 items-center rounded-2xl border border-dashed border-line-strong px-5 py-4 text-xs leading-relaxed text-muted lg:flex ${span} ${cell.lg === "block" ? "justify-center text-center" : ""}`}><p className="text-pretty"><span className="font-medium text-body">Open spot.</span> Tokens join the board as different wallets trade them.</p></li>;
            }
            return (
              <motion.li key={launchKey(row)} layout={reduced ? false : "position"} layoutDependency={order} transition={{ layout: { duration: 0.28, ease: [0.16, 1, 0.3, 1] } }} className={`relative min-w-0 ${span}`}>
                <Runner row={row} rank={index + 2} window={snap.window} top={top} now={now} pips={cards.tape[launchKey(row)] ?? []} fx={cards.fx[launchKey(row)]} move={board.moves[launchKey(row)]} />
              </motion.li>
            );
          })}
        </ol>
      )}
      {/* said once for the board, not inside every card's link, where it was read again on each focus */}
      {first ? <p id="trending-note" className="sr-only">{WINDOW_NOTE}</p> : null}
    </section>
  );
}

const k = (n: number) => ({ "--k": n }) as CSSProperties;
/** How a card plays its reaction: when it starts (`--st`), which way it leans (`--dir`: up for a buy) and how hard (`--bump`). */
const fxStyle = (fx: CardFx | undefined, leader: boolean) => (fx ? ({ "--st": `${fx.slot}ms`, "--dir": fx.side === "buy" ? -1 : 1, "--bump": bumpOf(fx.mag, leader).toFixed(4) } as CSSProperties) : undefined);
/** The nudge alternates between two identical keyframes, so a hit right after another replays at once. */
const fxClass = (fx: CardFx | undefined) => (fx ? (fx.parity === 0 ? styles.hitA : styles.hitB) : "");

/**
 * A trade's edge flash and the figure that lifts off the card. Decorative: the tape and the numbers carry the facts.
 * Keyed per reaction, so each is a fresh node and its animation plays once; both end invisible.
 */
function FxNodes({ fx, place }: { fx: CardFx; place: "lead" | "runner" }) {
  const buy = fx.side === "buy";
  return (
    <>
      <span key={`e:${fx.id}`} aria-hidden="true" className={`${styles.edge} ${buy ? styles.buy : styles.sell}`} />
      <span key={`c:${fx.id}`} aria-hidden="true" className={`${styles.chip} ${buy ? styles.buy : styles.sell} ${place === "lead" ? styles.chipLead : buy ? styles.chipTop : styles.chipBottom}`}>{fx.chip}</span>
    </>
  );
}

/** A card's last trades: buys above a hairline, sells below, taller for more dollars, the newest at the right. Decorative for assistive tech: the figures beside it say it all. */
function Tape({ pips, now, big = false, className = "" }: { pips: readonly TapePip[]; now: number; big?: boolean; className?: string }) {
  const buys = pips.filter((p) => p.buy).length;
  const sells = pips.length - buys;
  // a trade still arriving when this tape mounts (a re-sort moved the card) arrived on the card it replaced: it does not pop in again
  const arriving = (p: TapePip) => p.fresh !== undefined && now - p.fresh.since < FX_LIFE_MS;
  const [before] = useState(() => new Set(pips.filter(arriving).map((p) => p.key)));
  return (
    <span aria-hidden="true" title={pips.length ? `Last ${pips.length} trades: ${buys} ${buys === 1 ? "buy" : "buys"}, ${sells} ${sells === 1 ? "sell" : "sells"}` : "Trades show here as they happen"} className={`${styles.tape} ${big ? styles.tapeBig : ""} ${className}`}>
      {pips.map((p) => {
        const fresh = arriving(p) && !before.has(p.key);
        return <span key={p.key} className={`${styles.pip} ${p.buy ? styles.buy : styles.sell} ${fresh ? styles.pipFresh : ""}`} style={{ "--m": pipMagnitude(p.usd).toFixed(2), ...(fresh && p.fresh ? { "--pst": `${p.fresh.slot}ms` } : {}) } as CSSProperties}><i /></span>;
      })}
    </span>
  );
}

/** "×3" while a token is on a run of same-side trades; each new trade in the run pops it again. */
function Streak({ pips, now }: { pips: readonly TapePip[]; now: number }) {
  const run = streakOf(pips, now);
  if (!run) return null;
  const word = run.side === "buy" ? "buys" : "sells";
  return <><span key={run.n} aria-hidden="true" title={`${run.n} ${word} in a row`} className={`${styles.streak} ${run.side === "buy" ? styles.buy : styles.sell}`}>×{run.n}</span><span className="sr-only">, {run.n} {word} in a row. </span></>;
}

/** A token's wallets against the most on the board. Decorative for assistive tech: the wallet count beside it is the value. */
function Bar({ pct, className }: { pct: number; className: string }) {
  return <span aria-hidden="true" className={`block overflow-hidden rounded-full bg-line ${className}`}><span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} /></span>;
}

/**
 * The leader's card. Re-keyed per token, so a new leader arrives as a hand-over instead of a silent swap: its rows come in
 * one after another, a line sweeps its top edge and the card says whom it took the lead from (`from`: not on page load,
 * where the card would play beside four runners that are already there). `fx` is the reaction to a trade on this token.
 */
function Leader({ row, window, now, top, pips, fx: onToken, from }: { row: LaunchRow; window: Snap["window"]; now: number; top: number; pips: readonly TapePip[]; fx: CardFx | undefined; from: Board["from"] }) {
  const fx = useFreshFx(onToken);
  const a = activity(row, window);
  const c = cap(row);
  const handover = from !== null && now - from.since < HANDOVER_LIFE_MS;
  // "trade" means every swap on this card (the Trades figure counts the launcher's too), so the latest swap by anyone
  const lastTrade = lastTradeAt(row, pips);
  const facts = [`${count(row.holders)} ${row.holders === 1 ? "holder" : "holders"}`, lastTrade === null ? null : now - lastTrade < 10_000 ? "last trade just now" : `last trade ${ago(new Date(lastTrade).toISOString(), now)} ago`, `launched ${ago(row.block_time, now)} ago`].filter(Boolean).join(" · ");
  return (
    <Link href={href(row)} onClick={open(row)} title={hint(row)} style={fxStyle(fx, true)} className={`flex h-full min-w-0 flex-col rounded-2xl border border-line-strong bg-card p-5 transition-[border-color,box-shadow] hover:border-muted hover:shadow-card-hover motion-reduce:transition-none ${styles.card} ${fxClass(fx)}`}>
      {fx ? <FxNodes fx={fx} place="lead" /> : null}
      {handover ? <><span aria-hidden="true" className={styles.sweep} /><span aria-hidden="true" className={`${styles.edge} ${styles.edgeLead}`} /></> : null}
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${styles.leader} ${handover ? styles.handover : ""}`}>
        <div className="min-w-0">
          <p style={k(0)} className={`${styles.row} flex min-h-5 min-w-0 items-center gap-2 whitespace-nowrap text-[11px]`}>
            <span className="font-mono text-brand tnum"><span className="sr-only">Number </span>01<span className="sr-only">, </span></span>
            {/* "Leading" is a claim about right now; on the day window the top token may not have traded this hour */}
            {handover ? <span className="font-medium uppercase tracking-[0.08em] text-brand">New leader</span> : <span className="font-medium uppercase tracking-[0.08em] text-ink"><span aria-hidden="true">{window === "1h" ? "Leading" : "Top · 24h"}</span><span className="sr-only">{window === "1h" ? "Leading" : "Top over 24 hours"}</span></span>}
            <span className="flex min-w-0 items-center gap-1.5 text-muted"><span aria-hidden="true">·</span><span className="sr-only">, </span>{CHAIN_SHORT[row.chain]}<span aria-hidden="true">·</span><span className="sr-only">, paired with </span>{hasQuoteBrandBadge(row.quote_key) ? <QuoteBrandBadge quoteKey={row.quote_key} /> : <span className="truncate">{row.quote_symbol}</span>}<span className="sr-only">: </span></span>
          </p>
          <div style={k(1)} className={`${styles.row} mt-3.5 flex min-w-0 items-center gap-3.5`}>
            <span className="relative shrink-0"><TokenAvatar chain={row.chain} token={row.token} symbol={row.symbol} image={row.image_url} size={52} className="rounded-2xl" /><ChainCorner chain={row.chain} size={18} /></span>
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold leading-snug tracking-tight text-ink">{row.name}</p>
              <p className="truncate font-mono text-xs text-muted"><span className="sr-only">, </span>{row.symbol}</p>
            </div>
          </div>
          <div style={k(2)} className={`${styles.row} mt-3.5 flex min-w-0 items-center gap-3`}>
            {/* no negative tracking on a bold figure; the line box is tall enough that `truncate` clips no glyph */}
            <p className="min-w-0 truncate font-mono text-[30px] font-bold leading-[1.2] tracking-normal text-ink tnum" title={`Market cap ${c.main} · ${c.detail}`}><span className="sr-only">, market cap </span><Roll text={c.main} />{c.usd === null ? <span className="sr-only">, {c.detail}</span> : null}</p>
            <span aria-hidden="true" className="shrink-0"><ChangeChip v={row.change_from_launch} roll /></span>
            <span className="sr-only">, {changeWords(row.change_from_launch)}. </span>
          </div>
          <p aria-hidden="true" style={k(3)} className={`${styles.row} mt-0.5 text-pretty text-[11px] lg:truncate ${handover ? "text-brand" : "text-muted"}`}>{handover && from ? `Took the lead from ${from.name}` : `Market cap${c.usd === null ? ` (${c.detail})` : ""}, and the change since launch`}</p>
        </div>
        <div className={`min-h-3.5 flex-1 ${styles.spacer}`} />
        <div title={WINDOW_NOTE} style={k(4)} className={`${styles.row} min-w-0 border-t border-line pt-3.5 ${styles.figures}`}>
          <div className="flex min-w-0 items-center gap-3">
            <p className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap text-xs text-body"><span className="font-mono text-lg font-bold leading-6 text-ink tnum"><Roll text={count(a.wallets)} /></span>{a.wallets === 1 ? "wallet" : "wallets"} trading<span className="sr-only">. </span></p>
            {/* the card's last trades, as they happened: buys above the line, sells below, taller for more dollars */}
            <span className="ml-auto hidden shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-muted sm:inline" aria-hidden="true">Last trades</span>
            <Streak pips={pips} now={now} />
            <Tape pips={pips.slice(-PIPS_LEADER)} now={now} big className="max-w-[250px] flex-1" />
          </div>
          <Bar pct={barWidth(a.wallets, top)} className="mt-2 h-1.5" />
          <p className="mt-2.5 text-pretty text-[11px] text-muted lg:truncate" suppressHydrationWarning>{facts}<span className="sr-only">. </span></p>
          <dl className="mt-2.5 flex min-w-0 gap-x-6 text-[11px] text-muted">
            <div className="flex shrink-0 items-baseline gap-1.5"><dt>Trades</dt><dd className="font-mono text-sm font-bold text-ink tnum"><Roll text={count(a.trades)} /><span className="sr-only">, </span></dd></div>
            <div className="flex min-w-0 items-baseline gap-1.5"><dt>Volume</dt><dd className="truncate font-mono text-sm font-bold text-ink tnum" title={`Volume ${a.volume}`}><Roll text={a.volume} /><span className="sr-only">. </span></dd></div>
          </dl>
        </div>
      </div>
    </Link>
  );
}

/** A runner's card. The visible marks are terse, so sr-only words make the link read as one sentence. */
function Runner({ row, rank, window, top, now, pips, fx: onToken, move, lead = false, from = null }: { row: LaunchRow; rank: number; window: Snap["window"]; top: number; now: number; pips: readonly TapePip[]; fx: CardFx | undefined; move: Board["moves"][string] | undefined; lead?: boolean; from?: Board["from"] }) {
  const fx = useFreshFx(onToken);
  const a = activity(row, window);
  const c = cap(row);
  const last = lastTradeAt(row, pips);
  // `lead`: the leader's card below 1024px, where it is drawn like a runner. It says "New leader" for a few seconds, as the big card does
  const handover = lead && from !== null && now - from.since < HANDOVER_LIFE_MS;
  return (
    <Link href={href(row)} onClick={open(row)} title={hint(row)} style={fxStyle(fx, false)} className={`flex h-full min-w-0 flex-col justify-between rounded-2xl border ${lead ? "border-line-strong" : "border-line"} bg-card px-4 py-3.5 transition-colors hover:border-muted motion-reduce:transition-none sm:py-4 ${styles.card} ${fxClass(fx)}`}>
      {fx ? <FxNodes fx={fx} place="runner" /> : null}
      {handover ? <><span aria-hidden="true" className={styles.sweep} /><span aria-hidden="true" className={`${styles.edge} ${styles.edgeLead}`} /><span aria-hidden="true" className={styles.move}>New leader</span></> : null}
      {move && move.delta !== 0 && now - move.since < MOVE_LIFE_MS ? <span aria-hidden="true" title={move.delta > 0 ? `Up ${move.delta}` : `Down ${-move.delta}`} className={`${styles.move} ${move.delta < 0 ? styles.moveDown : ""}`}>{move.delta > 0 ? "▲" : "▼"}{Math.abs(move.delta)}</span> : null}
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={`w-5 shrink-0 font-mono text-[11px] tnum ${lead ? "text-brand" : "text-muted"}`}><span className="sr-only">Number </span>{String(rank).padStart(2, "0")}<span className="sr-only">: </span></span>
        <span className="relative shrink-0"><TokenAvatar chain={row.chain} token={row.token} symbol={row.symbol} image={row.image_url} size={38} className="rounded-xl" /><ChainCorner chain={row.chain} size={14} /></span>
        {/* the name column keeps a floor and the cap gives way first, so a long quote figure never erases the name */}
        <div className="min-w-16 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{row.name}</p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted"><span className="sr-only">, </span><span className={`truncate font-mono ${row.symbol.length > 3 ? "min-w-[3ch] shrink-[999]" : "shrink-0"}`}>{row.symbol}</span><span aria-hidden="true">·</span><span className="sr-only">, </span><span className="truncate">{CHAIN_SHORT[row.chain]}</span></p>
        </div>
        <div className="min-w-0 max-w-[50%] text-right">
          {/* a quote figure ("478.31M TWIG") is longer than dollars: set smaller, it leaves a ten-letter name whole */}
          <p className={`truncate font-mono font-bold text-ink tnum ${c.usd === null ? "text-[11px] leading-5" : "text-sm"}`} title={`Market cap ${c.main} · ${c.detail}`}><span className="sr-only">, market cap </span><Roll text={c.main} /></p>
          <span aria-hidden="true" className="mt-0.5 block"><ChangeChip v={row.change_from_launch} plain roll /></span>
          <span className="sr-only">, {changeWords(row.change_from_launch)}, </span>
        </div>
      </div>
      <div className="mt-3 sm:mt-3.5">
        <Bar pct={barWidth(a.wallets, top)} className="h-[3px]" />
        {/* two lines on every width, so a card has the same shape whatever its figures: the ranking's own numbers, then the
            volume, how long ago the token last traded, its tape, and the pair badge, which lives down here where it can
            never squeeze the symbol. Each space shares a text node with a word: a whitespace-only node is dropped from the
            link's name ("144wallets") */}
        <p className="mt-2 min-h-5 min-w-0 truncate whitespace-nowrap text-[11px] text-muted"><span className="font-mono font-bold text-ink tnum"><Roll text={count(a.wallets)} /></span>{` ${a.wallets === 1 ? "wallet" : "wallets"} trading `}<span aria-hidden="true">· </span><span className="sr-only">, </span><span className="font-mono text-body tnum"><Roll text={count(a.trades)} /></span>{` ${a.trades === 1 ? "trade" : "trades"}`}</p>
        <div className="mt-0.5 flex h-5 min-w-0 items-center gap-2 text-[11px] text-muted">
          <span className="min-w-0 flex-1 truncate whitespace-nowrap" title={`Volume ${a.volume}`}><span className="sr-only">, volume </span><span aria-hidden="true">vol </span><span className="font-mono text-body tnum"><Roll text={a.volume} /></span>{c.usd === null ? <> · {c.detail}</> : null}</span>
          {last === null ? null : <span className="shrink-0 font-mono tnum" title={`Last trade ${since(last, now)}${now - last < 10_000 ? "" : " ago"}`} suppressHydrationWarning><span className="sr-only">, last trade </span>{since(last, now)}<span className="sr-only">{now - last < 10_000 ? "" : " ago"}. </span></span>}
          <Streak pips={pips} now={now} />
          <Tape pips={pips.slice(-PIPS_RUNNER)} now={now} className="w-[76px] shrink-0" />
          {hasQuoteBrandBadge(row.quote_key) ? <span className="flex shrink-0 items-center"><span className="sr-only">, paired with </span><QuoteBrandBadge quoteKey={row.quote_key} /></span> : null}
        </div>
      </div>
    </Link>
  );
}
