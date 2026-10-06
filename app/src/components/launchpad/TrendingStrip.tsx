"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import TokenAvatar from "./TokenAvatar";
import { QuoteBrandBadge, hasQuoteBrandBadge } from "./MuseworldBadge";
import ChangeChip from "./ChangeChip";
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
import { setPendingToken } from "@/lib/launchpad/token-transition";
import styles from "./TrendingStrip.module.css";

type Snap = { window: "1h" | "24h"; items: LaunchRow[] };
/** `swapped`: the leader's card has changed hands since the page loaded, so its entrance means something. */
type Board = { snap: Snap; crown: ReturnType<typeof stickyKing>; swapped: boolean };

const WINDOW_NOTE = "Wallets other than the launcher that traded in this window. Trades and volume count every swap.";
const count = (n: number) => n.toLocaleString("en-US");
const cap = (row: LaunchRow) => capDisplay(row.fdv_quote, row.quote_usd, { key: row.quote_key, symbol: row.quote_symbol, decimals: row.quote_decimals });
const href = (row: LaunchRow) => `/t/${row.chain}/${row.token}`;
// a sentence, so the chain's full name: bare "Robinhood" reads like a listing on the broker
const hint = (row: LaunchRow) => `${row.name} on ${CHAIN_LABELS[row.chain]}, paired with ${row.quote_symbol}`;
const open = (row: LaunchRow) => () => setPendingToken({ chain: row.chain, token: row.token, name: row.name, symbol: row.symbol, image: row.image_url });

// whole strings: Tailwind only ships the classes it can read in the source
const SPAN_SM: Record<BoardCell["sm"], string> = { half: "", wide: "sm:col-span-2" };
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

/** The token on the leader's card: the crowned one while it is still ranked, else the top of the ranking. */
function leadKey(snap: Snap, king: string | null): string | null {
  const lead = snap.items.find((row) => launchKey(row) === king) ?? snap.items[0];
  return lead ? launchKey(lead) : null;
}

