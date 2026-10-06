/**
 * Ranking engine: what the home page shows first, and what "hot" means. Pure, node --test loads it directly.
 *
 * One rule, stated once:
 *   A token is LIVE when an outside wallet has traded it in the last LIVE_WINDOW_HOURS: not the launcher, and not a
 *   swap inside the sniper window (launch block + SNIPER_BLOCKS, see holders.ts; a sell there can only be a sniper's).
 *   Until then it is NEW for its first GRACE_HOURS, then QUIET. Outside live, a launcher gets one row: the grace hour
 *   goes to a wallet's newest launch, so one wallet cannot fill the board by launching in a loop.
 *
 * The list query (queries.ts, sort "live") applies the rule in SQL because ordering and paging happen in the
 * database, and sends the tier back with each row so the client shows the tier it was ranked by. Live rows rank by
 * outside wallets this hour, then today, then the last outside trade; the other tiers by age. The helpers here
 * render the per-row chip and rank the trending strip. Facts only: no token can buy its way in with one wallet
 * ping-ponging, and a creator trading their own token never counts as a buyer.
 */

import { ago } from "./time";

export const GRACE_HOURS = 1;
export const LIVE_WINDOW_HOURS = 24;

export type LiveTier = "live" | "new" | "quiet";

/** The row fields the rule reads. `*_ex` counts are distinct outside wallets (launcher and sniper-window swaps excluded). */
export type RankRow = {
  block_time: string;
  /** Last swap by an outside wallet in the day window; `last_trade_at` also moves on the launcher's own swaps. */
  last_outside_trade_at: string | null;
  traders_1h_ex: number;
  traders_24h_ex: number;
  /** The tier the database ranked the row in (live sort only); the rule below is the fallback. */
  live_tier?: LiveTier | null;
  /** Rows of the same launcher folded into this one on the live sort (0 when none, or on other sorts). */
  launcher_collapsed?: number;
};

export function liveTier(r: RankRow, nowMs: number): LiveTier {
  if (r.live_tier) return r.live_tier;
  if (r.traders_24h_ex >= 1) return "live";
  const ageMs = nowMs - new Date(r.block_time).getTime();
  return ageMs < GRACE_HOURS * 3_600_000 ? "new" : "quiet";
}

/**
 * The chip's pieces, for surfaces that set the count apart from its words (the market cards):
 * live { count: 3, label: "wallets this hour", when: "12m ago" }, new { label: "just launched", when: "4m" },
 * quiet { label: "no buyers yet" }. `more` notes launches folded into this row.
 */
export type ChipParts = { tier: LiveTier; count: number | null; label: string; when: string | null; more: string | null };

export function liveChipParts(r: RankRow, nowMs: number): ChipParts {
  const tier = liveTier(r, nowMs);
  const more = r.launcher_collapsed ? `+${r.launcher_collapsed} from this wallet` : null;
  if (tier === "live") {
    const hour = r.traders_1h_ex > 0;
    const count = hour ? r.traders_1h_ex : r.traders_24h_ex;
    return { tier, count, label: `${count === 1 ? "wallet" : "wallets"} ${hour ? "this hour" : "today"}`, when: r.last_outside_trade_at ? `${ago(r.last_outside_trade_at, nowMs)} ago` : null, more: null };
  }
  if (tier === "new") return { tier, count: null, label: "just launched", when: ago(r.block_time, nowMs), more };
  return { tier, count: null, label: "no buyers yet", when: null, more };
}

/** Why a row sits where it sits on the live sort: "3 wallets this hour · 12m ago", "just launched · 4m", "no buyers yet · +4 from this wallet". */
export function liveChip(r: RankRow, nowMs: number): { tier: LiveTier; text: string } {
  const p = liveChipParts(r, nowMs);
  const text = [p.count === null ? p.label : `${p.count} ${p.label}`, p.when, p.more].filter(Boolean).join(" · ");
  return { tier: p.tier, text };
}

/* ────────────────────────────── trending strip ────────────────────────────── */

