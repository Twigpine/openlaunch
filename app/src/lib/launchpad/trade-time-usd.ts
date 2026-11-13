/**
 * Reading trade-time USD (pure; node --test loads it). Every trade and quote-side fee carries its USD value at its own
 * hour (bb_launch_swaps.usd, bb_launch_fee_events.usd; usd-history.ts), summed per launch in bb_launches.volume_usd,
 * fees_collected_usd and fees_burned_usd. A row with no stored value counts at the quote's price now, the old method, so
 * the totals stay complete: community pairs (never stored: an outside pool's price can be pushed for a minute, and a
 * suspended or delisted pair must show no USD at all, usdLedger.ts), registry stocks traded before 2026-11-10 (no
 * price history), and any hour the indexer could not price yet (its heal pass fills those). An unlisted token has no
 * price at all: its trades carry no USD value, as before. The site says so where the figures are shown.
 */
import { units } from "./math.ts";

/** Swaps with no stored USD value, summed per launch in raw quote units: the site totals' one grouped read (bb_launch_swaps_usd_missing_idx). */
export const UNPRICED_SWAPS_SQL = `SELECT chain_id, token, sum(abs(COALESCE(trader_amount0, amount0))) AS uq FROM bb_launch_swaps WHERE usd IS NULL GROUP BY chain_id, token`;
/**
 * The same, for one launch at a time (the lists' LATERAL join): a probe of bb_launch_swaps_usd_missing_token_idx per row,
 * so a list of 40 launches reads 40 tiny index ranges instead of aggregating every unpriced trade on every request.
 */
export const UNPRICED_LATERAL_SQL = `SELECT sum(abs(COALESCE(x.trader_amount0, x.amount0))) AS uq FROM bb_launch_swaps x WHERE x.chain_id = l.chain_id AND x.token = l.token AND x.usd IS NULL`;

/**
 * A USD total: the stored trade-time sum plus the raw quote amount with no stored value at `quoteUsdNow`.
 * null = nothing prices any of it (an unlisted quote, or a quote with no price right now and nothing stored).
 */
export function tradeTimeUsd(storedUsd: number | null | undefined, unpricedRaw: string | bigint | null | undefined, decimals: number, quoteUsdNow: number | null): number | null {
  const stored = typeof storedUsd === "number" && Number.isFinite(storedUsd) ? storedUsd : 0;
  const unpriced = unpricedRaw === null || unpricedRaw === undefined ? 0 : units(unpricedRaw, decimals);
  if (unpriced > 0) return quoteUsdNow !== null ? stored + unpriced * quoteUsdNow : stored > 0 ? stored : null;
  return stored > 0 || quoteUsdNow !== null ? stored : null;
}

/**
 * One launch's all-time USD for its row: as tradeTimeUsd, except that a part with no stored value and no price right now
 * makes the whole figure null, so the row shows its quote amount instead of a smaller dollar figure that looks complete.
 */
export function launchVolumeUsd(storedUsd: number | null | undefined, unpricedRaw: string | bigint | null | undefined, decimals: number, quoteUsdNow: number | null): number | null {
  if (quoteUsdNow === null && unpricedRaw !== null && unpricedRaw !== undefined && BigInt(unpricedRaw) > 0n) return null;
  return tradeTimeUsd(storedUsd, unpricedRaw, decimals, quoteUsdNow);
}

/** Whether a total undercounts right now: a part with no stored value whose quote normally has a price but has none at the moment. */
export function missingNow(unpricedRaw: string | bigint | null | undefined, quoteUsdNow: number | null, priced: boolean): boolean {
  if (unpricedRaw === null || unpricedRaw === undefined) return false;
  return quoteUsdNow === null && priced && BigInt(unpricedRaw) > 0n;
}
