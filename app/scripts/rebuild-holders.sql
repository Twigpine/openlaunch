-- Rebuild bb_token_holders from bb_token_transfers (the deduped source of truth) and refresh the
-- per-launch holders counters. Generate the public per-chain config with scripts/rebuild-holders.ts first.
-- Review the generated file and run with psql -v ON_ERROR_STOP=1; running this template alone fails closed.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Match canonical writer ordering: acquire launches before requesting any transfer/holder locks.
LOCK TABLE bb_launches IN EXCLUSIVE MODE;
CREATE TEMP TABLE holder_rebuild_exclusions ON COMMIT DROP AS
  SELECT entry.key::integer AS chain_id, lower(address.value) AS address
    FROM jsonb_each(current_setting('openlaunch.holder_exclusions')::jsonb) entry
    CROSS JOIN LATERAL jsonb_array_elements_text(entry.value) address(value);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bb_launches l WHERE NOT EXISTS
    (SELECT 1 FROM holder_rebuild_exclusions e WHERE e.chain_id = l.chain_id)) THEN
    RAISE EXCEPTION 'holder rebuild configuration does not cover every stored launch chain';
  END IF;
END $$;
LOCK TABLE bb_token_transfers IN SHARE MODE;
LOCK TABLE bb_token_holders IN EXCLUSIVE MODE;
WITH legs AS (
  SELECT chain_id, token, from_addr AS holder, -value AS d, block_number FROM bb_token_transfers WHERE from_addr <> '0x0000000000000000000000000000000000000000'
  UNION ALL
  SELECT chain_id, token, to_addr, value, block_number FROM bb_token_transfers WHERE to_addr <> '0x0000000000000000000000000000000000000000'
), agg AS (
  SELECT chain_id, token, holder, sum(d) AS balance, min(block_number) AS first_block, max(block_number) AS last_block FROM legs GROUP BY 1, 2, 3
)
INSERT INTO bb_token_holders (chain_id, token, holder, balance, first_block, last_block)
SELECT chain_id, token, holder, balance, first_block, last_block FROM agg
ON CONFLICT (chain_id, token, holder) DO UPDATE
  SET balance = EXCLUDED.balance, first_block = LEAST(bb_token_holders.first_block, EXCLUDED.first_block), last_block = GREATEST(bb_token_holders.last_block, EXCLUDED.last_block);
-- rows with no transfer legs left (should not exist) → zero them rather than delete, keeps history
UPDATE bb_token_holders h SET balance = 0
 WHERE NOT EXISTS (SELECT 1 FROM bb_token_transfers t WHERE t.chain_id = h.chain_id AND t.token = h.token AND (t.from_addr = h.holder OR t.to_addr = h.holder));
-- One chain-aware exclusion set, shared with the live indexer (public config generated above).
UPDATE bb_launches l SET holders = COALESCE(c.n, 0)
  FROM (SELECT l2.chain_id, l2.token,
               (SELECT count(*) FROM bb_token_holders h WHERE h.chain_id = l2.chain_id AND h.token = l2.token AND h.balance > 0
                  AND NOT EXISTS (SELECT 1 FROM holder_rebuild_exclusions e WHERE e.chain_id = h.chain_id AND e.address = h.holder)) AS n
          FROM bb_launches l2) c
 WHERE l.chain_id = c.chain_id AND l.token = c.token;
COMMIT;
-- check: every launch's balances + burns to zero must equal its supply
WITH sums AS (SELECT chain_id, token, sum(balance) held FROM bb_token_holders GROUP BY 1, 2),
     burned AS (SELECT chain_id, token, COALESCE(sum(value), 0) b FROM bb_token_transfers WHERE to_addr = '0x0000000000000000000000000000000000000000' GROUP BY 1, 2)
SELECT count(*) FILTER (WHERE l.supply = s.held + COALESCE(b.b, 0)) AS ok, count(*) FILTER (WHERE l.supply <> s.held + COALESCE(b.b, 0)) AS mismatch
  FROM bb_launches l LEFT JOIN sums s ON s.chain_id = l.chain_id AND s.token = l.token LEFT JOIN burned b ON b.chain_id = l.chain_id AND b.token = l.token;
