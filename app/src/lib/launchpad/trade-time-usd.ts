/**
 * Reading trade-time USD (pure; node --test loads it). Every trade and quote-side fee carries its USD value at its own
 * hour (bb_launch_swaps.usd, bb_launch_fee_events.usd; usd-history.ts), summed per launch in bb_launches.volume_usd,
 * fees_collected_usd and fees_burned_usd. A row with no stored value is one whose quote has no price history (registry
 * stocks, community pairs and unlisted tokens traded before 2026-11-10, when the live capture started): it counts at
 * the quote's price now, the old method, so the totals stay complete. The site says so where the figures are shown.
 */
import { units } from "./math.ts";

/** Swaps with no stored USD value, summed per launch in raw quote units (the partial index bb_launch_swaps_usd_missing_idx keeps it small). */
export const UNPRICED_SWAPS_SQL = `SELECT chain_id, token, sum(abs(amount0)) AS uq FROM bb_launch_swaps WHERE usd IS NULL GROUP BY chain_id, token`;

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

/** Whether a total undercounts right now: a part with no stored value whose quote normally has a price but has none at the moment. */
export function missingNow(unpricedRaw: string | bigint | null | undefined, quoteUsdNow: number | null, priced: boolean): boolean {
  if (unpricedRaw === null || unpricedRaw === undefined) return false;
  return quoteUsdNow === null && priced && BigInt(unpricedRaw) > 0n;
}
