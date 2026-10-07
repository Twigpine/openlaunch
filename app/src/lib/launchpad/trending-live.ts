/**
 * What a trade does to the Trending board (components/launchpad/TrendingStrip.tsx): which events of the live poll are
 * news for which card, how one poll's reactions are staggered, each card's tape of its last trades, streaks and rank
 * moves. Pure, so node --test loads it directly; the component only renders what this decides.
 * Which tokens are on the board, and in what order, is ranking.ts; how a hold keeps it still is trending-board.ts.
 */

import { feedKey, riverUsd } from "./river";
import { launchKey } from "./list-state";
import { isDustSwap } from "./feed-dust";
import { units } from "./math";
import type { FeedItem } from "./queries";

type FeedSwap = Extract<FeedItem, { kind: "swap" }>;
export type Side = "buy" | "sell";

/** One trade on a card's tape. `key` is the feed's own event key, so a trade seen in the seed and in the feed counts once. */
export type Pip = { key: string; at: number; buy: boolean; usd: number | null; dev: boolean };
/** A pip that arrived with a reaction plays its entrance once: `slot` is when (ms after the poll), `since` which poll. */
export type TapePip = Pip & { fresh?: { slot: number; since: number } };

/** Pips kept per card, so a card promoted to leader still has a full tape. */
export const PIP_CAP = 40;
/** Pips a card's tape has room for: the leader's 250 px at 7 px a tick, a runner's 76 px at 5 px. The page seeds, and draws, no more. */
export const PIPS_LEADER = 36;
export const PIPS_RUNNER = 16;
/** A trade smaller than this ticks the tape and nothing else (the feed's own dust floor is a cent). */
export const MIN_CHIP_USD = 1;
/** Only events this young when first seen are news: a tab waking from sleep must not replay the half hour it missed. */
export const FRESH_MS = 120_000;
const FUTURE_SKEW_MS = 60_000;
/** One card reacts every STEP_MS: under three a second across the whole board, however many cards a poll hits. */
export const STEP_MS = 350;
/** A poll's cascade ends inside this, well before the next poll (5 s). */
export const MAX_CASCADE_MS = 2_000;
/** Pips of one card's poll spring in this far apart (the prototype's pip-in is 520 ms). */
export const PIP_STEP_MS = 90;
const PIP_SPREAD_MS = 360;
/** What a reaction needs to finish on screen: the card's nudge (620 ms) and a margin. */
export const SETTLE_MS = 700;
/** A reaction's nodes (edge, chip, fresh pips) are dropped from state after this. */
export const FX_LIFE_MS = 4_500;
export const STREAK_GAP_MS = 20_000;
export const STREAK_SHOW_MS = 60_000;
export const MOVE_LIFE_MS = 8_000;
export const HANDOVER_LIFE_MS = 7_000;
const SEEN_CAP = 300;

/** The key of a swap, spelled exactly as river.ts feedKey does, for rows that come from the database. */
export function swapKey(chain: string, txHash: string, token: string, logIndex: number): string {
  return `${chain}:swap:${txHash}:${token}:${logIndex}`;
}

/** 0 to 4, the same log scale as the river's dots: $1 is 0.3, $100 is 2, $10K and up is 4; an unpriced trade counts as a small one. */
export function pipMagnitude(usd: number | null): number {
  if (usd === null || !Number.isFinite(usd)) return 1;
  return Math.min(4, Math.max(0, Math.log10(1 + Math.max(0, usd))));
}

export function pipOf(item: FeedSwap): Pip {
  return { key: feedKey(item), at: new Date(item.at).getTime(), buy: item.is_buy, usd: item.usd, dev: item.is_dev };
}

/** A swap row as the tape query reads it, plus what the board row already knows about the token. */
export type SwapRow = { chain: string; token: string; tx_hash: string; log_index: number; is_buy: boolean; quote_wei: string; at: Date | string; trader: string | null };
export type PipInfo = { launcher: string; quote_usd: number | null; quote_decimals: number };

/** A database swap as a pip: priced the way the feed prices it, dust dropped the way the feed drops it. */
export function pipFromSwapRow(row: SwapRow, info: PipInfo): Pip | null {
  const usd = info.quote_usd === null ? null : units(row.quote_wei, info.quote_decimals) * info.quote_usd;
  if (isDustSwap({ usd, quote_wei: row.quote_wei, quote_decimals: info.quote_decimals })) return null;
  const at = new Date(row.at).getTime();
  if (!Number.isFinite(at)) return null;
  return { key: swapKey(row.chain, row.tx_hash, row.token, row.log_index), at, buy: row.is_buy, usd, dev: row.trader !== null && row.trader.toLowerCase() === info.launcher.toLowerCase() };
}

