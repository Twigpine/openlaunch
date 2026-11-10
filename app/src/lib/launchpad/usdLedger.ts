import "server-only";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { errMessage, type Db } from "@/lib/db";
import { ethUsd } from "./ethPrice";
import { quoteUsdNow } from "./queries";
import { captureDue, hourIso } from "./usd-history";

/**
 * Live capture for trade-time USD (usd-history.ts states the rule). Before the indexer applies a range, it writes the
 * live USD price of every quote in use on the chain into the current UTC hour's row of bb_quote_usd_hourly (source
 * 'live'), so a trade indexed seconds after it happened is priced at that spot. The row keeps updating until the hour
 * ends; after that it is frozen, and it is never replaced by a historical close (the backfill fills only hours that have
 * no row). Prices come from the same sources the lists use (queries.quoteUsdNow). A quote with no price right now is not
 * written: its trades keep usd NULL until scripts/usd-backfill.ts fills that hour. Display only, like every USD figure.
 */
export const LIVE_CAPTURE_EVERY_MS = 60_000;
const lastCapture = new Map<ChainKey, number>();

/** Test-only: forget when each chain was last captured. */
export function resetLiveCapture(): void {
  lastCapture.clear();
}

/**
 * Capture at most once a minute per chain, and always on the first run of a new hour (so a trade in its first seconds
 * finds its hour's row). Never throws: a failed capture only leaves that minute's trades for the backfill.
 */
export async function captureLiveUsd(db: Db, chain: ChainKey, quotes: Iterable<string>, now = Date.now()): Promise<number> {
  const last = lastCapture.get(chain);
  if (!captureDue(last, now, LIVE_CAPTURE_EVERY_MS)) return 0;
  lastCapture.set(chain, now);
  try {
    const wanted = [...new Set([...quotes].map((q) => q.toLowerCase()))];
    if (wanted.length === 0) return 0;
    const price = await quoteUsdNow(await ethUsd());
    const rows = wanted.flatMap((quote) => {
      const p = price(chain, quote);
      return p.usd !== null && Number.isFinite(p.usd) && p.usd > 0 && p.decimalsKnown ? [{ quote, usd: p.usd, decimals: p.decimals }] : [];
    });
    if (rows.length === 0) return 0;
    await db`
      INSERT INTO bb_quote_usd_hourly (chain_id, quote, hour, usd, decimals, source)
      SELECT ${chainIdOf(chain)}, u.q, ${hourIso(now)}::timestamptz, u.usd, u.dec, 'live'
        FROM unnest(${rows.map((r) => r.quote)}::text[], ${rows.map((r) => r.usd)}::float8[], ${rows.map((r) => r.decimals)}::int[]) AS u(q, usd, dec)
      ON CONFLICT (chain_id, quote, hour) DO UPDATE SET usd = EXCLUDED.usd, decimals = EXCLUDED.decimals, updated_at = now()
       WHERE bb_quote_usd_hourly.source = 'live'`;
    return rows.length;
  } catch (err) {
    // retry on the next run instead of waiting out the minute
    if (last === undefined) lastCapture.delete(chain);
    else lastCapture.set(chain, last);
    console.warn(`[usd] live price capture failed on ${chain}: ${errMessage(err)}`);
    return 0;
  }
}
