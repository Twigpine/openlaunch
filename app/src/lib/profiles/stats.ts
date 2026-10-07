import "server-only";
import { maybeDb } from "@/lib/db";

/** On-chain facts for one wallet, across every chain: what it launched, how many trades it made, who holds its tokens. */
export type WalletFacts = { launches: number; trades: number; holders: number };

/** Launches, holders of those launches, and trades for one wallet, across every chain. */
export async function walletFacts(wallet: string): Promise<WalletFacts> {
  const db = maybeDb();
  if (!db) return { launches: 0, trades: 0, holders: 0 };
  const w = wallet.toLowerCase();
  const [r] = await db<{ launches: number; holders: number; trades: number }[]>`
    SELECT (SELECT count(*)::int FROM bb_launches WHERE launcher = ${w}) AS launches,
           (SELECT COALESCE(sum(holders), 0)::int FROM bb_launches WHERE launcher = ${w}) AS holders,
           (SELECT count(*)::int FROM bb_launch_swaps WHERE trader = ${w}) AS trades`;
  return r ?? { launches: 0, trades: 0, holders: 0 };
}
