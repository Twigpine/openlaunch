-- Indexes on the big, busy tables, built by scripts/migrate.mjs AFTER the schema transaction commits, one at a time
-- with CREATE INDEX CONCURRENTLY: reads and writes on the table never wait for the build. (Inside the schema
-- transaction a build would hold the exclusive lock an ALTER TABLE on that table already took, and every query on
-- it would queue behind the whole build.) One statement per entry, each `CREATE INDEX CONCURRENTLY IF NOT EXISTS`;
-- an index a failed build left invalid is dropped and built again on the next deploy. Only for indexes whose columns
-- schema.sql already has.

-- swap attribution (2026-10-07): the unchecked set, every swap until the history drain reaches it, then only the
-- newest few (the partial index stays small); EntryPoint calls whose receipt is not read yet
CREATE INDEX CONCURRENTLY IF NOT EXISTS bb_launch_swaps_unattributed_idx ON bb_launch_swaps (chain_id, block_number DESC) WHERE trader_via IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS bb_launch_swaps_receipt_pending_idx ON bb_launch_swaps (chain_id, block_number DESC) WHERE trader_via = 'receipt_pending';
-- one wallet's trades (profile pages, /me, posting eligibility, points) without scanning every swap
CREATE INDEX CONCURRENTLY IF NOT EXISTS bb_launch_swaps_trader_idx ON bb_launch_swaps (trader, block_number DESC);
