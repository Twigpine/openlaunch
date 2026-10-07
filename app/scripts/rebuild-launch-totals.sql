-- Recompute every launch's rolling totals from the raw event tables (bb_launch_swaps, bb_launch_fee_events).
-- Idempotent. Run when totals could have drifted (e.g. an ingestion interrupted between "insert swap" and
-- "update totals" before those became one transaction). Prints a drift report first, then repairs.
-- Usage: fly ssh sftp shell -a basebid-db <<< "put scripts/rebuild-launch-totals.sql /tmp/r.sql"
--        fly ssh console -a basebid-db -C "sh -c 'PGPASSWORD=$OPERATOR_PASSWORD psql -h localhost -p 5433 -U postgres -d basebid -f /tmp/r.sql'"
-- Concurrency: everything runs in ONE transaction that takes SHARE locks on the raw event tables and an
-- EXCLUSIVE lock on bb_launches, so the indexer's ingestion transactions (INSERT event + UPDATE totals)
-- block for the few seconds this takes and then apply on top of the recomputed values — nothing is lost.
BEGIN;
LOCK TABLE bb_launch_swaps IN SHARE MODE;
LOCK TABLE bb_launch_fee_events IN SHARE MODE;
LOCK TABLE bb_launches IN EXCLUSIVE MODE;

WITH s AS (
  SELECT chain_id, token, count(*) FILTER (WHERE is_buy) AS buys, count(*) FILTER (WHERE NOT is_buy) AS sells,
         COALESCE(sum(abs(COALESCE(trader_amount0, amount0))), 0) AS volume_quote, max(block_time) AS last_trade_at
    FROM bb_launch_swaps GROUP BY 1, 2
)
SELECT 'drift before' AS what,
       count(*) FILTER (WHERE l.buys <> s.buys OR l.sells <> s.sells OR l.volume_quote <> s.volume_quote) AS launches_with_wrong_totals,
       count(*) FILTER (WHERE (l.buys + l.sells) > 0 AND s.token IS NULL) AS totals_without_swaps
  FROM bb_launches l LEFT JOIN s ON s.chain_id = l.chain_id AND s.token = l.token;

-- swaps → buys / sells / volume / accrued quote fees / last trade
-- (volume is the trader's quote amount: quote-only launches record it next to the pool's own delta)
UPDATE bb_launches l SET
  buys = COALESCE(s.buys, 0), sells = COALESCE(s.sells, 0), volume_quote = COALESCE(s.volume_quote, 0),
  fees_quote_accrued = COALESCE(s.fees_quote_accrued, 0), last_trade_at = s.last_trade_at
  FROM (SELECT l2.chain_id, l2.token,
               (SELECT count(*) FROM bb_launch_swaps x WHERE x.chain_id = l2.chain_id AND x.token = l2.token AND x.is_buy) AS buys,
               (SELECT count(*) FROM bb_launch_swaps x WHERE x.chain_id = l2.chain_id AND x.token = l2.token AND NOT x.is_buy) AS sells,
               (SELECT COALESCE(sum(abs(COALESCE(trader_amount0, amount0))), 0) FROM bb_launch_swaps x WHERE x.chain_id = l2.chain_id AND x.token = l2.token) AS volume_quote,
               (SELECT COALESCE(sum(quote_fee), 0) FROM bb_launch_swaps x WHERE x.chain_id = l2.chain_id AND x.token = l2.token) AS fees_quote_accrued,
               (SELECT max(block_time) FROM bb_launch_swaps x WHERE x.chain_id = l2.chain_id AND x.token = l2.token) AS last_trade_at
          FROM bb_launches l2) s
 WHERE l.chain_id = s.chain_id AND l.token = s.token;
-- latest swap → price / tick
UPDATE bb_launches l SET sqrt_price_x96 = x.sqrt_price_x96, tick = x.tick, last_swap_block = x.block_number, last_swap_log = x.log_index
  FROM (SELECT DISTINCT ON (chain_id, token) chain_id, token, sqrt_price_x96, tick, block_number, log_index
          FROM bb_launch_swaps ORDER BY chain_id, token, block_number DESC, log_index DESC) x
 WHERE l.chain_id = x.chain_id AND l.token = x.token;
-- fee events written before their launch was indexed carry token NULL; attach them by position id first so
-- the totals below (which join on token) count them
UPDATE bb_launch_fee_events e SET token = l.token
  FROM bb_launches l
 WHERE e.token IS NULL AND e.token_id IS NOT NULL AND e.chain_id = l.chain_id AND e.token_id = l.token_id;
-- fee events → collected / burned totals
UPDATE bb_launches l SET
  fees_quote_collected = f.qc, fees_token_collected = f.tc, fees_quote_burned = f.qb, fees_token_burned = f.tb
  FROM (SELECT l2.chain_id, l2.token,
               (SELECT COALESCE(sum(quote_amount), 0) FROM bb_launch_fee_events e WHERE e.chain_id = l2.chain_id AND e.token = l2.token AND e.kind = 'collected') AS qc,
               (SELECT COALESCE(sum(token_amount), 0) FROM bb_launch_fee_events e WHERE e.chain_id = l2.chain_id AND e.token = l2.token AND e.kind = 'collected') AS tc,
               (SELECT COALESCE(sum(amount), 0) FROM bb_launch_fee_events e WHERE e.chain_id = l2.chain_id AND e.token = l2.token AND e.kind = 'burned' AND e.currency = l2.quote) AS qb,
               (SELECT COALESCE(sum(amount), 0) FROM bb_launch_fee_events e WHERE e.chain_id = l2.chain_id AND e.token = l2.token AND e.kind = 'burned' AND e.currency <> l2.quote) AS tb
          FROM bb_launches l2) f
 WHERE l.chain_id = f.chain_id AND l.token = f.token;

WITH s AS (
  SELECT chain_id, token, count(*) FILTER (WHERE is_buy) AS buys, count(*) FILTER (WHERE NOT is_buy) AS sells, COALESCE(sum(abs(COALESCE(trader_amount0, amount0))), 0) AS volume_quote
    FROM bb_launch_swaps GROUP BY 1, 2
)
SELECT 'drift after' AS what,
       count(*) FILTER (WHERE l.buys <> COALESCE(s.buys, 0) OR l.sells <> COALESCE(s.sells, 0) OR l.volume_quote <> COALESCE(s.volume_quote, 0)) AS launches_with_wrong_totals
  FROM bb_launches l LEFT JOIN s ON s.chain_id = l.chain_id AND s.token = l.token;
COMMIT;