/** A fresh ranking: the new order, and a new leader only once a challenger has led two polls (stickyKing). */
function advance(board: Board, next: Snap): Board {
  const crown = stickyKing(board.crown.king, next.items[0] ? launchKey(next.items[0]) : null, board.crown.streak);
  return { snap: next, crown, swapped: board.swapped || leadKey(next, crown.king) !== leadKey(board.snap, board.crown.king) };
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
export default function TrendingStrip({ initial, serverNow }: { initial: Snap; serverNow: number }) {
  const { subscribe } = useLive();
  const reduced = useReducedMotion();
  const [board, setBoard] = useState<Board>({ snap: initial, crown: { king: initial.items[0] ? launchKey(initial.items[0]) : null, streak: { token: null, n: 0 } }, swapped: false });
  const [now, setNow] = useState(serverNow);
  const hold = useRef<BoardHold>(NO_HOLD);
  const pending = useRef<Snap | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const focused = useRef<string | null>(null);

  useEffect(() => subscribe((live) => {
    setNow(live.at); // the shared poll is the clock for the "ago" labels: no timer here
    const next = live.trending;
    if (!next) return;
    // an empty board has no cards, so the mouse can never leave it: drop a hold left over from the board that emptied
    if (!list.current) hold.current = NO_HOLD;
    const { held, ...kept } = holdOnPoll(hold.current);
    hold.current = kept;
    pending.current = held ? next : null;
    focused.current = focusedCard(list.current);
    // a hold keeps the order and nothing else: the figures refresh in place, and the board still moves on when the
    // window changed or a shown token left the ranking (its label and that card would otherwise describe the past)
    setBoard((cur) => (held && sameBoard(cur.snap, next) ? { ...cur, snap: { ...cur.snap, items: refreshInPlace(cur.snap.items, next.items) } } : advance(cur, next)));
  }), [subscribe]);

  /** The mouse left or focus moved out: show the ranking that arrived meanwhile instead of waiting for the next poll. */
  function release() {
    const next = pending.current;
    if (!next || hold.current.pointer || hold.current.focus) return;
    pending.current = null;
    focused.current = focusedCard(list.current);
    // a snapshot the board already moved on to (a hold that gave way) must not count as a second poll for the crown
    setBoard((cur) => (cur.snap === next ? cur : advance(cur, next)));
  }

  const { snap, crown } = board;
  const lead = leadKey(snap, crown.king);
  const items = [...snap.items.filter((row) => launchKey(row) === lead), ...snap.items.filter((row) => launchKey(row) !== lead)].slice(0, BOARD_RUNNERS + 1);
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
    const cards = [...(list.current?.querySelectorAll("a") ?? [])];
    (cards.find((card) => card.getAttribute("href") === was) ?? cards[0])?.focus({ preventScroll: true });
  }, [order]);

  return (
    <section id="trending" aria-labelledby="trending-heading" className="min-w-0 scroll-mt-24">
      <div className="mb-3 flex flex-wrap items-center gap-x-3">
        <h2 id="trending-heading" className="text-base font-semibold leading-8 tracking-tight text-ink">Trending</h2>
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
        // from 1024px as tall as the board (the leader card sets that: 320px), so the page below does not jump when the first token arrives
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-2xl border border-dashed border-line-strong px-4 py-5 lg:min-h-[320px] lg:flex-col lg:justify-center lg:gap-y-3 lg:text-center">
          <p className="text-xs text-muted">A quiet window. Tokens show here once enough different wallets trade them.</p>
          <a href="#launches" className="inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-body hover:text-ink">Explore launches <ArrowUpRight size={13} aria-hidden="true" /></a>
        </div>
      ) : (
        <ol
          ref={list}
          aria-label="Trending tokens"
          aria-describedby="trending-note"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-10 lg:grid-rows-2"
          onPointerEnter={(e) => { if (e.pointerType === "mouse") hold.current = { ...hold.current, pointer: true }; }}
          onPointerLeave={() => { hold.current = { ...hold.current, pointer: false }; release(); }}
          // a click focuses a card too, but only keyboard focus (:focus-visible) may hold the order
          onFocusCapture={(e) => { if (e.target.matches(":focus-visible")) hold.current = { ...hold.current, focus: true, focusPolls: 0 }; }}
          onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { hold.current = { ...hold.current, focus: false, focusPolls: 0 }; release(); } }}
        >
          {/* `relative`: the cards hold sr-only (absolutely positioned) labels; without a positioned ancestor they
              resolve against <main> and stretch the whole page sideways on phones */}
          <li className="relative min-w-0 sm:col-span-2 lg:col-span-4 lg:row-span-2">
            <Leader key={launchKey(first)} row={first} window={snap.window} now={now} top={top} enter={board.swapped} />
          </li>
          {cells.map((cell, index) => {
            const row = rest[index];
            const span = `${SPAN_SM[cell.sm]} ${SPAN_LG[cell.lg]}`;
            if (cell.kind === "open" || !row) {
              // a filler for sighted layout only: the list a screen reader counts holds tokens
              return <li key="open" aria-hidden="true" className={`hidden min-w-0 items-center rounded-2xl border border-dashed border-line-strong px-5 py-4 text-xs leading-relaxed text-muted sm:flex ${span} ${cell.lg === "block" ? "justify-center text-center" : ""}`}><p className="text-pretty"><span className="font-medium text-body">Open spot.</span> Tokens join the board as different wallets trade them.</p></li>;
            }
            return (
              <motion.li key={launchKey(row)} layout={reduced ? false : "position"} layoutDependency={order} transition={{ layout: { duration: 0.28, ease: [0.16, 1, 0.3, 1] } }} className={`relative min-w-0 ${span}`}>
                <Runner row={row} rank={index + 2} window={snap.window} top={top} />
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

/** A token's wallets against the most on the board. Decorative for assistive tech: the wallet count beside it is the value. */
function Bar({ pct, className }: { pct: number; className: string }) {
  return <span aria-hidden="true" className={`block overflow-hidden rounded-full bg-line ${className}`}><span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} /></span>;
}

/**
 * The leader's card. Re-keyed per token, so a new leader arrives with one short entrance instead of a silent swap
 * (`enter`: not on page load, where the card would fade in beside four runners that are already there).
 */
function Leader({ row, window, now, top, enter }: { row: LaunchRow; window: Snap["window"]; now: number; top: number; enter: boolean }) {
  const a = activity(row, window);
  const c = cap(row);
  // "trade" means every swap on this card (the Trades figure counts the launcher's too), so the latest swap by anyone
  const lastTrade = [row.last_trade_at, row.last_outside_trade_at].reduce<string | null>((latest, at) => (at && (!latest || new Date(at) > new Date(latest)) ? at : latest), null);
  const facts = [`${count(row.holders)} ${row.holders === 1 ? "holder" : "holders"}`, lastTrade ? `last trade ${ago(lastTrade, now)} ago` : null, `launched ${ago(row.block_time, now)} ago`].filter(Boolean).join(" · ");
  return (
    <Link href={href(row)} onClick={open(row)} title={hint(row)} className={`flex h-full min-w-0 flex-col rounded-2xl border border-line-strong bg-card p-5 transition-[border-color,box-shadow] hover:border-muted hover:shadow-card-hover motion-reduce:transition-none ${styles.card}`}>
      <div className={`${enter ? "bb-tape-enter " : ""}flex min-h-0 min-w-0 flex-1 flex-col ${styles.leader}`}>
        <div className="min-w-0">
          <p className="flex min-h-5 min-w-0 items-center gap-2 whitespace-nowrap text-[11px]">
            <span className="font-mono text-brand tnum"><span className="sr-only">Number </span>01<span className="sr-only">, </span></span>
            {/* "Leading" is a claim about right now; on the day window the top token may not have traded this hour */}
            <span className="font-medium uppercase tracking-[0.08em] text-ink"><span aria-hidden="true">{window === "1h" ? "Leading" : "Top · 24h"}</span><span className="sr-only">{window === "1h" ? "Leading" : "Top over 24 hours"}</span></span>
            <span className="flex min-w-0 items-center gap-1.5 text-muted"><span aria-hidden="true">·</span><span className="sr-only">, </span>{CHAIN_SHORT[row.chain]}<span aria-hidden="true">·</span><span className="sr-only">, paired with </span>{hasQuoteBrandBadge(row.quote_key) ? <QuoteBrandBadge quoteKey={row.quote_key} /> : <span className="truncate">{row.quote_symbol}</span>}<span className="sr-only">: </span></span>
          </p>
          <div className="mt-3.5 flex min-w-0 items-center gap-3.5">
            <TokenAvatar chain={row.chain} token={row.token} symbol={row.symbol} image={row.image_url} size={52} className="shrink-0 rounded-2xl" />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold leading-snug tracking-tight text-ink">{row.name}</p>
              <p className="truncate font-mono text-xs text-muted"><span className="sr-only">, </span>{row.symbol}</p>
            </div>
          </div>
          <div className="mt-3.5 flex min-w-0 items-center gap-3">
            {/* Space Mono Bold collides at negative tracking, so none; the line box is tall enough that `truncate` clips no glyph */}
            <p className="min-w-0 truncate font-mono text-[30px] font-bold leading-[1.2] tracking-normal text-ink tnum" title={`Market cap ${c.main} · ${c.detail}`}><span className="sr-only">, market cap </span>{c.main}{c.usd === null ? <span className="sr-only">, {c.detail}</span> : null}</p>
            <span aria-hidden="true" className="shrink-0"><ChangeChip v={row.change_from_launch} /></span>
            <span className="sr-only">, {changeWords(row.change_from_launch)}. </span>
          </div>
          <p aria-hidden="true" className="mt-0.5 text-pretty text-[11px] text-muted lg:truncate">Market cap{c.usd === null ? ` (${c.detail})` : ""}, and the change since launch</p>
        </div>
        <div className={`min-h-3.5 flex-1 ${styles.spacer}`} />
        <div title={WINDOW_NOTE} className={`min-w-0 border-t border-line pt-3.5 ${styles.figures}`}>
          <p className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-xs text-body"><span className="font-mono text-lg font-bold leading-6 text-ink tnum">{count(a.wallets)}</span>{a.wallets === 1 ? "wallet" : "wallets"} trading<span className="sr-only">. </span></p>
          <Bar pct={barWidth(a.wallets, top)} className="mt-2 h-1.5" />
          <p className="mt-2.5 text-pretty text-[11px] text-muted lg:truncate" suppressHydrationWarning>{facts}<span className="sr-only">. </span></p>
          <dl className="mt-2.5 flex min-w-0 gap-x-6 text-[11px] text-muted">
            <div className="flex shrink-0 items-baseline gap-1.5"><dt>Trades</dt><dd className="font-mono text-sm font-bold text-ink tnum">{count(a.trades)}<span className="sr-only">, </span></dd></div>
            <div className="flex min-w-0 items-baseline gap-1.5"><dt>Volume</dt><dd className="truncate font-mono text-sm font-bold text-ink tnum" title={`Volume ${a.volume}`}>{a.volume}<span className="sr-only">. </span></dd></div>
          </dl>
        </div>
      </div>
    </Link>
  );
}

/** A runner's card. The visible marks are terse, so sr-only words make the link read as one sentence. */
function Runner({ row, rank, window, top }: { row: LaunchRow; rank: number; window: Snap["window"]; top: number }) {
  const a = activity(row, window);
  const c = cap(row);
  return (
    <Link href={href(row)} onClick={open(row)} title={hint(row)} className={`flex h-full min-w-0 flex-col justify-between rounded-2xl border border-line bg-card px-4 py-3.5 transition-colors hover:border-muted motion-reduce:transition-none sm:py-4 ${styles.card}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="w-5 shrink-0 font-mono text-[11px] text-muted tnum"><span className="sr-only">Number </span>{String(rank).padStart(2, "0")}<span className="sr-only">: </span></span>
        <TokenAvatar chain={row.chain} token={row.token} symbol={row.symbol} image={row.image_url} size={38} className="shrink-0 rounded-xl" />
        {/* the name column keeps a floor and the cap gives way first, so a long quote figure never erases the name */}
        <div className="min-w-16 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{row.name}</p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted"><span className="sr-only">, </span><span className={`truncate font-mono ${row.symbol.length > 3 ? "min-w-[3ch] shrink-[999]" : "shrink-0"}`}>{row.symbol}</span><span aria-hidden="true">·</span><span className="sr-only">, </span><span className="truncate">{CHAIN_SHORT[row.chain]}</span></p>
        </div>
        <div className="min-w-0 max-w-[50%] text-right">
          {/* a quote figure ("478.31M TWIG") is longer than dollars: set smaller, it leaves a ten-letter name whole */}
          <p className={`truncate font-mono font-bold text-ink tnum ${c.usd === null ? "text-[11px] leading-5" : "text-sm"}`} title={`Market cap ${c.main} · ${c.detail}`}><span className="sr-only">, market cap </span>{c.main}</p>
          <span aria-hidden="true" className="mt-0.5 block"><ChangeChip v={row.change_from_launch} plain /></span>
          <span className="sr-only">, {changeWords(row.change_from_launch)}, </span>
        </div>
      </div>
      <div className="mt-3 sm:mt-3.5">
        <Bar pct={barWidth(a.wallets, top)} className="h-[3px]" />
        {/* phones: one line, and the volume drops under it only when it cannot fit. From 640px two lines by design, so
            every card in a row has the same shape whatever its figures and whether or not it carries a pair badge,
            which lives down here where it can never squeeze the symbol */}
        <p className="mt-2 flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:grid-rows-[auto_1.25rem]">
          {/* each space shares a text node with a word: a whitespace-only node is dropped from the link's name ("144wallets") */}
          <span className="whitespace-nowrap sm:col-span-2 sm:truncate"><span className="font-mono font-bold text-ink tnum">{count(a.wallets)}</span>{` ${a.wallets === 1 ? "wallet" : "wallets"} trading `}<span aria-hidden="true">· </span><span className="sr-only">, </span><span className="font-mono text-body tnum">{count(a.trades)}</span>{` ${a.trades === 1 ? "trade" : "trades"}`}</span>
          <span className="order-last ml-auto truncate whitespace-nowrap sm:order-none sm:ml-0" title={`Volume ${a.volume}`}><span className="sr-only">, volume </span><span aria-hidden="true">vol </span><span className="font-mono text-body tnum">{a.volume}</span>{c.usd === null ? <> · {c.detail}</> : null}</span>
          {hasQuoteBrandBadge(row.quote_key) ? <span className="flex shrink-0 items-center"><span className="sr-only">, paired with </span><QuoteBrandBadge quoteKey={row.quote_key} /></span> : null}
        </p>
      </div>
    </Link>
  );
}
