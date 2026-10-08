import "server-only";
import { maybeDb } from "@/lib/db";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { DEAD_ADDR, TOP_HOLDERS, ZERO_ADDR, creatorActivity, holderTags, shareBps, sniperSummary, trustNotes, type HolderTag } from "./holders";
import { systemAddresses } from "./indexer";

export type HolderRow = { address: string; balance: string; bps: number; tags: HolderTag[] };
export type HolderPanel = {
  synced: boolean; // false while the token's transfer history is still being backfilled
  holders: number;
  supply: string;
  top: HolderRow[];
  top10Bps: number;
  poolBps: number;
  creator: { address: string; bps: number; bought: string; sold: string; sells: number };
  sniper: { wallets: number; bps: number };
  notes: { level: "warn" | "info" | "good"; text: string }[];
};

/**
 * How many swaps the holder panel scans. Sniper detection only needs the
 * earliest swaps (launch block … +SNIPER_BLOCKS), so oldest-first keeps it
 * exact while the table stays bounded: without a LIMIT one hot token
 * materializes every swap per cache miss (100k rows → 100k BigInt parses).
 * Creator totals on hyper-traded tokens are a lower bound past this cap;
 * the panel stays available instead of OOMing.
 */
export const HOLDER_SWAPS_LIMIT = 5000;

/** Holder distribution + creator / sniper facts for one launch. Cheap: two indexed queries + one bounded scan of its earliest swaps. */
export async function getHolderPanel(chain: ChainKey, token: string): Promise<HolderPanel | null> {
  const db = maybeDb();
  if (!db) return null;
  const cid = chainIdOf(chain);
  const t = token.toLowerCase();
  const [l] = await db<{ launcher: string; supply: string; block_number: bigint; holders: number; holders_synced_block: bigint | null }[]>`
    SELECT launcher, supply::text AS supply, block_number, holders, holders_synced_block FROM bb_launches WHERE chain_id = ${cid} AND token = ${t}`;
  if (!l) return null;
  const supply = BigInt(l.supply);
  const system = systemAddresses(chain);
  const excluded = [...system, ZERO_ADDR, DEAD_ADDR];
  const [rows, swaps, pool] = await Promise.all([
    db<{ holder: string; balance: string }[]>`
      SELECT h.holder, h.balance::text AS balance FROM bb_token_holders h
       WHERE h.chain_id = ${cid} AND h.token = ${t} AND h.balance > 0 AND NOT (h.holder = ANY(${excluded}))
       ORDER BY h.balance DESC LIMIT ${TOP_HOLDERS}`, // qualified: a bare "balance" would sort the ::text alias
    db<{ trader: string | null; is_buy: boolean; block_number: bigint; amount1: string }[]>`
      SELECT trader, is_buy, block_number, amount1::text AS amount1 FROM bb_launch_swaps WHERE chain_id = ${cid} AND token = ${t}
      ORDER BY block_number ASC LIMIT ${HOLDER_SWAPS_LIMIT}`,
    db<{ balance: string }[]>`
      SELECT COALESCE(sum(balance), 0)::text AS balance FROM bb_token_holders WHERE chain_id = ${cid} AND token = ${t} AND holder = ANY(${system})`,
  ]);
  const lite = swaps.map((s) => ({ trader: s.trader, is_buy: s.is_buy, block_number: s.block_number, token_amount: BigInt(s.amount1) }));
  const sn = sniperSummary(lite, l.block_number, supply);
  const creator = creatorActivity(lite, l.launcher);
  const ctx = { launcher: l.launcher, system, snipers: new Set(sn.wallets) };
  const top = rows.map((r) => ({ address: r.holder, balance: r.balance, bps: shareBps(BigInt(r.balance), supply), tags: holderTags(r.holder, BigInt(r.balance), supply, ctx) }));
  const [creatorRow] = await db<{ balance: string }[]>`SELECT balance::text AS balance FROM bb_token_holders WHERE chain_id = ${cid} AND token = ${t} AND holder = ${l.launcher.toLowerCase()}`;
  const creatorBps = shareBps(BigInt(creatorRow?.balance ?? "0"), supply);
  const top10Bps = top.reduce((a, r) => a + r.bps, 0);
  const poolBps = shareBps(BigInt(pool[0]?.balance ?? "0"), supply);
  const synced = l.holders_synced_block !== null && BigInt(l.holders_synced_block) > BigInt(l.block_number) + 1_000_000n; // SYNCED_FOREVER sentinel
  return {
    synced,
    holders: l.holders,
    supply: l.supply,
    top,
    top10Bps,
    poolBps,
    creator: { address: l.launcher, bps: creatorBps, bought: creator.bought.toString(), sold: creator.sold.toString(), sells: creator.sells },
    sniper: { wallets: sn.wallets.length, bps: sn.boughtBps },
    notes: trustNotes({ holders: l.holders, creatorBps, creatorSells: creator.sells, sniperBps: sn.boughtBps, sniperWallets: sn.wallets.length, top10Bps, poolBps }),
  };
}
