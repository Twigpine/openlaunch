-- basebid.lol · free token launchpad on Base.
--
-- Applied by scripts/migrate.mjs (Fly release_command) against the DEDICATED
-- basebid Postgres on EVERY deploy, inside one transaction — so everything here
-- must be idempotent: CREATE … IF NOT EXISTS, ALTER TABLE … ADD COLUMN IF NOT
-- EXISTS. Tables keep the historical `bb_` prefix. The app connects as the
-- database owner over Fly's private network (no RLS / roles).
--
-- Source of truth is the chain (LaunchFactory / LaunchLocker / PoolManager
-- events); these tables are an index of it plus off-chain metadata and the
-- indexer cursor. Amounts are wei as numeric(78,0). Addresses LOWERCASE hex.
--
-- NOTE: the pre-2026-09 stake-to-rank tables (bb_entries, bb_bids, …) are no
-- longer created here and are intentionally NOT dropped: they hold the
-- history of the old board. Drop them by hand once the escrow is wound down.

CREATE TABLE IF NOT EXISTS bb_migrations (
  id            bigserial PRIMARY KEY,
  schema_sha256 text NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  applied_by    text
);

-- ── launchpad ────────────────────────────────────────────────────────────────
-- Index of the fee-free LaunchFactory / LaunchLocker (contracts/docs/LAUNCHPAD.md)
-- plus PoolManager Swap events for the pools it created. Amounts are wei as
-- numeric(78,0) (exact; never through a double). Addresses / ids LOWERCASE hex.

