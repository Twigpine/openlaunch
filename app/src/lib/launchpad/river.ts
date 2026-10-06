import type { FeedItem } from "./queries";

/**
 * The home page river: the last half hour of real launches and trades, newest at the right edge.
 * Time runs along x and is drawn by CSS (every mark drifts at the same speed), so this module only
 * decides what x cannot: which events are in the window, how far each one stands from the line, how
 * big it is, and which labels fit without colliding. Pure, so the layout is testable without a browser.
 */
export const RIVER_WINDOW_MS = 30 * 60_000;
/** Gridlines, in minutes ago. */
export const RIVER_TICKS = [5, 10, 15, 20, 25] as const;
/** Upper bound on marks held at once. The live poll delivers the newest 24 every five seconds. */
export const RIVER_MAX_ITEMS = 240;
/** Field heights in px. The compact field (phones) scales marks by COMPACT_SCALE. */
export const RIVER_HEIGHT = { wide: 240, compact: 168 } as const;
export const COMPACT_SCALE = 0.75;
/** A trade must be at least this many dollars to show its amount at rest; smaller ones show it on hover. */
export const LABEL_MIN_USD = { wide: 20, compact: 90 } as const;
/** At most this many labels at rest, so the field reads as tokens rather than text. */
export const LABEL_MAX = { wide: 6, compact: 2 } as const;
/** A trade at least this big (radius in px, wide field) carries the token's own image; smaller ones are plain dots. */
export const LOGO_MIN_R = 8;

const LAUNCH_R = 12;
const CLUSTER_MS = 12_000; // marks closer than this in the same lane stack instead of overlapping
const MAX_STACK = 4;
const LABEL_H = 16;
const LABEL_GAP = 6; // clear of the ring around a logo
const RING = { logo: 3.5, dot: 2 }; // the ring each mark draws past its radius
const CHAR_W = 6.4; // 10.5px tabular figures
const NAME_CHAR_W = 7.4; // 11px semibold capitals
const LABEL_PAD = 12;
/** Room past now before the field ends (the `.lane` inset in LiveRiver.module.css): the newest mark and its label fit in it. */
const TRACK_END = 24;
/** The far edge fades out over this many px (the `.field` mask in LiveRiver.module.css); no label starts inside it. */
const FADE_W = 56;
const FUTURE_SKEW_MS = 60_000; // a server clock slightly ahead must not drop the newest trade

export type RiverKind = "launch" | "buy" | "sell";
/** Where a label sits: beyond its mark (above a buy, below a sell, either side of the line for a launch) or to its left. */
export type RiverPlace = "above" | "below" | "left";
/** A feed item plus when this client first saw it. `fresh` marks arrivals after the first paint (they ping). */
export type RiverEntry = { item: FeedItem; seenAt: number; fresh: boolean };
export type RiverMark = {
  key: string;
  item: FeedItem;
  kind: RiverKind;
  at: number;
  /** Age at the moment this client first drew it; fixes the mark's CSS animation offset for its whole life. */
  ageAtSeen: number;
  fresh: boolean;
  /** Vertical centre as a fraction of the field height. 0.5 is the line: buys above, sells below, launches on it. */
  y: number;
  /** Radius in px in the wide field. */
  r: number;
  /** Stacked marks fan out to the left by this many px so a burst never hides behind its first trade. */
  nudge: number;
  /** Whether the mark shows the token's image (launches, and trades of LOGO_MIN_R and up) or is a plain dot. */
  logo: boolean;
  /** "$54" for a priced trade, the symbol for a launch, null for an unpriced trade. */
  label: string | null;
  place: RiverPlace;
  /** Whether the label shows at rest in each field size. */
  showLabel: { wide: boolean; compact: boolean };
};

/** One identity per feed event, shared by the river and its list view. */
export function feedKey(item: FeedItem): string {
  return `${item.chain}:${item.kind}:${item.tx_hash}:${item.token}${item.kind === "swap" ? `:${item.log_index}` : ""}`;
}

function atMs(item: FeedItem): number {
  return new Date(item.at).getTime();
}

/** Inside the window (the river's half hour by default; the bubble map keeps a longer one). */
export function inRiverWindow(item: FeedItem, now: number, windowMs: number = RIVER_WINDOW_MS): boolean {
  const age = now - atMs(item);
  return Number.isFinite(age) && age >= -FUTURE_SKEW_MS && age <= windowMs;
}

function ordered(entries: RiverEntry[]): RiverEntry[] {
  return entries.sort((a, b) => atMs(b.item) - atMs(a.item) || feedKey(a.item).localeCompare(feedKey(b.item))).slice(0, RIVER_MAX_ITEMS);
}

/** First paint: everything already in the window, none of it fresh. */
export function initialRiver(items: readonly FeedItem[], now: number, windowMs: number = RIVER_WINDOW_MS): RiverEntry[] {
  const byKey = new Map<string, RiverEntry>();
  for (const item of items) if (inRiverWindow(item, now, windowMs)) byKey.set(feedKey(item), { item, seenAt: now, fresh: false });
  return ordered([...byKey.values()]);
}

