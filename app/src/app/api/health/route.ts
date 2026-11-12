import { NextResponse } from "next/server";
import { chainKeyOf, chainKeyOr, DEFAULT_CHAIN } from "@/lib/chainPublic";
import { dbConfigured, maybeDb } from "@/lib/db";
import { LAUNCHPAD_CONFIGURED, launchpad, CONFIGURED_CHAINS } from "@/lib/launchpad/config";
import { syncLagAlertBlocks } from "@/lib/config";
import { blockNumber, healthBody, type SyncHealthInput } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fly health check + a cheap status line. One `select 1` (2s budget) and one single-row read; no RPC. */
const DB_TIMEOUT_MS = 2000;
let lastAlertKey = "";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function GET() {
  let dbOk = false;
  let sync: SyncHealthInput | null = null;
  let chains: SyncHealthInput[] = [];
  const sql = maybeDb();
  if (sql) {
    try {
      await withTimeout(sql`select 1 as ok`, DB_TIMEOUT_MS);
      dbOk = true;
      try {
        const rows = await withTimeout(
          sql<{ chain_id: number; cursor_block: bigint; head_block: bigint | null; last_run_at: string | null; last_error: string | null }[]>`
            select chain_id, cursor_block, head_block, last_run_at, last_error from bb_launch_sync_cursor order by chain_id desc`,
          DB_TIMEOUT_MS,
        );
        chains = rows.flatMap((r) => {
          const chain = chainKeyOf(r.chain_id);
          // Stored diagnostics (including older rows) may contain credentials outside URLs.
          return chain && launchpad(chain).configured ? [{ chain, cursor_block: blockNumber(r.cursor_block), head_block: blockNumber(r.head_block), last_run_at: r.last_run_at, last_error: r.last_error ? "sync_failed" : null }] : [];
        });
        // a configured chain with no cursor row has never been indexed (its deploy block is unset, or the loop is off): say so
        for (const k of CONFIGURED_CHAINS) if (!chains.some((c) => c.chain === k)) chains.push({ chain: k, cursor_block: null, head_block: null, last_run_at: null, last_error: `never indexed: the sync loop has not run for ${k} (LAUNCH_DEPLOY_BLOCK for ${k} unset, or LAUNCH_SYNC_LOOP off)` });
        sync = chains[0] ?? null;
      } catch {
        // pre-migration
      }
    } catch (err) {
      console.error("[health] db probe failed:", err instanceof Error ? err.message : err);
    }
  }
  const { status, body } = healthBody({ dbConfigured: dbConfigured(), dbOk, chain: Boolean(process.env.BASE_RPC_URL?.trim()), launchpad: LAUNCHPAD_CONFIGURED, sync, chains, lagAlertBlocks: (chain) => syncLagAlertBlocks(chainKeyOr(chain, DEFAULT_CHAIN)) });
  const key = body.alerts.join(",");
  if (key !== lastAlertKey) {
    if (key) console.error(`[alert] health ok=false ${key} cursor=${body.sync.cursor_block} head=${body.sync.head_block} last_error=${body.sync.last_error ?? "-"}`);
    else if (lastAlertKey) console.log("[alert] health recovered");
    lastAlertKey = key;
  }
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
