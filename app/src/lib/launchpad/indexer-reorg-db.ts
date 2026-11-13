import "server-only";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import type { Db } from "@/lib/db";
import { launchpad } from "./config";
import { DEAD_ADDR, ZERO_ADDR } from "./holders";
import { PAIR_FEE_TOLERANCE } from "./pairApply";

export type ReplayKind = "swap" | "fee" | "pair";
export type ReplayPayload = Record<string, string | number | bigint | boolean | null>;
export type ReplayValue = { usd: number | null; priced_by: string | null; valuation_pending?: boolean };
const identityFields: Record<ReplayKind, readonly string[]> = {
  swap: ["token", "pool_id", "amount0", "amount1", "sqrt_price_x96", "tick", "is_buy"],
  fee: ["kind", "token_id", "token", "quote", "currency", "account", "amount", "quote_amount", "token_amount"],
  pair: ["application_id", "sender", "twig"],
};

/** All decoded event fields must agree; a same transaction/log key alone does not identify a re-included event. */
export function replayPayloadMatches(kind: ReplayKind, stored: Record<string, unknown>, current: ReplayPayload): boolean {
  return identityFields[kind].every((key) => Object.hasOwn(current, key) && Object.hasOwn(stored, key)
    && (stored[key] === null || current[key] === null ? stored[key] === current[key] : String(stored[key]) === String(current[key])));
}

/**
 * Reuse an observed valuation only for an unchanged event at the same canonical placement. The caller supplies
 * fields decoded from a freshly validated canonical log. Legacy rows have no hash; their complete payload,
 * height and timestamp must still match. Large numeric fields in the archive are text, never JSON doubles.
 */
export async function replayValue(db: Db, chain: ChainKey, kind: ReplayKind, txHash: string, logIndex: number,
  blockNumber: bigint, blockTime: string | Date, blockHash: string, payload: ReplayPayload): Promise<ReplayValue | null> {
  const rows = await db<{ payload: Record<string, unknown>; usd: number | null; priced_by: string | null }[]>`
    SELECT payload, usd, priced_by FROM bb_launch_replay_values
     WHERE chain_id = ${chainIdOf(chain)} AND kind = ${kind} AND tx_hash = ${txHash.toLowerCase()} AND log_index = ${logIndex}
       AND block_number = ${blockNumber} AND block_time = ${new Date(blockTime).toISOString()}::timestamptz
       AND (block_hash IS NULL OR block_hash = ${blockHash.toLowerCase()})`;
  const row = rows.find((r) => replayPayloadMatches(kind, r.payload, payload));
  return row ? { usd: row.usd, priced_by: row.priced_by,
    ...(kind === "pair" ? { valuation_pending: row.payload.valuation_pending === true } : {}),
  } : null;
}

/**
 * Remove a noncanonical suffix and rebuild every dependent total from retained facts. `db` MUST be the caller's
 * transaction, under the common per-chain advisory lock. No helper obtains another connection or commits here.
 * Cursor rows precede season rows in the lock order shared with points publication. Raw swaps precede fees and
 * launches in the mutation order shared with the offline totals/USD maintenance scripts.
 */
