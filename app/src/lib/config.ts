import "server-only";

/** Server-only env knobs. Everything degrades to "feature off" when unset. */
function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : fallback;
}

import type { ChainKey } from "./chainKeys.ts";

// ── indexer ──────────────────────────────────────────────────────────────────
export const SYNC_CHUNK_BLOCKS = 2000n;
export const SYNC_MAX_CHUNKS_PER_CALL = 12;
/** Poller overlap: every run re-scans this many blocks behind the cursor (default 50). */
export function syncOverlapBlocks(): bigint {
  return BigInt(intEnv("SYNC_OVERLAP_BLOCKS", 50));
}
/**
 * /api/health reports an alert when head − cursor exceeds this many blocks. Block times differ ~20x across chains, so the
 * default is per chain and means about the same wall-clock lag (≈ 400s): Base 2s blocks, Robinhood ~0.1s, Arc ~0.5s, Elysium 0.1s.
 * SYNC_LAG_ALERT_BLOCKS (every chain) or SYNC_LAG_ALERT_BLOCKS_<CHAIN> overrides.
 */
const DEFAULT_LAG_ALERT_BLOCKS: Record<ChainKey, number> = { base: 200, robinhood: 4000, arc: 800, elysium: 4000 };
export function syncLagAlertBlocks(chain: ChainKey): number {
  return intEnv(`SYNC_LAG_ALERT_BLOCKS_${chain.toUpperCase()}`, intEnv("SYNC_LAG_ALERT_BLOCKS", DEFAULT_LAG_ALERT_BLOCKS[chain]));
}
