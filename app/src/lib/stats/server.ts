import "server-only";
import { CHAIN_KEYS, chainIdOf, chainKeyOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { memo } from "@/lib/launchpad/memo";
import {
  DEFAULT_STATS_WINDOW,
  emptyStatsDay,
  fillStatsSeries,
  statsTotals,
  utcDay,
  windowStartDay,
  type ProtocolStats,
  type StatsChain,
  type StatsDay,
  type StatsTopLaunch,
  type StatsTotals,
  type StatsWindow,
} from "./stats.ts";

type LaunchAgg = { chain_id: number | null; launches: number; launchers: number };
type SwapAgg = { chain_id: number | null; trades: number; traders: number; unpriced_trades: number; volume_usd: number };
type FeeAgg = { chain_id: number | null; collected_usd: number; burned_usd: number; unpriced_fee_events: number };

type LaunchDay = { day: string; launches: number; launchers: number };
type SwapDay = { day: string; trades: number; traders: number; unpriced_trades: number; volume_usd: number };
type FeeDay = { day: string; fees_collected_usd: number; fees_burned_usd: number; unpriced_fee_events: number };

type TopRaw = {
  chain_id: number;
  token: string;
  name: string;
  symbol: string;
  trades: number;
  volume_usd: number;
  holders: number;
  block_time: string;
};

function zeroTotals(): StatsTotals {
  return statsTotals({
    launches: 0,
    launchers: 0,
    trades: 0,
    traders: 0,
    volume_usd: 0,
    fees_collected_usd: 0,
    fees_burned_usd: 0,
    unpriced_trades: 0,
    unpriced_fee_events: 0,
  });
}

function emptyStats(window: StatsWindow, chain: ChainKey | null, now: number, available: boolean): ProtocolStats {
  const chains = chain ? [chain] : CHAIN_KEYS;
  return {
    window,
    chain,
    available,
    since: windowStartDay(window, now),
    until: utcDay(now),
    generated_at: new Date(now).toISOString(),
    totals: zeroTotals(),
    by_chain: chains.map((c): StatsChain => ({ chain: c, ...zeroTotals() })),
    series: [],
    top: [],
  };
}

function findAgg<T extends { chain_id: number | null }>(rows: readonly T[], chain: ChainKey | null): T | undefined {
  const id = chain ? chainIdOf(chain) : null;
  return rows.find((row) => row.chain_id === id);
}

function chainAgg<T extends { chain_id: number | null }>(rows: readonly T[], chain: ChainKey): T | undefined {
  return rows.find((row) => row.chain_id === chainIdOf(chain));
}

function topLaunch(row: TopRaw): StatsTopLaunch | null {
  const chain = chainKeyOf(row.chain_id);
  if (!chain) return null;
  return {
    chain,
    token: String(row.token).toLowerCase(),
    name: String(row.name),
    symbol: String(row.symbol),
    trades: Number(row.trades),
    volume_usd: Number(row.volume_usd) || 0,
    holders: Number(row.holders) || 0,
    launched_at: row.block_time,
  };
}

/**
 * Protocol aggregates for the stats page and `/api/stats`.
 *
 * Three aggregate reads (launches, swaps, fees) each include the per-chain rows
 * and the global row in one `GROUPING SETS` pass, plus one daily series per
 * table and one top-launches read. Every USD sum is the stored trade-time value;
 * rows with no price for their hour are counted, never back-filled at today's
 * price. A read failure returns `available: false` with empty shapes instead of
 * taking the page down.
 */
export async function getProtocolStats(opts: { window?: StatsWindow; chain?: ChainKey | null; now?: number } = {}): Promise<ProtocolStats> {
  const window = opts.window ?? DEFAULT_STATS_WINDOW;
  const chain = opts.chain ?? null;
  const now = opts.now ?? Date.now();
  const db = maybeDb();
  if (!db) return emptyStats(window, chain, now, false);

  const startDay = windowStartDay(window, now);
  const since = startDay ? `${startDay}T00:00:00.000Z` : null;
  const until = utcDay(now);
  const launchWindow = since ? db`AND block_time >= ${since}::timestamptz` : db``;
  const swapWindow = since ? db`AND block_time >= ${since}::timestamptz` : db``;
  const feeWindow = since ? db`AND f.block_time >= ${since}::timestamptz` : db``;
  const launchChain = chain ? db`AND chain_id = ${chainIdOf(chain)}` : db``;
  const swapChain = chain ? db`AND chain_id = ${chainIdOf(chain)}` : db``;
  const feeChain = chain ? db`AND f.chain_id = ${chainIdOf(chain)}` : db``;

  try {
    const [launchAgg, swapAgg, feeAgg, launchDays, swapDays, feeDays, topRaw] = await Promise.all([
      db<LaunchAgg[]>`
        SELECT chain_id, count(*)::int AS launches, count(DISTINCT launcher)::int AS launchers
          FROM bb_launches
         WHERE true ${launchChain} ${launchWindow}
         GROUP BY GROUPING SETS ((chain_id), ())`,
      db<SwapAgg[]>`
        SELECT chain_id, count(*)::int AS trades, count(DISTINCT trader)::int AS traders,
               count(*) FILTER (WHERE usd IS NULL)::int AS unpriced_trades,
               coalesce(sum(usd), 0)::float8 AS volume_usd
          FROM bb_launch_swaps
         WHERE true ${swapChain} ${swapWindow}
         GROUP BY GROUPING SETS ((chain_id), ())`,
      db<FeeAgg[]>`
        SELECT f.chain_id,
               coalesce(sum(f.usd) FILTER (WHERE f.kind = 'collected'), 0)::float8 AS collected_usd,
               coalesce(sum(f.usd) FILTER (WHERE f.kind = 'burned'), 0)::float8 AS burned_usd,
               count(*) FILTER (WHERE f.usd IS NULL AND (f.kind = 'collected' OR (f.kind = 'burned' AND f.currency = l.quote)))::int AS unpriced_fee_events
          FROM bb_launch_fee_events f
          LEFT JOIN bb_launches l ON l.chain_id = f.chain_id AND l.token = f.token
         WHERE f.kind IN ('collected', 'burned') ${feeChain} ${feeWindow}
         GROUP BY GROUPING SETS ((f.chain_id), ())`,
      db<LaunchDay[]>`
        SELECT to_char(date_trunc('day', block_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               count(*)::int AS launches, count(DISTINCT launcher)::int AS launchers
          FROM bb_launches
         WHERE true ${launchChain} ${launchWindow}
         GROUP BY 1 ORDER BY 1`,
      db<SwapDay[]>`
        SELECT to_char(date_trunc('day', block_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               count(*)::int AS trades, count(DISTINCT trader)::int AS traders,
               count(*) FILTER (WHERE usd IS NULL)::int AS unpriced_trades,
               coalesce(sum(usd), 0)::float8 AS volume_usd
          FROM bb_launch_swaps
         WHERE true ${swapChain} ${swapWindow}
         GROUP BY 1 ORDER BY 1`,
      db<FeeDay[]>`
        SELECT to_char(date_trunc('day', f.block_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               coalesce(sum(f.usd) FILTER (WHERE f.kind = 'collected'), 0)::float8 AS fees_collected_usd,
               coalesce(sum(f.usd) FILTER (WHERE f.kind = 'burned'), 0)::float8 AS fees_burned_usd,
               count(*) FILTER (WHERE f.usd IS NULL AND (f.kind = 'collected' OR (f.kind = 'burned' AND f.currency = l.quote)))::int AS unpriced_fee_events
          FROM bb_launch_fee_events f
          LEFT JOIN bb_launches l ON l.chain_id = f.chain_id AND l.token = f.token
         WHERE f.kind IN ('collected', 'burned') ${feeChain} ${feeWindow}
         GROUP BY 1 ORDER BY 1`,
      since
        ? db<TopRaw[]>`
            SELECT s.chain_id, s.token, l.name, l.symbol, count(*)::int AS trades,
                   coalesce(sum(s.usd), 0)::float8 AS volume_usd, l.holders, l.block_time
              FROM bb_launch_swaps s
              JOIN bb_launches l ON l.chain_id = s.chain_id AND l.token = s.token
             WHERE s.block_time >= ${since}::timestamptz ${chain ? db`AND s.chain_id = ${chainIdOf(chain)}` : db``}
             GROUP BY s.chain_id, s.token, l.name, l.symbol, l.holders, l.block_time
             ORDER BY volume_usd DESC, trades DESC
             LIMIT 10`
        : db<TopRaw[]>`
            SELECT chain_id, token, name, symbol, (buys + sells)::int AS trades,
                   volume_usd::float8 AS volume_usd, holders, block_time
              FROM bb_launches
             WHERE true ${launchChain}
             ORDER BY volume_usd DESC, trades DESC
             LIMIT 10`,
    ]);

    const globalLaunch = findAgg(launchAgg, null);
    const globalSwap = findAgg(swapAgg, null);
    const globalFee = findAgg(feeAgg, null);
    const totals = statsTotals({
      launches: Number(globalLaunch?.launches ?? 0),
      launchers: Number(globalLaunch?.launchers ?? 0),
      trades: Number(globalSwap?.trades ?? 0),
      traders: Number(globalSwap?.traders ?? 0),
      volume_usd: Number(globalSwap?.volume_usd ?? 0),
      fees_collected_usd: Number(globalFee?.collected_usd ?? 0),
      fees_burned_usd: Number(globalFee?.burned_usd ?? 0),
      unpriced_trades: Number(globalSwap?.unpriced_trades ?? 0),
      unpriced_fee_events: Number(globalFee?.unpriced_fee_events ?? 0),
    });

    const chains = chain ? [chain] : CHAIN_KEYS;
    const by_chain = chains.map((c): StatsChain => {
      const l = chainAgg(launchAgg, c);
      const s = chainAgg(swapAgg, c);
      const f = chainAgg(feeAgg, c);
      return {
        chain: c,
        ...statsTotals({
          launches: Number(l?.launches ?? 0),
          launchers: Number(l?.launchers ?? 0),
          trades: Number(s?.trades ?? 0),
          traders: Number(s?.traders ?? 0),
          volume_usd: Number(s?.volume_usd ?? 0),
          fees_collected_usd: Number(f?.collected_usd ?? 0),
          fees_burned_usd: Number(f?.burned_usd ?? 0),
          unpriced_trades: Number(s?.unpriced_trades ?? 0),
          unpriced_fee_events: Number(f?.unpriced_fee_events ?? 0),
        }),
      };
    });

    const byDay = new Map<string, StatsDay>();
    const dayOf = (day: string): StatsDay => {
      const hit = byDay.get(day);
      if (hit) return hit;
      const fresh = emptyStatsDay(day);
      byDay.set(day, fresh);
      return fresh;
    };
    for (const row of launchDays) {
      const d = dayOf(row.day);
      d.launches = Number(row.launches);
      d.launchers = Number(row.launchers);
    }
    for (const row of swapDays) {
      const d = dayOf(row.day);
      d.trades = Number(row.trades);
      d.traders = Number(row.traders);
      d.volume_usd = Number(row.volume_usd);
      d.unpriced_trades = Number(row.unpriced_trades);
    }
    for (const row of feeDays) {
      const d = dayOf(row.day);
      d.fees_collected_usd = Number(row.fees_collected_usd);
      d.fees_burned_usd = Number(row.fees_burned_usd);
      d.unpriced_fee_events = Number(row.unpriced_fee_events);
    }
    const series = fillStatsSeries([...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)), startDay, until);
    const top = topRaw.map(topLaunch).filter((row): row is StatsTopLaunch => row !== null);

    return {
      window,
      chain,
      available: true,
      since: startDay ?? series[0]?.day ?? null,
      until,
      generated_at: new Date(now).toISOString(),
      totals,
      by_chain,
      series,
      top,
    };
  } catch (error) {
    console.warn("[stats] aggregate read failed:", error instanceof Error ? error.message : error);
    return emptyStats(window, chain, now, false);
  }
}

/** The page and the API share one 30 s memo per window/chain. */
export function getProtocolStatsCached(window: StatsWindow, chain: ChainKey | null): Promise<ProtocolStats> {
  return memo(`stats:${window}:${chain ?? "all"}`, 30_000, () => getProtocolStats({ window, chain }));
}
