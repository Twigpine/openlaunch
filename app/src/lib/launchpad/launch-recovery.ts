import "server-only";
import { maybeDb } from "@/lib/db";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import type { Hex } from "viem";

export type LaunchRecovery = { tx_hash: Hex; reason: "reorg" | "rebuilding" };

/** Only the indexer creates these records; arbitrary token URLs remain genuine 404s. */
export async function getLaunchRecovery(chain: ChainKey, token: string): Promise<LaunchRecovery | null> {
  const db = maybeDb();
  if (!db) return null;
  const rows = await db<LaunchRecovery[]>`SELECT tx_hash, reason FROM bb_launch_recovery WHERE chain_id=${chainIdOf(chain)} AND token=${token.toLowerCase()}`;
  return rows[0] ?? null;
}

/** One database snapshot avoids a false 404 while reinclusion replaces a tombstone with a launch. */
export async function isKnownLaunchRoute(chain: ChainKey, token: string): Promise<boolean> {
  const db = maybeDb();
  if (!db) return false;
  const [row] = await db<{ known: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM bb_launches WHERE chain_id=${chainIdOf(chain)} AND token=${token.toLowerCase()})
        OR EXISTS(SELECT 1 FROM bb_launch_recovery WHERE chain_id=${chainIdOf(chain)} AND token=${token.toLowerCase()}) AS known`;
  return row?.known ?? false;
}