/** The dollars and the count of one side of a poll's trades; `usd` is null when none of them has a price. */
export type Flow = { n: number; usd: number | null };
/** A poll's trades on one card, folded into the one reaction the card takes. */
export type Hit = { token: string; side: Side; buys: Flow; sells: Flow; mag: number; dev: boolean; slot: number; pips: TapePip[] };

const eligible = (p: Pip) => p.usd === null || p.usd >= MIN_CHIP_USD;
function flow(pips: Pip[]): Flow {
  const priced = pips.filter((p) => p.usd !== null);
  return { n: pips.length, usd: priced.length ? priced.reduce((sum, p) => sum + (p.usd as number), 0) : null };
}

export type PlanInput = {
  /** The poll's feed, newest first. */
  feed: readonly FeedItem[];
  /** Event keys already counted: the page's seed and every earlier poll. */
  seen: ReadonlySet<string>;
  /** launchKey of each card on screen, leader first. */
  board: readonly string[];
  /** The server's clock for this poll (live.at). */
  at: number;
};
export type Plan = { hits: Hit[]; silent: Record<string, Pip[]>; seen: Set<string> };

/**
 * What one poll's feed does to the board. A trade is news when its key is new, its token is on a card and it is young;
 * the news of one card in one poll becomes one Hit, and the hits take their turns in board order, STEP_MS apart.
 * Everything else that is new (an old trade, a token off the board, dust under MIN_CHIP_USD alone) only joins the tape.
 */
export function planHits({ feed, seen, board, at }: PlanInput): Plan {
  const nextSeen = new Set(seen);
  const onBoard = new Set(board);
  const groups = new Map<string, Pip[]>();
  const silent: Record<string, Pip[]> = {};
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i];
    if (item.kind !== "swap") continue;
    const key = feedKey(item);
    if (nextSeen.has(key)) continue;
    nextSeen.add(key);
    const token = launchKey(item);
    if (!onBoard.has(token)) continue;
    const pip = pipOf(item);
    if (!Number.isFinite(pip.at)) continue;
    const age = at - pip.at;
    if (age > FRESH_MS || age < -FUTURE_SKEW_MS) (silent[token] ??= []).push(pip);
    else groups.set(token, [...(groups.get(token) ?? []), pip]);
  }
  // an event that has left the feed never comes back, so only a bounded memory of them is kept
  for (const key of nextSeen) {
    if (nextSeen.size <= SEEN_CAP) break;
    nextSeen.delete(key);
  }
  const hits: Hit[] = [];
  for (const token of board) {
    const group = groups.get(token);
    if (!group) continue;
    const news = group.filter(eligible);
    if (news.length === 0) {
      (silent[token] ??= []).push(...group);
      continue;
    }
    const slot = Math.min(hits.length * STEP_MS, MAX_CASCADE_MS - STEP_MS);
    const buys = flow(news.filter((p) => p.buy));
    const sells = flow(news.filter((p) => !p.buy));
    const side: Side = buys.usd !== null || sells.usd !== null ? ((buys.usd ?? 0) >= (sells.usd ?? 0) ? "buy" : "sell") : buys.n >= sells.n ? "buy" : "sell";
    hits.push({
      token, side, buys, sells,
      mag: Math.max(...news.map((p) => pipMagnitude(p.usd))),
      dev: news.some((p) => p.dev),
      slot,
      pips: group.map((p, i) => ({ ...p, fresh: { slot: slot + Math.min(i * PIP_STEP_MS, PIP_SPREAD_MS), since: at } })),
    });
  }
  return { hits, silent, seen: nextSeen };
}

/** The words on the lift-off chip: "Buy $45", "3 buys $210", "Buy $50 · Sell $20", with "· creator" when the launcher traded. */
export function chipText(hit: Pick<Hit, "buys" | "sells" | "dev">): string {
  const part = (f: Flow, one: string, many: string) => (f.n === 0 ? null : `${f.n === 1 ? one : `${f.n} ${many}`}${f.usd === null ? "" : ` ${riverUsd(f.usd)}`}`);
  const text = [part(hit.buys, "Buy", "buys"), part(hit.sells, "Sell", "sells")].filter(Boolean).join(" · ");
  return hit.dev ? `${text} · creator` : text;
}

/** Add pips to a card's tape: one per event key (the first one seen wins), oldest first, at most `cap`. */
export function mergeTape(current: readonly TapePip[] | undefined, add: readonly TapePip[], cap = PIP_CAP): TapePip[] {
  const byKey = new Map<string, TapePip>();
  for (const pip of current ?? []) byKey.set(pip.key, pip);
  for (const pip of add) if (!byKey.has(pip.key)) byKey.set(pip.key, pip);
  return [...byKey.values()].sort((a, b) => a.at - b.at).slice(-cap);
}

