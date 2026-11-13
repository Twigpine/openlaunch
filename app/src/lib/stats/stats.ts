import { isChainKey, type ChainKey } from "../chainKeys.ts";

/**
 * Pure helpers for the public protocol stats. No DB, no Next.js: `stats.test.ts`
 * loads this directly, and the server module and the page share the same
 * window parsing, day buckets and CSV so the API and the page cannot drift.
 *
 * Every USD figure here is trade-time USD: the value stored on each swap or fee
 * event from the quote's price in that event's own UTC hour. An event with no
 * price for its hour is excluded and counted (`unpriced_*`), never valued at
 * today's price. That is the honest figure for a chart; the home page totals
 * additionally fall back to the current price for those events.
 */

export const STATS_WINDOWS = ["7d", "30d", "90d", "all"] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];
export const DEFAULT_STATS_WINDOW: StatsWindow = "30d";

export type StatsFormat = "json" | "csv";

export function parseStatsWindow(raw: unknown, fallback: StatsWindow = DEFAULT_STATS_WINDOW): StatsWindow {
  return typeof raw === "string" && (STATS_WINDOWS as readonly string[]).includes(raw) ? (raw as StatsWindow) : fallback;
}

export function parseStatsChain(raw: unknown): ChainKey | null {
  return isChainKey(raw) ? raw : null;
}

export function parseStatsFormat(raw: unknown): StatsFormat {
  return raw === "csv" ? "csv" : "json";
}

const DAY_MS = 86_400_000;

/** The UTC day of a timestamp, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Midnight UTC of `day`, as a `YYYY-MM-DD` string that is safe to parse. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * First day in the window, or null for `all` (the first day with any data).
 * Windows include today: `7d` is today and the six days before it.
 */
export function windowStartDay(window: StatsWindow, now = Date.now()): string | null {
  if (window === "all") return null;
  const days = window === "7d" ? 7 : window === "30d" ? 30 : 90;
  return utcDay(dayStart(utcDay(now)) - (days - 1) * DAY_MS);
}

/** Inclusive list of UTC days. Bounded so a corrupt timestamp cannot allocate forever. */
export function dayRange(fromDay: string, toDay: string): string[] {
  const from = dayStart(fromDay);
  const to = dayStart(toDay);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  const days: string[] = [];
  for (let t = from; t <= to && days.length < 3_660; t += DAY_MS) days.push(utcDay(t));
  return days;
}

export type StatsDay = {
  day: string;
  launches: number;
  launchers: number;
  trades: number;
  traders: number;
  volume_usd: number;
  fees_collected_usd: number;
  fees_burned_usd: number;
  unpriced_trades: number;
  unpriced_fee_events: number;
};

export type StatsTotals = Omit<StatsDay, "day"> & {
  fees_to_creators_usd: number;
  /** True when at least one trade or quote-side fee has no trade-time USD and is left out of the USD sums. */
  usd_partial: boolean;
};

export type StatsChain = StatsTotals & { chain: ChainKey };

export type StatsTopLaunch = {
  chain: ChainKey;
  token: string;
  name: string;
  symbol: string;
  trades: number;
  volume_usd: number;
  holders: number;
  launched_at: string;
};

export type ProtocolStats = {
  window: StatsWindow;
  chain: ChainKey | null;
  /** False when DATABASE_URL is unset or the aggregate read failed; the shapes are then empty, not zero facts. */
  available: boolean;
  since: string | null;
  until: string;
  generated_at: string;
  totals: StatsTotals;
  by_chain: StatsChain[];
  series: StatsDay[];
  top: StatsTopLaunch[];
};

export function emptyStatsDay(day: string): StatsDay {
  return {
    day,
    launches: 0,
    launchers: 0,
    trades: 0,
    traders: 0,
    volume_usd: 0,
    fees_collected_usd: 0,
    fees_burned_usd: 0,
    unpriced_trades: 0,
    unpriced_fee_events: 0,
  };
}

/**
 * Fill a day-by-day series from `fromDay` through `toDay`, leaving gaps at zero.
 * With `fromDay=null` (the `all` window) the series starts at its first row;
 * an empty series stays empty. Rows outside the range are ignored.
 */
export function fillStatsSeries(rows: readonly StatsDay[], fromDay: string | null, toDay: string): StatsDay[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const first = fromDay ?? rows.reduce<string | null>((min, row) => (min === null || row.day < min ? row.day : min), null);
  if (first === null || first > toDay) return [];
  return dayRange(first, toDay).map((day) => byDay.get(day) ?? emptyStatsDay(day));
}

/** A totals row from a global aggregate; the caller supplies the distinct-wallet counts. */
export function statsTotals(input: Omit<StatsTotals, "fees_to_creators_usd" | "usd_partial">): StatsTotals {
  return {
    ...input,
    fees_to_creators_usd: input.fees_collected_usd - input.fees_burned_usd,
    usd_partial: input.unpriced_trades > 0 || input.unpriced_fee_events > 0,
  };
}

/** The CSV served by `/api/stats?format=csv`: one row per UTC day. */
export function statsCsv(stats: ProtocolStats): string {
  const header = "chain,day,launches,launchers,trades,traders,volume_usd,fees_collected_usd,fees_burned_usd,unpriced_trades,unpriced_fee_events";
  const chain = stats.chain ?? "all";
  const rows = stats.series.map((d) => [chain, d.day, d.launches, d.launchers, d.trades, d.traders, d.volume_usd, d.fees_collected_usd, d.fees_burned_usd, d.unpriced_trades, d.unpriced_fee_events].join(","));
  return `${[header, ...rows].join("\n")}\n`;
}

/** `/stats` with only the parameters that differ from the default. */
export function statsHref(window: StatsWindow, chain: ChainKey | null): string {
  const params = new URLSearchParams();
  if (window !== DEFAULT_STATS_WINDOW) params.set("window", window);
  if (chain) params.set("chain", chain);
  const query = params.toString();
  return query ? `/stats?${query}` : "/stats";
}