/**
 * Fold a poll into the river. Known events keep when they were first seen (so they never jump) but take the
 * newer payload (a price that arrived late); unknown ones are fresh. Anything older than the window drops out.
 */
export function mergeRiver(current: readonly RiverEntry[], incoming: readonly FeedItem[], now: number, windowMs: number = RIVER_WINDOW_MS): RiverEntry[] {
  const byKey = new Map<string, RiverEntry>();
  for (const entry of current) if (inRiverWindow(entry.item, now, windowMs)) byKey.set(feedKey(entry.item), entry);
  for (const item of incoming) {
    if (!inRiverWindow(item, now, windowMs)) continue;
    const key = feedKey(item);
    const known = byKey.get(key);
    byKey.set(key, known ? { ...known, item } : { item, seenAt: now, fresh: true });
  }
  return ordered([...byKey.values()]);
}

/** Drop marks that have left the window. Returns the same array when nothing changed. */
export function pruneRiver(current: RiverEntry[], now: number, windowMs: number = RIVER_WINDOW_MS): RiverEntry[] {
  const kept = current.filter((entry) => inRiverWindow(entry.item, now, windowMs));
  return kept.length === current.length ? current : kept;
}

/** Dollar labels sized for a small pill: "$5.20", "$54", "$1.2K". */
export function riverUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 9.995) return `$${v.toFixed(2)}`;
  if (v < 999.5) return `$${Math.round(v)}`;
  // compact by hand: Intl's compact notation prints "$1.0K" or "$1K" depending on the runtime's ICU version
  for (const [size, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (v < size * 0.9995 && size !== 1e3) continue;
    const x = Math.round((v / size) * 10) / 10;
    return `$${Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1)}${suffix}`;
  }
  return `$${Math.round(v)}`;
}

/**
 * The seed is the newest `limit` events. When it came back full and its oldest event is still inside the window,
 * older events in the window were cut off: until the window moves past that event, the river holds the latest
 * events, not all of them. Returns the time from which coverage is complete, or null when it already is.
 */
export function riverCoverage(seed: readonly FeedItem[], limit: number, now: number): number | null {
  if (seed.length < limit) return null;
  const oldest = Math.min(...seed.map(atMs));
  return Number.isFinite(oldest) && now - oldest < RIVER_WINDOW_MS ? oldest : null;
}

/** "18 trades and 2 launches in the last 30 minutes", or "Latest 100 trades" while the seed was cut off. */
export function riverSummary(entries: readonly RiverEntry[], complete = true): string {
  const launches = entries.filter((entry) => entry.item.kind === "launch").length;
  const trades = entries.length - launches;
  const part = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  if (!launches && !trades) return "Nothing in the last 30 minutes";
  const parts = [trades ? part(trades, "trade", "trades") : null, launches ? part(launches, "launch", "launches") : null].filter(Boolean);
  return complete ? `${parts.join(" and ")} in the last 30 minutes` : `Latest ${parts.join(" and ")}`;
}

/** Dollars bought and sold across the trades held. A trade with no dollar price is counted, never guessed. */
export function riverFlow(entries: readonly RiverEntry[]): { bought: number; sold: number; unpriced: number } {
  let bought = 0;
  let sold = 0;
  let unpriced = 0;
  for (const { item } of entries) {
    if (item.kind !== "swap") continue;
    if (item.usd === null || !Number.isFinite(item.usd)) unpriced += 1;
    else if (item.is_buy) bought += item.usd;
    else sold += item.usd;
  }
  return { bought, sold, unpriced };
}

function kindOf(item: FeedItem): RiverKind {
  return item.kind === "launch" ? "launch" : item.is_buy ? "buy" : "sell";
}

/** log10 of the dollar size, clamped: $1 → 0.3, $100 → 2, $10K and up → 4. An unpriced trade draws as a small one. */
function magnitude(item: FeedItem): number {
  if (item.kind !== "swap") return 0;
  if (item.usd === null || !Number.isFinite(item.usd)) return 1;
  return Math.min(4, Math.max(0, Math.log10(1 + Math.max(0, item.usd))));
}

function hashSide(token: string): "above" | "below" {
  let h = 0;
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) | 0;
  return (h & 1) === 0 ? "above" : "below";
}

type Rect = { left: number; right: number; top: number; bottom: number };
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Lay out every mark. `width` is the time track's width in px for each size (measured on the client, estimated on
 * the server); it only affects which labels fit, since relative x between two marks is width × Δt / window.
 */
