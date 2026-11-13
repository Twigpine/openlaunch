import "server-only";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { errMessage, type Db } from "@/lib/db";
import { ethUsd } from "./ethPrice";
import { quoteUsdNow } from "./queries";
import { captureDue, hourIso, hourSql } from "./usd-history";

/**
 * Live capture for trade-time USD (usd-history.ts states the rule). Before the indexer applies a range, it writes the
 * live USD price of every quote in use on the chain into the current UTC hour's row of bb_quote_usd_hourly (source
 * 'live'), so a trade indexed seconds after it happened is priced at that spot. The row keeps updating until the hour
 * ends; after that it is frozen, and it is never replaced by a historical close (the backfill fills only hours that have
 * no row). Prices come from the same sources the lists use (queries.quoteUsdNow). A quote with no price right now is not
 * written: its trades keep usd NULL until the heal pass below (or scripts/usd-backfill.ts) prices them. Display only.
 *
 * Community pairs are NEVER captured (capturable): a pair priced from an outside pool can be pushed for a minute (season
 * points exclude those for that reason, queries.quotePricer), and a price frozen into a trade would stay in the totals for
 * good; and a suspended or delisted pair must show no USD at all, which a stored value would defeat. Their trades keep usd
 * NULL and count at the pair's price now, which follows its listing status (trade-time-usd.ts).
 */
/** Which quotes the live capture stores a price for: every priced quote except community pairs (see above). */
export function capturable(key: string): boolean {
  return key !== "pair" && key !== "other";
}
export const LIVE_CAPTURE_EVERY_MS = 60_000;
const lastCapture = new Map<ChainKey, number>();

/** Test-only: forget when each chain was last captured and healed. */
export function resetLiveCapture(): void {
  lastCapture.clear();
  lastHeal.clear();
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
      return capturable(p.key) && p.usd !== null && Number.isFinite(p.usd) && p.usd > 0 && p.decimalsKnown ? [{ quote, usd: p.usd, decimals: p.decimals }] : [];
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

/**
 * Heal pass: price the trades and quote-side fees of the last HEAL_WINDOW that have no USD value yet but whose hour now has
 * a price (an hour whose capture came late, a minute a source was down, the receipt path that does not capture), and add
 * them to their launch's totals in the same statement. Community pairs are skipped (never stored, see above). Each row is
 * re-tested inside the UPDATE (usd IS NULL), so two machines running the same pass change each row, and each total, once.
 * At most once per HEAL_EVERY_MS per chain; never throws.
 */
export const HEAL_EVERY_MS = 5 * 60_000;
export const HEAL_BATCH = 2_000;
const HEAL_WINDOW = "3 days";
const lastHeal = new Map<ChainKey, number>();

export async function healUnpricedUsd(db: Db, chain: ChainKey, now = Date.now()): Promise<{ swaps: number; fees: number }> {
  const last = lastHeal.get(chain);
  if (last !== undefined && now - last < HEAL_EVERY_MS) return { swaps: 0, fees: 0 };
  lastHeal.set(chain, now);
  const cid = chainIdOf(chain);
  try {
    const swaps = await db<{ n: number }[]>`
      WITH todo AS (
        SELECT s.chain_id, s.tx_hash, s.log_index, abs(COALESCE(s.trader_amount0, s.amount0)) / power(10::numeric, p.decimals) * p.usd AS v
          FROM bb_launch_swaps s
          JOIN bb_launches l ON l.chain_id = s.chain_id AND l.token = s.token
          JOIN bb_quote_usd_hourly p ON p.chain_id = s.chain_id AND p.quote = l.quote AND p.hour = ${db.unsafe(hourSql("s.block_time"))}
         WHERE s.chain_id = ${cid} AND s.usd IS NULL AND s.block_time > now() - ${HEAL_WINDOW}::interval
           AND NOT EXISTS (SELECT 1 FROM bb_pairs pr WHERE pr.chain_id = l.chain_id AND pr.address = l.quote)
         LIMIT ${HEAL_BATCH}
      ), priced AS (
        UPDATE bb_launch_swaps s SET usd = t.v FROM todo t
         WHERE s.chain_id = t.chain_id AND s.tx_hash = t.tx_hash AND s.log_index = t.log_index AND s.usd IS NULL
        RETURNING s.chain_id, s.token, s.usd
      ), totals AS (
        UPDATE bb_launches l SET volume_usd = l.volume_usd + x.v
          FROM (SELECT chain_id, token, sum(usd) AS v FROM priced GROUP BY chain_id, token) x
         WHERE l.chain_id = x.chain_id AND l.token = x.token
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM priced)::int AS n`;
    const fees = await db<{ n: number }[]>`
      WITH todo AS (
        SELECT f.chain_id, f.tx_hash, f.log_index,
               CASE WHEN f.kind = 'collected' THEN f.quote_amount ELSE f.amount END / power(10::numeric, p.decimals) * p.usd AS v
          FROM bb_launch_fee_events f
          JOIN bb_launches l ON l.chain_id = f.chain_id AND l.token = f.token
          JOIN bb_quote_usd_hourly p ON p.chain_id = f.chain_id AND p.quote = l.quote AND p.hour = ${db.unsafe(hourSql("f.block_time"))}
         WHERE f.chain_id = ${cid} AND f.usd IS NULL AND f.block_time > now() - ${HEAL_WINDOW}::interval
           AND (f.kind = 'collected' OR (f.kind = 'burned' AND f.currency = l.quote))
           AND NOT EXISTS (SELECT 1 FROM bb_pairs pr WHERE pr.chain_id = l.chain_id AND pr.address = l.quote)
         LIMIT ${HEAL_BATCH}
      ), priced AS (
        UPDATE bb_launch_fee_events f SET usd = t.v FROM todo t
         WHERE f.chain_id = t.chain_id AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index AND f.usd IS NULL
        RETURNING f.chain_id, f.token, f.kind, f.usd
      ), totals AS (
        UPDATE bb_launches l SET fees_collected_usd = l.fees_collected_usd + x.c, fees_burned_usd = l.fees_burned_usd + x.b
          FROM (SELECT chain_id, token, COALESCE(sum(usd) FILTER (WHERE kind = 'collected'), 0) AS c,
                       COALESCE(sum(usd) FILTER (WHERE kind = 'burned'), 0) AS b
                  FROM priced GROUP BY chain_id, token) x
         WHERE l.chain_id = x.chain_id AND l.token = x.token
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM priced)::int AS n`;
    return { swaps: swaps[0]?.n ?? 0, fees: fees[0]?.n ?? 0 };
  } catch (err) {
    if (last === undefined) lastHeal.delete(chain);
    else lastHeal.set(chain, last);
    console.warn(`[usd] heal pass failed on ${chain}: ${errMessage(err)}`);
    return { swaps: 0, fees: 0 };
  }
}
