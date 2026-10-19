import type { Db } from "../db";
import type postgres from "postgres";
import { MCAP_HIGH_USD, MCAP_MIN_TRADERS, MCAP_MIN_WALLET_USD, MCAP_SUPPORT_RATIO, type McapMode } from "./mcap-policy";
import { SNIPER_BLOCKS } from "./holders";

type Fragment = postgres.PendingQuery<postgres.Row[]>;
export type McapColumns = {
  _mcap_fdv_quote: number | null;
  _mcap_start_quote: number | null;
  _mcap_outside_quote: number | null;
  _mcap_traders: number | null;
};

/**
 * Assess valuations and outside trading before paging, then hydrate the page with rolling stats and metadata.
 * @throws If the hydration SELECT loses its expected prefix, rather than silently omitting market-cap facts.
 */
export function mcapPageQuery(db: Db, opts: { where: Fragment; quoteDecimals: Fragment; quoteUsd: Fragment; mode: McapMode; limit: number; offset: number; select: string }) {
  const { where, quoteDecimals: qd, quoteUsd: usd, mode, limit, offset } = opts;
  if (!opts.select.startsWith("SELECT l.*,")) throw new Error("mcapPageQuery: unexpected SELECT prefix");
  const select = opts.select.replace("SELECT l.*,", "SELECT l.*, page._mcap_fdv_quote, page._mcap_start_quote, page._mcap_outside_quote, page._mcap_traders,");
  return db`
    WITH valued AS MATERIALIZED (
      SELECT l.chain_id, l.token, l.launcher, l.block_time, l.block_number,
             ${qd} AS quote_decimals, ${usd} AS quote_usd,
             CASE WHEN l.supply > 0 AND l.start_tick BETWEEN -887272 AND 887272 THEN
               (l.supply::double precision / 1e18) / (power(1.0001, l.start_tick::double precision) * power(10, ${qd} - 18)) END AS _mcap_start_quote,
             CASE WHEN l.supply > 0 THEN
               CASE WHEN l.sqrt_price_x96 > 0 THEN
                 (l.supply::double precision / 1e18) / (power(l.sqrt_price_x96::double precision / 79228162514264337593543950336.0, 2) * power(10, ${qd} - 18))
               WHEN COALESCE(l.tick, l.start_tick) BETWEEN -887272 AND 887272 THEN
                 (l.supply::double precision / 1e18) / (power(1.0001, COALESCE(l.tick, l.start_tick)::double precision) * power(10, ${qd} - 18)) END
             END AS _mcap_fdv_quote
        FROM bb_launches l ${where}
    ), assessed AS (
      SELECT v.*, v._mcap_fdv_quote * v.quote_usd AS fdv_usd,
             CASE WHEN v._mcap_start_quote * v.quote_usd >= ${MCAP_HIGH_USD} AND v._mcap_fdv_quote * v.quote_usd >= ${MCAP_HIGH_USD}
               THEN COALESCE(outside.volume, 0) / power(10, v.quote_decimals) END AS _mcap_outside_quote,
             CASE WHEN v._mcap_start_quote * v.quote_usd >= ${MCAP_HIGH_USD} AND v._mcap_fdv_quote * v.quote_usd >= ${MCAP_HIGH_USD}
               THEN COALESCE(outside.traders, 0)::int END AS _mcap_traders,
             COALESCE(v._mcap_start_quote * v.quote_usd >= ${MCAP_HIGH_USD}
               AND v._mcap_fdv_quote * v.quote_usd >= ${MCAP_HIGH_USD}
               AND NOT (COALESCE(outside.volume, 0) / power(10, v.quote_decimals) >= v._mcap_start_quote * ${MCAP_SUPPORT_RATIO}
                 AND COALESCE(outside.traders, 0) >= ${MCAP_MIN_TRADERS}), false) AS outlier
        FROM valued v
        LEFT JOIN LATERAL (
          SELECT sum(wallet.volume) AS volume,
                 count(*) FILTER (WHERE wallet.volume / power(10, v.quote_decimals) * v.quote_usd >= ${MCAP_MIN_WALLET_USD}) AS traders
            FROM (
              SELECT sum(abs(s.amount0)) AS volume FROM bb_launch_swaps s
               WHERE s.chain_id = v.chain_id AND s.token = v.token AND s.trader <> v.launcher
                 AND s.block_number > v.block_number + ${SNIPER_BLOCKS}
                 AND v._mcap_start_quote * v.quote_usd >= ${MCAP_HIGH_USD}
                 AND v._mcap_fdv_quote * v.quote_usd >= ${MCAP_HIGH_USD}
               GROUP BY s.trader
            ) wallet
        ) outside ON true
    ), mcap_page AS (
      SELECT * FROM assessed WHERE ${mode === "all"} OR NOT outlier
       ORDER BY fdv_usd DESC NULLS LAST, block_time DESC, chain_id DESC, block_number DESC, token ASC
       LIMIT ${limit + 1} OFFSET ${offset}
    )
    ${db.unsafe(select)}
    JOIN mcap_page page ON page.chain_id = l.chain_id AND page.token = l.token
    ORDER BY page.fdv_usd DESC NULLS LAST, page.block_time DESC, page.chain_id DESC, page.block_number DESC, page.token ASC`;
}