/** A run of quick same-side trades on one token ("×3"), while the newest of them is under STREAK_SHOW_MS old. */
export function streakOf(pips: readonly Pip[], now: number): { side: Side; n: number } | null {
  const last = pips[pips.length - 1];
  if (!last || now - last.at >= STREAK_SHOW_MS) return null;
  let n = 1;
  for (let i = pips.length - 2; i >= 0; i--) {
    if (pips[i].buy !== last.buy || pips[i + 1].at - pips[i].at > STREAK_GAP_MS) break;
    n++;
  }
  return n >= 2 ? { side: last.buy ? "buy" : "sell", n } : null;
}

/**
 * When a token last traded, in ms: the later of what its row says (any swap, or the last by an outside wallet) and the
 * newest pip on its tape, which can be fresher than the row. Null when nothing says.
 */
export function lastTradeAt(row: { last_trade_at: string | null; last_outside_trade_at: string | null }, pips: readonly Pip[]): number | null {
  const times = [row.last_trade_at, row.last_outside_trade_at].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
  if (pips.length) times.push(pips[pips.length - 1].at);
  return times.length ? Math.max(...times) : null;
}

/** Places each token moved on the board: positive is up, for tokens on both boards whose place changed. */
export function rankMoves(prev: readonly string[], next: readonly string[]): Record<string, number> {
  const moves: Record<string, number> = {};
  next.forEach((token, i) => {
    const was = prev.indexOf(token);
    if (was >= 0 && was !== i) moves[token] = was - i;
  });
  return moves;
}

/** How long a poll's cascade needs on screen: the last card's slot plus its own settle time. 0 when nothing reacts. */
export function cascadeMs(hits: readonly Pick<Hit, "slot">[]): number {
  return hits.length ? Math.max(...hits.map((h) => h.slot)) + SETTLE_MS : 0;
}

/**
 * The tapes a board is drawn with, or nothing when the read failed. They are the cards' decoration, so a database that
 * cannot answer this one query leaves the cards without trades to draw: it never takes the whole page down with it.
 */
export async function tapeOrNone(read: () => Promise<Record<string, Pip[]>>, onError: (error: unknown) => void): Promise<Record<string, Pip[]> | undefined> {
  try {
    return await read();
  } catch (error) {
    onError(error);
    return undefined;
  }
}

/** What each card is doing because of trades: the pips of its tape, and the reaction it is playing (if any). */
export type CardFx = { id: string; side: Side; parity: 0 | 1; chip: string; mag: number; slot: number; since: number; dev: boolean };
/** `flips`: which of the two identical nudge keyframes a card played last, so the next hit can play the other and replay at once. */
export type CardsState = { tape: Record<string, TapePip[]>; fx: Record<string, CardFx>; flips: Record<string, 0 | 1> };

/**
 * Fold a poll's plan into the cards' state: the pips join the tapes, a reaction replaces the card's last one, and the
 * reactions and fresh pips of earlier polls are dropped once they have finished. With `keep` (the tokens on the board),
 * tokens that left it are forgotten, so a long session never accumulates tapes.
 */
export function applyPlan(cur: CardsState, plan: Pick<Plan, "hits" | "silent">, at: number, keep?: readonly string[]): CardsState {
  const kept = keep ? new Set(keep) : null;
  const tape: Record<string, TapePip[]> = {};
  for (const [token, pips] of Object.entries(cur.tape)) {
    if (kept && !kept.has(token)) continue;
    tape[token] = pips.some((p) => p.fresh && at - p.fresh.since >= FX_LIFE_MS) ? pips.map((p) => (p.fresh && at - p.fresh.since >= FX_LIFE_MS ? { ...p, fresh: undefined } : p)) : pips;
  }
  for (const [token, pips] of Object.entries(plan.silent)) if (!kept || kept.has(token)) tape[token] = mergeTape(tape[token], pips);
  const fx: Record<string, CardFx> = {};
  for (const [token, f] of Object.entries(cur.fx)) if ((!kept || kept.has(token)) && at - f.since < FX_LIFE_MS) fx[token] = f;
  const flips: Record<string, 0 | 1> = {};
  for (const [token, flip] of Object.entries(cur.flips)) if (!kept || kept.has(token)) flips[token] = flip;
  for (const hit of plan.hits) {
    tape[hit.token] = mergeTape(tape[hit.token], hit.pips);
    const parity: 0 | 1 = flips[hit.token] === 0 ? 1 : 0;
    flips[hit.token] = parity;
    fx[hit.token] = { id: `${at}:${hit.token}`, side: hit.side, parity, chip: chipText(hit), mag: hit.mag, slot: hit.slot, since: at, dev: hit.dev };
  }
  return { tape, fx, flips };
}

/** The nudge a card takes for a trade of this size: up to 0.9% on the leader and 1.2% on a runner, never more. */
export function bumpOf(mag: number, leader: boolean): number {
  const m = Math.min(4, Math.max(0, mag));
  return leader ? Math.min(0.009, 0.003 + m * 0.0015) : Math.min(0.012, 0.004 + m * 0.002);
}