export type TrendRow = RankRow & {
  token: string;
  chain: string;
  trades_1h: number;
  volume_1h_usd: number | null;
  trades_24h: number;
  volume_24h_usd: number | null;
  holders: number;
};

export const STRIP_SIZE = 5; // king (2 columns) + 4 on desktop = one 6-column row
export const MIN_TRADES_1H = 3;
export const MIN_TRADERS_1H = 2; // distinct wallets other than the launcher
export const MIN_STRIP = 3; // fewer eligible than this → fall back to the 24h window
export const FRESH_HOURS = 6;
export const KING_HOLD_POLLS = 2; // a challenger must lead this many consecutive polls to take the top card

/** Distinct outside wallets count most; trades and dollar volume are log-scaled so one bot loop or one whale can't dominate; holders break ties. */
export function trendingScore(r: TrendRow, nowMs: number, window: "1h" | "24h" = "1h"): number {
  const traders = window === "1h" ? r.traders_1h_ex : r.traders_24h_ex;
  const trades = window === "1h" ? r.trades_1h : r.trades_24h;
  const vol = (window === "1h" ? r.volume_1h_usd : r.volume_24h_usd) ?? 0;
  const ageH = Math.max(0, (nowMs - new Date(r.block_time).getTime()) / 3_600_000);
  const fresh = ageH < FRESH_HOURS ? 1 + (FRESH_HOURS - ageH) / FRESH_HOURS / 2 : 1; // up to 1.5× at launch, 1× after 6h
  return (traders * 10 + Math.log10(1 + trades) * 6 + Math.log10(1 + vol) * 8 + Math.log10(1 + r.holders) * 3) * fresh;
}

/** Eligibility gate for the hour window: enough trades from enough distinct outside wallets. */
export function eligible1h(r: TrendRow): boolean {
  return r.trades_1h >= MIN_TRADES_1H && r.traders_1h_ex >= MIN_TRADERS_1H;
}

/** Day window: enough trades and at least one outside wallet (a creator trading alone is never trending). */
export function eligible24h(r: TrendRow): boolean {
  return r.trades_24h >= MIN_TRADES_1H && r.traders_24h_ex >= 1;
}

export type Trending = { window: "1h" | "24h"; items: TrendRow[] };

/** Rank for the strip: 1h window when enough tokens qualify, else the 24h window (or nothing). */
export function rankTrending<T extends TrendRow>(rows: T[], nowMs: number, limit = STRIP_SIZE): { window: "1h" | "24h"; items: T[] } {
  const hour = rows.filter(eligible1h);
  if (hour.length >= MIN_STRIP) return { window: "1h", items: [...hour].sort((a, b) => trendingScore(b, nowMs) - trendingScore(a, nowMs)).slice(0, limit) };
  const day = rows.filter(eligible24h);
  if (day.length === 0) return { window: "24h", items: [] };
  return { window: "24h", items: [...day].sort((a, b) => trendingScore(b, nowMs, "24h") - trendingScore(a, nowMs, "24h")).slice(0, limit) };
}

/**
 * Sticky top card: the incumbent keeps the spot until a challenger has led `hold` consecutive polls.
 * Returns the token that should be shown as king plus the updated challenger streak.
 */
export function stickyKing(incumbent: string | null, leader: string | null, streak: { token: string | null; n: number }, hold = KING_HOLD_POLLS): { king: string | null; streak: { token: string | null; n: number } } {
  if (!leader) return { king: null, streak: { token: null, n: 0 } };
  if (!incumbent || incumbent === leader) return { king: leader, streak: { token: null, n: 0 } };
  const n = streak.token === leader ? streak.n + 1 : 1;
  if (n >= hold) return { king: leader, streak: { token: null, n: 0 } };
  return { king: incumbent, streak: { token: leader, n } };
}

/** Order the strip so the king is first while the rest keep score order. */
export function orderWithKing<T extends { token: string }>(items: T[], king: string | null): T[] {
  if (!king) return items;
  const k = items.find((i) => i.token === king);
  return k ? [k, ...items.filter((i) => i.token !== king)] : items;
}