CREATE TABLE IF NOT EXISTS bb_launches (
  token                text PRIMARY KEY,
  token_id             bigint NOT NULL,
  launcher             text NOT NULL,
  quote                text NOT NULL,                       -- 0x000…000 = native ETH
  pool_id              text NOT NULL UNIQUE,
  start_tick           integer NOT NULL,
  lp_fee               integer NOT NULL,                    -- pips (10000 = 1%)
  supply               numeric(78,0) NOT NULL,
  metadata_uri         text NOT NULL DEFAULT '',
  name                 text NOT NULL,
  symbol               text NOT NULL,
  block_number         bigint NOT NULL,
  block_time           timestamptz NOT NULL,
  tx_hash              text NOT NULL,
  log_index            integer NOT NULL,
  -- rolling state maintained by swap / fee ingestion
  sqrt_price_x96       numeric(78,0),
  tick                 integer,
  last_swap_block      bigint NOT NULL DEFAULT 0,
  last_swap_log        integer NOT NULL DEFAULT 0,
  volume_quote         numeric(78,0) NOT NULL DEFAULT 0,    -- |quote| traded, buys + sells
  buys                 integer NOT NULL DEFAULT 0,
  sells                integer NOT NULL DEFAULT 0,
  last_trade_at        timestamptz,
  fees_quote_collected numeric(78,0) NOT NULL DEFAULT 0,
  fees_token_collected numeric(78,0) NOT NULL DEFAULT 0,
  fees_quote_burned    numeric(78,0) NOT NULL DEFAULT 0,
  fees_token_burned    numeric(78,0) NOT NULL DEFAULT 0,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS bb_launches_time_idx ON bb_launches (block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS bb_launches_volume_idx ON bb_launches (volume_quote DESC);
CREATE INDEX IF NOT EXISTS bb_launches_launcher_idx ON bb_launches (launcher);

CREATE TABLE IF NOT EXISTS bb_launch_swaps (
  tx_hash        text NOT NULL,
  log_index      integer NOT NULL,
  token          text NOT NULL REFERENCES bb_launches(token),
  pool_id        text NOT NULL,
  trader         text,                                      -- tx.from (router is the event sender)
  amount0        numeric(78,0) NOT NULL,                    -- signed, swapper's perspective (quote)
  amount1        numeric(78,0) NOT NULL,                    -- signed (token)
  sqrt_price_x96 numeric(78,0) NOT NULL,
  tick           integer NOT NULL,
  is_buy         boolean NOT NULL,
  block_number   bigint NOT NULL,
  block_time     timestamptz NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS bb_launch_swaps_token_idx ON bb_launch_swaps (token, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS bb_launch_swaps_time_idx ON bb_launch_swaps (block_number DESC, log_index DESC);

CREATE TABLE IF NOT EXISTS bb_launch_fee_events (
  tx_hash      text NOT NULL,
  log_index    integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('collected','burned','paid','credited','claimed')),
  token_id     bigint,                                      -- null for credited/claimed
  token        text,
  currency     text,
  account      text,
  quote_amount numeric(78,0),
  token_amount numeric(78,0),
  amount       numeric(78,0),
  block_number bigint NOT NULL,
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS bb_launch_fee_events_token_idx ON bb_launch_fee_events (token, block_number DESC);

-- Off-chain metadata, written BEFORE the launch tx against the predicted token
-- address (the on-chain metadataURI points at /api/launch/meta/<token>).
CREATE TABLE IF NOT EXISTS bb_launch_meta (
  token       text PRIMARY KEY,
  launcher    text NOT NULL,
  name        text NOT NULL,
  symbol      text NOT NULL,
  description text,
  image_url   text,
  website     text,
  x_handle    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bb_launch_sync_state (
  id           integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cursor_block bigint NOT NULL DEFAULT 0,                  -- last block fully scanned
  head_block   bigint,
  last_run_at  timestamptz,
  last_error   text
);
INSERT INTO bb_launch_sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE bb_launches ADD COLUMN IF NOT EXISTS recipients jsonb NOT NULL DEFAULT '[]'::jsonb;  -- [{payout,bps}] from LaunchLocker.recipientsOf
ALTER TABLE bb_launch_fee_events DROP CONSTRAINT IF EXISTS bb_launch_fee_events_kind_check;
ALTER TABLE bb_launch_fee_events ADD CONSTRAINT bb_launch_fee_events_kind_check CHECK (kind IN ('collected','burned','paid','credited','claimed'));

-- ── site pulse: all-time visits + who is online now (cookie-free, no PII) ────
-- visitor_hash = sha256(ip | user-agent | daily salt): rotates daily, cannot be reversed.
CREATE TABLE IF NOT EXISTS bb_site_counters (
  id      integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  visits  bigint NOT NULL DEFAULT 0                      -- sessions: one per visitor per 30 min
);
CREATE TABLE IF NOT EXISTS bb_presence (
  visitor_hash text PRIMARY KEY,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bb_presence_last_seen_idx ON bb_presence (last_seen DESC);
-- Seed the counter ONCE from the pre-pivot analytics (bb_daily_site rollups + un-rolled
-- bb_views), if those tables exist, so the all-time number carries over.
DO $$
DECLARE seeded bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bb_site_counters WHERE id = 1) THEN
    IF to_regclass('bb_daily_site') IS NOT NULL THEN
      SELECT COALESCE(sum(views), 0) INTO seeded FROM bb_daily_site;
      IF to_regclass('bb_views') IS NOT NULL THEN
        seeded := seeded + (SELECT count(*) FROM bb_views v WHERE v.kind = 'human'
                            AND v.day > COALESCE((SELECT max(day) FROM bb_daily_site), '1970-01-01'::date));
      END IF;
    END IF;
    INSERT INTO bb_site_counters (id, visits) VALUES (1, seeded);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS bb_launch_swaps_token_time_idx ON bb_launch_swaps (token, block_time DESC);  -- rolling 1h/24h stats

-- ── multi-chain (2026-09-06): Base 8453 + Robinhood Chain 4663 ──────────────
-- Rows are keyed by (chain_id, token). Existing rows are Base. Idempotent.
ALTER TABLE bb_launches ADD COLUMN IF NOT EXISTS chain_id integer NOT NULL DEFAULT 8453;
ALTER TABLE bb_launch_swaps ADD COLUMN IF NOT EXISTS chain_id integer NOT NULL DEFAULT 8453;
ALTER TABLE bb_launch_fee_events ADD COLUMN IF NOT EXISTS chain_id integer NOT NULL DEFAULT 8453;
ALTER TABLE bb_launch_meta ADD COLUMN IF NOT EXISTS chain_id integer NOT NULL DEFAULT 8453;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bb_launch_swaps_token_fkey') THEN
    ALTER TABLE bb_launch_swaps DROP CONSTRAINT bb_launch_swaps_token_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'bb_launches' AND c.contype = 'p' AND array_length(c.conkey, 1) = 1) THEN
    ALTER TABLE bb_launches DROP CONSTRAINT bb_launches_pkey;
    ALTER TABLE bb_launches ADD PRIMARY KEY (chain_id, token);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bb_launches_pool_id_key') THEN
    ALTER TABLE bb_launches DROP CONSTRAINT bb_launches_pool_id_key;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bb_launches_tx_hash_log_index_key') THEN
    ALTER TABLE bb_launches DROP CONSTRAINT bb_launches_tx_hash_log_index_key;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'bb_launch_swaps' AND c.contype = 'p' AND array_length(c.conkey, 1) = 2) THEN
    ALTER TABLE bb_launch_swaps DROP CONSTRAINT bb_launch_swaps_pkey;
    ALTER TABLE bb_launch_swaps ADD PRIMARY KEY (chain_id, tx_hash, log_index);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'bb_launch_fee_events' AND c.contype = 'p' AND array_length(c.conkey, 1) = 2) THEN
    ALTER TABLE bb_launch_fee_events DROP CONSTRAINT bb_launch_fee_events_pkey;
    ALTER TABLE bb_launch_fee_events ADD PRIMARY KEY (chain_id, tx_hash, log_index);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'bb_launch_meta' AND c.contype = 'p' AND array_length(c.conkey, 1) = 1) THEN
    ALTER TABLE bb_launch_meta DROP CONSTRAINT bb_launch_meta_pkey;
    ALTER TABLE bb_launch_meta ADD PRIMARY KEY (chain_id, token);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS bb_launches_chain_pool_idx ON bb_launches (chain_id, pool_id);
CREATE UNIQUE INDEX IF NOT EXISTS bb_launches_chain_tx_idx ON bb_launches (chain_id, tx_hash, log_index);
CREATE INDEX IF NOT EXISTS bb_launches_chain_time_idx ON bb_launches (chain_id, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS bb_launch_swaps_chain_token_idx ON bb_launch_swaps (chain_id, token, block_number DESC, log_index DESC);

-- one indexer cursor per chain (replaces the single-row bb_launch_sync_state)
CREATE TABLE IF NOT EXISTS bb_launch_sync_cursor (
  chain_id     integer PRIMARY KEY,
  cursor_block bigint NOT NULL DEFAULT 0,
  head_block   bigint,
  last_run_at  timestamptz,
  last_error   text
);
INSERT INTO bb_launch_sync_cursor (chain_id, cursor_block, head_block, last_run_at, last_error)
  SELECT 8453, cursor_block, head_block, last_run_at, last_error FROM bb_launch_sync_state WHERE id = 1
  ON CONFLICT (chain_id) DO NOTHING;
INSERT INTO bb_launch_sync_cursor (chain_id) VALUES (4663) ON CONFLICT DO NOTHING;

-- ── signed metadata edits ────────────────────────────────────────────────────
-- Single-use nonces for the /me "edit token details" flow (see src/lib/launchpad/editAuth.ts).
CREATE TABLE IF NOT EXISTS bb_edit_nonces (
  nonce      text PRIMARY KEY,                             -- 32 hex chars
  chain_id   integer NOT NULL,
  token      text NOT NULL,
  wallet     text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX IF NOT EXISTS bb_edit_nonces_expires_idx ON bb_edit_nonces (expires_at);
ALTER TABLE bb_launch_meta ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- ── posts (comments on token pages + the human feed) ─────────────────────────
-- Every row was written from a wallet-signed message (see src/lib/launchpad/posts.ts).
CREATE TABLE IF NOT EXISTS bb_posts (
  id          bigserial PRIMARY KEY,
  chain_id    integer NOT NULL,
  token       text NOT NULL,
  wallet      text NOT NULL,
  parent_id   bigint REFERENCES bb_posts(id) ON DELETE CASCADE,
  body        text NOT NULL,
  tag         text,                                        -- creator | whale | holder | null (at post time)
  signature   text NOT NULL,                               -- audit trail
  created_at  timestamptz NOT NULL DEFAULT now(),
  hidden      boolean NOT NULL DEFAULT false,
  hidden_by   text,                                        -- 'auto' | admin wallet
  reports     integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bb_posts_token_idx ON bb_posts (chain_id, token, created_at DESC);
CREATE INDEX IF NOT EXISTS bb_posts_time_idx ON bb_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS bb_posts_wallet_idx ON bb_posts (wallet, created_at DESC);
CREATE TABLE IF NOT EXISTS bb_post_reports (
  post_id    bigint NOT NULL REFERENCES bb_posts(id) ON DELETE CASCADE,
  wallet     text NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, wallet)
);
CREATE TABLE IF NOT EXISTS bb_token_settings (
  chain_id       integer NOT NULL,
  token          text NOT NULL,
  comments_muted boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, token)
);
-- single-use nonces for post / report / mod signatures (client-generated, server-consumed)
CREATE TABLE IF NOT EXISTS bb_post_nonces (
  nonce      text PRIMARY KEY,
  wallet     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── holders (token Transfer events → balances; trust panel) ─────────────────
-- Every Transfer of a launched token, deduped by (chain, tx, log) so re-scans and backfills are idempotent.
CREATE TABLE IF NOT EXISTS bb_token_transfers (
  chain_id     integer NOT NULL,
  tx_hash      text NOT NULL,
  log_index    integer NOT NULL,
  token        text NOT NULL,
  from_addr    text NOT NULL,
  to_addr      text NOT NULL,
  value        numeric(78,0) NOT NULL,
  block_number bigint NOT NULL,
  block_time   timestamptz,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS bb_token_transfers_token_idx ON bb_token_transfers (chain_id, token, block_number DESC);
-- Running balance per wallet per token (the pool / locker / zero / dead addresses are stored too and tagged in queries).
CREATE TABLE IF NOT EXISTS bb_token_holders (
  chain_id     integer NOT NULL,
  token        text NOT NULL,
  holder       text NOT NULL,
  balance      numeric(78,0) NOT NULL DEFAULT 0,
  first_block  bigint NOT NULL,
  last_block   bigint NOT NULL,
  PRIMARY KEY (chain_id, token, holder)
);
CREATE INDEX IF NOT EXISTS bb_token_holders_top_idx ON bb_token_holders (chain_id, token, balance DESC);
-- Per-launch counter (wallets with balance > 0, excluding the pool / zero / dead) + backfill marker
-- (NULL = history not yet scanned; the loop backfills from the launch block, then keeps up per chunk).
ALTER TABLE bb_launches ADD COLUMN IF NOT EXISTS holders integer NOT NULL DEFAULT 0;
ALTER TABLE bb_launches ADD COLUMN IF NOT EXISTS holders_synced_block bigint;
CREATE INDEX IF NOT EXISTS bb_launches_holders_idx ON bb_launches (holders DESC);

-- feed: newest swaps across all tokens without scanning the table
CREATE INDEX IF NOT EXISTS bb_launch_swaps_bt_idx ON bb_launch_swaps (block_time DESC);
CREATE INDEX IF NOT EXISTS bb_launches_bt_idx ON bb_launches (block_time DESC);

-- ── metadata key (stable URI across the CREATE2 salt search) ────────────────
ALTER TABLE bb_launch_meta ADD COLUMN IF NOT EXISTS meta_key text;
CREATE INDEX IF NOT EXISTS bb_launch_meta_key_idx ON bb_launch_meta (launcher, meta_key);

-- ── chain_id has no default (2026-09-14) ───────────────────────────────────
-- The multi-chain ALTERs above backfilled pre-existing rows as Base (8453); from here every insert
-- must name its chain, so a row written without one fails loudly instead of being filed under Base.
ALTER TABLE bb_launches ALTER COLUMN chain_id DROP DEFAULT;
ALTER TABLE bb_launch_swaps ALTER COLUMN chain_id DROP DEFAULT;
ALTER TABLE bb_launch_fee_events ALTER COLUMN chain_id DROP DEFAULT;
ALTER TABLE bb_launch_meta ALTER COLUMN chain_id DROP DEFAULT;

-- ── unlisted quote tokens (2026-09-25) ─────────────────────────────────────
-- The factory takes any ERC-20 as the quote. For a quote no list knows, the indexer reads the token's own
-- symbol / name / decimals once and keeps them here (lib/launchpad/unlisted-quote.ts decides what is shown).
-- A NULL field is one the contract did not answer; checked_at spaces out the retries. Addresses LOWERCASE hex.
CREATE TABLE IF NOT EXISTS bb_quote_tokens (
  chain_id    integer NOT NULL,
  address     text NOT NULL,
  symbol      text,
  name        text,
  decimals    integer,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address)
);