export async function rollbackChain(db: Db, chain: ChainKey, from: bigint, reason: "reorg" | "rebuilding", head: bigint): Promise<void> {
  if (from < 0n) throw new Error("invalid reorg boundary");
  const cid = chainIdOf(chain);
  const before = from > 0n ? from - 1n : 0n;
  const [cursor] = await db<{ cursor_block: bigint }[]>`SELECT cursor_block FROM bb_launch_sync_cursor WHERE chain_id = ${cid} FOR UPDATE`;
  if (!cursor) throw new Error("missing chain cursor for rollback");
  // Preserve full raw evidence plus exact numeric strings before removing anything. A future rollback at the
  // same height replaces this slot with the most recently observed event, and replay still checks its identity.
  await db`
    INSERT INTO bb_launch_replay_values (chain_id, kind, tx_hash, log_index, block_number, block_time, block_hash, payload, usd, priced_by)
    SELECT s.chain_id, 'swap', s.tx_hash, s.log_index, s.block_number, s.block_time, b.block_hash,
           to_jsonb(s) || jsonb_build_object('amount0', s.amount0::text, 'amount1', s.amount1::text, 'sqrt_price_x96', s.sqrt_price_x96::text), s.usd, NULL
      FROM bb_launch_swaps s LEFT JOIN bb_launch_blocks b ON b.chain_id = s.chain_id AND b.block_number = s.block_number
     WHERE s.chain_id = ${cid} AND (s.block_number >= ${from} OR s.token IN (SELECT token FROM bb_launches WHERE chain_id = ${cid} AND block_number >= ${from}))
    ON CONFLICT (chain_id, kind, tx_hash, log_index, block_number) DO UPDATE
      SET block_time = EXCLUDED.block_time, block_hash = EXCLUDED.block_hash, payload = EXCLUDED.payload, usd = EXCLUDED.usd, priced_by = EXCLUDED.priced_by`;
  await db`
    INSERT INTO bb_launch_replay_values (chain_id, kind, tx_hash, log_index, block_number, block_time, block_hash, payload, usd, priced_by)
    SELECT f.chain_id, 'fee', f.tx_hash, f.log_index, f.block_number, f.block_time, b.block_hash,
           to_jsonb(f) || jsonb_build_object('token_id', f.token_id::text, 'quote', l.quote, 'amount', f.amount::text, 'quote_amount', f.quote_amount::text, 'token_amount', f.token_amount::text), f.usd, NULL
      FROM bb_launch_fee_events f LEFT JOIN bb_launch_blocks b ON b.chain_id = f.chain_id AND b.block_number = f.block_number
      LEFT JOIN bb_launches l ON l.chain_id = f.chain_id AND l.token = f.token
     WHERE f.chain_id = ${cid} AND (f.block_number >= ${from} OR f.token IN (SELECT token FROM bb_launches WHERE chain_id = ${cid} AND block_number >= ${from}))
    ON CONFLICT (chain_id, kind, tx_hash, log_index, block_number) DO UPDATE
      SET block_time = EXCLUDED.block_time, block_hash = EXCLUDED.block_hash, payload = EXCLUDED.payload, usd = EXCLUDED.usd, priced_by = EXCLUDED.priced_by`;
  await db`
    INSERT INTO bb_launch_replay_values (chain_id, kind, tx_hash, log_index, block_number, block_time, block_hash, payload, usd, priced_by)
    SELECT p.chain_id, 'pair', p.tx_hash, p.log_index, p.block_number, p.block_time, b.block_hash,
           to_jsonb(p) || jsonb_build_object('application_id', p.application_id::text, 'twig', p.twig::text), p.usd, p.priced_by
      FROM bb_pair_burns p LEFT JOIN bb_launch_blocks b ON b.chain_id = p.chain_id AND b.block_number = p.block_number
     WHERE p.chain_id = ${cid} AND p.block_number >= ${from}
    ON CONFLICT (chain_id, kind, tx_hash, log_index, block_number) DO UPDATE
      SET block_time = EXCLUDED.block_time, block_hash = EXCLUDED.block_hash, payload = EXCLUDED.payload, usd = EXCLUDED.usd, priced_by = EXCLUDED.priced_by`;
  const apps = await db<{ application_id: string }[]>`SELECT DISTINCT application_id::text FROM bb_pair_burns WHERE chain_id = ${cid} AND block_number >= ${from}`;
  await db`
    INSERT INTO bb_launch_recovery (chain_id, token, tx_hash, reason)
    SELECT chain_id, token, tx_hash, ${reason} FROM bb_launches WHERE chain_id = ${cid} AND block_number >= ${from}
    ON CONFLICT (chain_id, token) DO UPDATE SET tx_hash = EXCLUDED.tx_hash, reason = EXCLUDED.reason, created_at = now()`;
  await db`DELETE FROM bb_launch_swaps WHERE chain_id = ${cid} AND (block_number >= ${from} OR token IN (SELECT token FROM bb_launches WHERE chain_id = ${cid} AND block_number >= ${from}))`;
  await db`DELETE FROM bb_launch_fee_events WHERE chain_id = ${cid} AND (block_number >= ${from} OR token IN (SELECT token FROM bb_launches WHERE chain_id = ${cid} AND block_number >= ${from}))`;
  await db`DELETE FROM bb_token_transfers WHERE chain_id = ${cid} AND (block_number >= ${from} OR token IN (SELECT token FROM bb_launches WHERE chain_id = ${cid} AND block_number >= ${from}))`;
  await db`DELETE FROM bb_boosts WHERE chain_id = ${cid} AND block_number >= ${from}`;
  await db`DELETE FROM bb_pair_burns WHERE chain_id = ${cid} AND block_number >= ${from}`;
  await db`DELETE FROM bb_launches WHERE chain_id = ${cid} AND block_number >= ${from}`;
  // Start with the empty-event state; the latest swap below fills it only where one actually remains.
  await db`
    UPDATE bb_launches l SET
      buys = (SELECT count(*) FROM bb_launch_swaps s WHERE s.chain_id = l.chain_id AND s.token = l.token AND s.is_buy),
      sells = (SELECT count(*) FROM bb_launch_swaps s WHERE s.chain_id = l.chain_id AND s.token = l.token AND NOT s.is_buy),
      volume_quote = COALESCE((SELECT sum(abs(s.amount0)) FROM bb_launch_swaps s WHERE s.chain_id = l.chain_id AND s.token = l.token), 0),
      volume_usd = COALESCE((SELECT sum(s.usd) FROM bb_launch_swaps s WHERE s.chain_id = l.chain_id AND s.token = l.token), 0),
      last_trade_at = (SELECT max(s.block_time) FROM bb_launch_swaps s WHERE s.chain_id = l.chain_id AND s.token = l.token),
      sqrt_price_x96 = NULL, tick = l.start_tick, last_swap_block = 0, last_swap_log = 0,
      fees_quote_collected = COALESCE((SELECT sum(f.quote_amount) FROM bb_launch_fee_events f WHERE f.chain_id = l.chain_id AND f.token = l.token AND f.kind = 'collected'), 0),
      fees_token_collected = COALESCE((SELECT sum(f.token_amount) FROM bb_launch_fee_events f WHERE f.chain_id = l.chain_id AND f.token = l.token AND f.kind = 'collected'), 0),
      fees_quote_burned = COALESCE((SELECT sum(f.amount) FROM bb_launch_fee_events f WHERE f.chain_id = l.chain_id AND f.token = l.token AND f.kind = 'burned' AND f.currency = l.quote), 0),
      fees_token_burned = COALESCE((SELECT sum(f.amount) FROM bb_launch_fee_events f WHERE f.chain_id = l.chain_id AND f.token = l.token AND f.kind = 'burned' AND f.currency <> l.quote), 0),
      fees_collected_usd = COALESCE((SELECT sum(f.usd) FROM bb_launch_fee_events f WHERE f.chain_id = l.chain_id AND f.token = l.token AND f.kind = 'collected'), 0),
      fees_burned_usd = COALESCE((SELECT sum(f.usd) FROM bb_launch_fee_events f WHERE f.chain_id = l.chain_id AND f.token = l.token AND f.kind = 'burned' AND f.currency = l.quote), 0),
      holders = 0, holders_synced_block = CASE WHEN holders_synced_block IS NULL THEN NULL ELSE LEAST(holders_synced_block, ${before}) END
    WHERE l.chain_id = ${cid}`;
  await db`
    UPDATE bb_launches l SET sqrt_price_x96 = s.sqrt_price_x96, tick = s.tick, last_swap_block = s.block_number, last_swap_log = s.log_index
      FROM (SELECT DISTINCT ON (token) token, sqrt_price_x96, tick, block_number, log_index FROM bb_launch_swaps
             WHERE chain_id = ${cid} ORDER BY token, block_number DESC, log_index DESC) s
     WHERE l.chain_id = ${cid} AND l.token = s.token`;
  await db`DELETE FROM bb_token_holders WHERE chain_id = ${cid}`;
  await db`
    INSERT INTO bb_token_holders (chain_id, token, holder, balance, first_block, last_block)
    SELECT ${cid}, token, holder, sum(delta), min(block_number), max(block_number) FROM (
      SELECT token, from_addr AS holder, -value AS delta, block_number FROM bb_token_transfers WHERE chain_id = ${cid} AND from_addr <> ${ZERO_ADDR}
      UNION ALL
      SELECT token, to_addr AS holder, value AS delta, block_number FROM bb_token_transfers WHERE chain_id = ${cid} AND to_addr <> ${ZERO_ADDR}
    ) legs GROUP BY token, holder ORDER BY token, holder`;
  const cfg = launchpad(chain);
  const excluded = [cfg.v4.poolManager, cfg.v4.positionManager, cfg.locker!, cfg.factory!, cfg.v4.universalRouter, cfg.v4.permit2, ZERO_ADDR, DEAD_ADDR].map((a) => a.toLowerCase());
  await db`
    UPDATE bb_launches l SET holders = h.n FROM (
      SELECT token, count(*)::int AS n FROM bb_token_holders WHERE chain_id = ${cid} AND balance > 0 AND NOT (holder = ANY(${excluded}::text[])) GROUP BY token
    ) h WHERE l.chain_id = ${cid} AND l.token = h.token`;
  if (apps.length) {
    await db`
      UPDATE bb_pair_applications a SET paid_usd = s.total,
        status = CASE WHEN a.status = 'paid' AND s.total < a.fee_usd * ${1 - PAIR_FEE_TOLERANCE} THEN 'open' ELSE a.status END,
        paid_at = CASE WHEN a.status = 'paid' AND s.total < a.fee_usd * ${1 - PAIR_FEE_TOLERANCE} THEN NULL ELSE a.paid_at END,
        payment_reorg = s.total < a.fee_usd * ${1 - PAIR_FEE_TOLERANCE}
          OR EXISTS (SELECT 1 FROM bb_pair_burns pending WHERE pending.application_id = a.id AND pending.valuation_pending)
      FROM (SELECT a2.id, COALESCE((SELECT sum(b.usd) FROM bb_pair_burns b WHERE b.application_id = a2.id), 0) AS total
              FROM bb_pair_applications a2 WHERE a2.id = ANY(${apps.map((a) => a.application_id)}::bigint[])) s
      WHERE a.id = s.id`;
  }
  await db`DELETE FROM bb_launch_blocks WHERE chain_id = ${cid} AND block_number >= ${from}`;
  // A receipt can discover a reorg before the poller runs. Keep points/payment consumers in recovery until the
  // old fully scanned cursor is replayed, even if the replacement head temporarily lies below it.
  await db`
    UPDATE bb_launch_sync_cursor SET
      rebuilding_until = CASE WHEN cursor_block >= ${from} THEN GREATEST(rebuilding_until, cursor_block) ELSE rebuilding_until END,
      cursor_block = LEAST(cursor_block, ${before}), reorg_generation = reorg_generation + 1
    WHERE chain_id = ${cid}`;
  // Earlier transfers can change later-season holdings/first buys. Invalidate every computed season, preserving
  // its authored rules and publication window. These locks follow chain-cursor locks, as in computeSeason.
  await db`SELECT id FROM bb_seasons ORDER BY id FOR UPDATE`;
  await db`UPDATE bb_seasons SET reorg_invalidated_at = now(), computed_at = NULL, computed_until = NULL WHERE computed_at IS NOT NULL OR computed_until IS NOT NULL OR reorg_invalidated_at IS NOT NULL`;
  await db`DELETE FROM bb_points WHERE season_id IN (SELECT id FROM bb_seasons WHERE reorg_invalidated_at IS NOT NULL)`;
  await db`INSERT INTO bb_launch_reorgs (chain_id, from_block, old_cursor, observed_head, reason) VALUES (${cid}, ${from}, ${cursor.cursor_block}, ${head}, ${reason})`;
}
