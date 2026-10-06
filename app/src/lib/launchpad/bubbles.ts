import type { FeedItem } from "./queries";

/**
 * The home page bubble map: every token traded or launched recently, one bubble each. A bubble's area follows the
 * dollars traded and its colour follows which side led. Pure, so the window choice, the totals and the sizes are
 * testable without a browser. Nothing here guesses: an unpriced trade is counted, never given a dollar value.
 */

/** Windows the map can show, shortest first; it takes the first one that holds enough activity to be worth drawing. */
export const BUBBLE_WINDOWS_MS = [30 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
/** The longest look back, and how long the page keeps an event for the map and the Latest column. */
export const BUBBLE_HISTORY_MS = BUBBLE_WINDOWS_MS[BUBBLE_WINDOWS_MS.length - 1];
/** A window is wide enough once it holds this many tokens, or this many events. */
export const BUBBLE_ENOUGH = { tokens: 6, events: 12 } as const;
/** Most bubbles drawn at once, per field size; the rest are the smallest and stay in the list view. */
export const BUBBLE_MAX = { wide: 26, compact: 14 } as const;
const FUTURE_SKEW_MS = 60_000; // a server clock slightly ahead must not drop the newest trade

export type BubbleToken = {
  /** chain:token, lower-cased: one bubble per token per chain. */
  id: string;
  chain: FeedItem["chain"];
  token: string;
  name: string;
  symbol: string;
  image_url: string | null;
  /** Dollars of priced buys and sells in the window. */
  bought: number;
  sold: number;
  buys: number;
  sells: number;
  /** Trades with no dollar price: counted, never valued. */
  unpriced: number;
  /** Launched inside the window. */
  launched: boolean;
  /** The newest event's time, in ms. */
  lastAt: number;
};

export type BubbleLean = { side: "buy" | "sell" | "even" | "new"; strength: number };

const atMs = (item: FeedItem) => new Date(item.at).getTime();
const inside = (item: FeedItem, now: number, windowMs: number) => {
  const age = now - atMs(item);
  return Number.isFinite(age) && age >= -FUTURE_SKEW_MS && age <= windowMs;
};
const idOf = (item: FeedItem) => `${item.chain}:${item.token.toLowerCase()}`;

/** Priced dollars traded, both sides. */
export function bubbleVolume(b: BubbleToken): number {
  return b.bought + b.sold;
}

/** The shortest window that holds enough activity; the longest one when even that stays thin. */
export function bubbleWindow(items: readonly FeedItem[], now: number): number {
  for (const windowMs of BUBBLE_WINDOWS_MS) {
    const held = items.filter((item) => inside(item, now, windowMs));
    const tokens = new Set(held.map(idOf)).size;
    if (tokens >= BUBBLE_ENOUGH.tokens || held.length >= BUBBLE_ENOUGH.events) return windowMs;
  }
  return BUBBLE_HISTORY_MS;
}

/** Per-token totals inside the window, biggest dollar volume first (then the busiest, then the newest). */
export function aggregateBubbles(items: readonly FeedItem[], now: number, windowMs: number): BubbleToken[] {
  const byId = new Map<string, BubbleToken>();
  for (const item of items) {
    if (!inside(item, now, windowMs)) continue;
    const id = idOf(item);
    const at = atMs(item);
    let bubble = byId.get(id);
    if (!bubble) {
      bubble = { id, chain: item.chain, token: item.token, name: item.name, symbol: item.symbol, image_url: item.image_url, bought: 0, sold: 0, buys: 0, sells: 0, unpriced: 0, launched: false, lastAt: at };
      byId.set(id, bubble);
    }
    bubble.lastAt = Math.max(bubble.lastAt, at);
    if (item.kind === "launch") { bubble.launched = true; continue; }
    if (item.is_buy) bubble.buys += 1;
    else bubble.sells += 1;
    if (item.usd === null || !Number.isFinite(item.usd) || item.usd < 0) bubble.unpriced += 1;
    else if (item.is_buy) bubble.bought += item.usd;
    else bubble.sold += item.usd;
  }
  return [...byId.values()].sort((a, b) => bubbleVolume(b) - bubbleVolume(a) || (b.buys + b.sells) - (a.buys + a.sells) || b.lastAt - a.lastAt || a.id.localeCompare(b.id));
}

/**
 * Which side led and by how much (0 to 1): the net share of the priced dollars, or of the trades when none was
 * priced. Inside a tenth either way it reads as even. A token with a launch and no trade yet is new.
 */
export function bubbleLean(b: BubbleToken): BubbleLean {
  const trades = b.buys + b.sells;
  if (trades === 0) return { side: "new", strength: 1 };
  const total = bubbleVolume(b);
  const net = total > 0 ? (b.bought - b.sold) / total : (b.buys - b.sells) / trades;
  if (Math.abs(net) < 0.1) return { side: "even", strength: Math.abs(net) };
  return { side: net > 0 ? "buy" : "sell", strength: Math.min(1, Math.abs(net)) };
}

/**
 * Radii in px. Area follows the dollars traded; a token with none (a launch, or only unpriced trades) takes the
 * smallest priced token's weight, so it is drawn at the small end and never larger than a real trade. Scaled so the
 * bubbles cover about `fill` of the field, then clamped to [min, max].
 */
export function bubbleRadii(tokens: readonly BubbleToken[], area: number, { min, max, fill = 0.4 }: { min: number; max: number; fill?: number }): number[] {
  if (!tokens.length || !(area > 0)) return tokens.map(() => min);
  const priced = tokens.map(bubbleVolume).filter((v) => v > 0);
  const floor = priced.length ? Math.min(...priced) : 1;
  const weights = tokens.map((t) => Math.max(bubbleVolume(t), floor));
  const k = Math.sqrt((fill * area) / (Math.PI * weights.reduce((sum, w) => sum + w, 0)));
  return weights.map((w) => Math.min(max, Math.max(min, k * Math.sqrt(w))));
}

/** "30 minutes", "hour", "3 hours": the window, as it reads after "the last". */
export function bubbleWindowLabel(windowMs: number): string {
  const minutes = Math.round(windowMs / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "hour" : `${hours} hours`;
}

/**
 * The line under the title. A cut-off seed (the newest events only) never claims the whole window: it says what it
 * holds instead, like the river does.
 */
export function bubbleSummary(tokens: readonly BubbleToken[], windowMs: number, complete: boolean): string {
  if (!tokens.length) return "Nothing traded or launched in the last 24 hours";
  const trades = tokens.reduce((sum, t) => sum + t.buys + t.sells, 0);
  const launches = tokens.filter((t) => t.launched).length;
  const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const activity = [trades ? count(trades, "trade", "trades") : null, launches ? count(launches, "launch", "launches") : null].filter(Boolean).join(" and ");
  return complete
    ? `${count(tokens.length, "token", "tokens")}, ${activity} in the last ${bubbleWindowLabel(windowMs)}`
    : `${count(tokens.length, "token", "tokens")} in the latest ${activity}`;
}
