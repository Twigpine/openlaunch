/**
 * Pure shaping for GET /api/health (no `server-only` so it is unit-testable).
 * Fly's http check hits this every 15s: 200 when the process can serve, 503
 * ONLY when a database is configured but unreachable. Indexer lag / errors are
 * reported as ok:false + alerts[] but still 200 (a stale list ≠ a down site).
 */
import { DEFAULT_CHAIN } from "./chainKeys.ts";

export type SyncHealthInput = { chain?: string; cursor_block: number | null; head_block: number | null; last_run_at: string | null; last_error: string | null };
/** The lag limit per chain (block times differ), or one number for every chain. */
export type LagAlertBlocks = number | ((chain: string) => number);

export type HealthInput = {
  dbConfigured: boolean;
  dbOk: boolean;
  chain: boolean;
  launchpad: boolean;
  sync?: SyncHealthInput | null;
  /** additional chains (first one goes in `sync` for backwards compatibility) */
  chains?: SyncHealthInput[];
  lagAlertBlocks?: LagAlertBlocks;
  /** The running release and the commit it was built from (lib/version.ts); null when unknown. */
  version?: string | null;
  commit?: string | null;
};

export type HealthBody = {
  ok: boolean;
  /** What is running: the release (package.json) and its commit. Both public: the repository and its tags are. */
  version: string | null;
  commit: string | null;
  db: boolean;
  chain: boolean;
  launchpad: boolean;
  sync: { cursor_block: number | null; head_block: number | null; lag_blocks: number | null; last_run_at: string | null; last_error: string | null };
  chains: { chain: string; cursor_block: number | null; head_block: number | null; lag_blocks: number | null; last_error: string | null }[];
  alerts: string[];
};

export const DEFAULT_LAG_ALERT_BLOCKS = 200;

export function lagBlocks(head: number | null, cursor: number | null): number | null {
  if (head === null || cursor === null) return null;
  return Math.max(0, head - cursor);
}

export function blockNumber(v: bigint | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function healthBody(i: HealthInput): { status: number; body: HealthBody } {
  const lagLimitFor = (chain: string) => (typeof i.lagAlertBlocks === "function" ? i.lagAlertBlocks(chain) : (i.lagAlertBlocks ?? DEFAULT_LAG_ALERT_BLOCKS));
  const s = i.sync ?? { cursor_block: null, head_block: null, last_run_at: null, last_error: null };
  const lag = lagBlocks(s.head_block, s.cursor_block);
  const alerts: string[] = [];
  if (i.dbConfigured && !i.dbOk) alerts.push("db_unreachable");
  const all = i.chains ?? (i.sync ? [i.sync] : []);
  const chains = all.map((c) => ({ chain: c.chain ?? DEFAULT_CHAIN, cursor_block: c.cursor_block, head_block: c.head_block, lag_blocks: lagBlocks(c.head_block, c.cursor_block), last_error: c.last_error }));
  if (i.dbConfigured && i.dbOk && i.launchpad) {
    for (const c of chains) {
      if (c.lag_blocks !== null && c.lag_blocks > lagLimitFor(c.chain) && !alerts.includes("sync_lag")) alerts.push("sync_lag");
      if (c.last_error && !alerts.includes("sync_error")) alerts.push("sync_error");
    }
  }
  const status = alerts.includes("db_unreachable") ? 503 : 200;
  return {
    status,
    body: {
      ok: alerts.length === 0,
      version: i.version ?? null,
      commit: i.commit ?? null,
      db: i.dbConfigured ? i.dbOk : false,
      chain: i.chain,
      launchpad: i.launchpad,
      sync: { cursor_block: s.cursor_block, head_block: s.head_block, lag_blocks: lag, last_run_at: s.last_run_at, last_error: s.last_error },
      chains,
      alerts,
    },
  };
}