export function layoutRiver(entries: readonly RiverEntry[], width: { wide: number; compact: number }): RiverMark[] {
  const H = RIVER_HEIGHT.wide;
  const mid = H / 2;
  // stack bursts per lane, oldest first, so a mark's place never depends on what arrives after it
  const lanes = new Map<RiverKind, { at: number; j: number }>();
  const stack = new Map<string, number>();
  for (const entry of [...entries].sort((a, b) => atMs(a.item) - atMs(b.item))) {
    const kind = kindOf(entry.item);
    const at = atMs(entry.item);
    const prev = lanes.get(kind);
    const j = prev && at - prev.at < CLUSTER_MS ? (prev.j + 1) % (MAX_STACK + 1) : 0;
    lanes.set(kind, { at, j });
    stack.set(feedKey(entry.item), j);
  }

  const marks: RiverMark[] = entries.map((entry) => {
    const { item } = entry;
    const key = feedKey(item);
    const kind = kindOf(item);
    const at = atMs(item);
    const j = stack.get(key) ?? 0;
    const ageAtSeen = Math.max(0, entry.seenAt - at);
    if (kind === "launch") {
      return { key, item, kind, at, ageAtSeen, fresh: entry.fresh, y: 0.5, r: LAUNCH_R, nudge: j * 8, logo: true, label: item.symbol, place: hashSide(item.token), showLabel: { wide: false, compact: false } };
    }
    const mag = magnitude(item);
    const r = 4 + mag * 3.6;
    // the stem's length follows the dollars too, so a whale stands tall even when its dot is half hidden
    const off = Math.min(mid - r - RING.logo, Math.max(r + 8, 20 + mag * 18 + j * 10));
    const usd = item.kind === "swap" ? item.usd : null;
    return {
      key, item, kind, at, ageAtSeen, fresh: entry.fresh,
      y: (kind === "buy" ? mid - off : mid + off) / H,
      r, nudge: j * 7,
      logo: r >= LOGO_MIN_R,
      label: usd !== null && Number.isFinite(usd) ? riverUsd(usd) : null,
      place: kind === "buy" ? "above" : "below",
      showLabel: { wide: false, compact: false },
    };
  });

  // labels: launches first (newest first), then trades by size. One shows only where it stays inside the field and
  // clear of the line, of every other mark and of every label already shown. A phone keeps the wide placement or drops it.
  const newest = marks.reduce((max, m) => Math.max(max, m.at), 0);
  const priority = [...marks].sort((a, b) =>
    (a.kind === "launch" ? 0 : 1) - (b.kind === "launch" ? 0 : 1) ||
    (a.kind === "launch" ? b.at - a.at : usdOf(b) - usdOf(a) || b.at - a.at));
  for (const size of ["wide", "compact"] as const) {
    const W = width[size];
    const scale = size === "compact" ? COMPACT_SCALE : 1;
    const h = RIVER_HEIGHT[size];
    const xOf = (m: RiverMark) => W * (1 - (newest - m.at) / RIVER_WINDOW_MS) - m.nudge;
    const bodies = marks.map((m) => {
      const x = xOf(m);
      const y = m.y * h;
      const r = m.r * scale + (m.logo ? RING.logo : RING.dot);
      return { key: m.key, rect: { left: x - r, right: x + r, top: y - r, bottom: y + r } };
    });
    const line: Rect = { left: 0, right: W + TRACK_END, top: h / 2 - 1, bottom: h / 2 + 1 };
    const placed: Rect[] = [];
    for (const m of priority) {
      if (placed.length >= LABEL_MAX[size]) break;
      if (!m.label) continue;
      if (m.kind !== "launch" && usdOf(m) < LABEL_MIN_USD[size]) continue;
      if (m.kind === "launch" && size === "compact") continue; // a phone shows the mark and the lock; the name is one tap away
      if (size === "compact" && !m.showLabel.wide) continue;
      const x = xOf(m);
      const y = m.y * h;
      const r = m.r * scale + (m.logo ? RING.logo : RING.dot);
      const w = m.label.length * (m.kind === "launch" ? NAME_CHAR_W : CHAR_W) + LABEL_PAD;
      const rect = (place: RiverPlace): Rect =>
        place === "above" ? { left: x - w / 2, right: x + w / 2, top: y - r - LABEL_GAP - LABEL_H, bottom: y - r - LABEL_GAP }
        : place === "below" ? { left: x - w / 2, right: x + w / 2, top: y + r + LABEL_GAP, bottom: y + r + LABEL_GAP + LABEL_H }
        // to the left of the mark, pointing back in time, so the newest one is never cut off
        : { left: x - r - LABEL_GAP - w, right: x - r - LABEL_GAP, top: y - LABEL_H / 2, bottom: y + LABEL_H / 2 };
      const order: RiverPlace[] = size === "compact" ? [m.place]
        : m.kind === "launch" ? [m.place, m.place === "above" ? "below" : "above"]
        : [m.place, "left"];
      const fit = order.map((place) => ({ place, at: rect(place) })).find(({ at }) =>
        at.left >= FADE_W && at.right <= W + TRACK_END && at.top >= 0 && at.bottom <= h &&
        (m.kind === "launch" || !overlaps(line, at)) &&
        !placed.some((p) => overlaps(p, at)) &&
        !bodies.some((b) => b.key !== m.key && overlaps(b.rect, at)));
      if (!fit) continue;
      placed.push(fit.at);
      m.showLabel[size] = true;
      if (size === "wide") m.place = fit.place;
    }
  }
  return marks;
}

function usdOf(m: RiverMark): number {
  return m.item.kind === "swap" && m.item.usd !== null && Number.isFinite(m.item.usd) ? m.item.usd : 0;
}
