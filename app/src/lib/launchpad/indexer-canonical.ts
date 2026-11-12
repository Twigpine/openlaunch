import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Log } from "viem";
import { publicClient } from "@/lib/chain";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import type { Db } from "@/lib/db";
import { withIndexLock } from "./indexer-lock";
import { rollbackChain } from "./indexer-reorg-db";

type Block = { number: bigint; hash: string; timestamp: bigint };
type State = { cursor_block: bigint; reorg_version: number; reorg_generation: bigint; rebuilding_until: bigint | null };
type Observation = { chain: ChainKey; db: Db; blocks: Map<bigint, Block> };
const observations = new AsyncLocalStorage<Observation>();
const seenGenerations = new Map<ChainKey, bigint>();

async function readBlock(chain: ChainKey, number: bigint): Promise<Block> {
  const b = await publicClient(chain).getBlock({ blockNumber: number });
  if (b.number !== number || !b.hash || !/^0x[0-9a-f]{64}$/i.test(b.hash)) throw new Error("canonical block unavailable");
  return { number, hash: b.hash.toLowerCase(), timestamp: b.timestamp };
}

/** A block is checked once per ingestion transaction, never cached across forks. */
export async function observeBlock(chain: ChainKey, number: bigint): Promise<Block> {
  const context = observations.getStore();
  if (!context || context.chain !== chain) throw new Error("canonical index context required");
  const found = context.blocks.get(number);
  if (found) return found;
  const block = await readBlock(chain, number);
  const [previous] = await context.db<{ block_hash: string }[]>`
    SELECT block_hash FROM bb_launch_blocks WHERE chain_id = ${chainIdOf(chain)} AND block_number = ${number}`;
  if (previous && previous.block_hash !== block.hash) throw new Error("chain changed during indexing");
  context.blocks.set(number, block);
  return block;
}

export async function observeLog(chain: ChainKey, log: Pick<Log, "blockNumber" | "blockHash" | "removed">): Promise<Block> {
  if (log.removed || log.blockNumber === null || !log.blockHash) throw new Error("unmined or removed index event");
  const block = await observeBlock(chain, log.blockNumber);
  if (block.hash !== log.blockHash.toLowerCase()) throw new Error("event is not in the canonical block");
  return block;
}

async function state(db: Db, cid: number): Promise<State> {
  const [row] = await db<State[]>`
    SELECT cursor_block, reorg_version, reorg_generation, rebuilding_until FROM bb_launch_sync_cursor WHERE chain_id = ${cid} FOR UPDATE`;
  if (!row) throw new Error("index state unavailable");
  return row;
}

/** Find the last checkpoint whose ancestry still exists. Sparse checkpoints include every event-bearing block. */
async function reconcile(db: Db, chain: ChainKey, deploy: bigint, head: bigint): Promise<boolean> {
  const cid = chainIdOf(chain);
  const [tip] = await db<{ block_number: bigint; block_hash: string }[]>`
    SELECT block_number, block_hash FROM bb_launch_blocks WHERE chain_id = ${cid} ORDER BY block_number DESC LIMIT 1`;
  if (!tip) return false;
  let candidate = tip;
  if (tip.block_number > head) {
    const [earlier] = await db<typeof tip[]>`
      SELECT block_number, block_hash FROM bb_launch_blocks WHERE chain_id = ${cid} AND block_number <= ${head} ORDER BY block_number DESC LIMIT 1`;
    // A lagging node is not evidence that previously observed blocks were removed.
    if (!earlier || (await readBlock(chain, earlier.block_number)).hash === earlier.block_hash) throw new Error("RPC head is behind indexed history");
    candidate = earlier;
  } else if ((await readBlock(chain, tip.block_number)).hash === tip.block_hash) return false;

  let low = deploy - 1n;
  let high = candidate.block_number - 1n;
  // A matching hash commits to its ancestors. Binary search checkpoint heights,
  // including forks deeper than the normal log overlap, without a linear RPC walk.
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const [row] = await db<typeof tip[]>`
      SELECT block_number, block_hash FROM bb_launch_blocks
       WHERE chain_id = ${cid} AND block_number > ${low} AND block_number <= ${mid} ORDER BY block_number DESC LIMIT 1`;
    if (!row) {
      const [next] = await db<typeof tip[]>`
        SELECT block_number, block_hash FROM bb_launch_blocks
         WHERE chain_id = ${cid} AND block_number > ${mid} AND block_number <= ${high} ORDER BY block_number ASC LIMIT 1`;
      if (!next) break;
      if ((await readBlock(chain, next.block_number)).hash === next.block_hash) low = next.block_number;
      else high = next.block_number - 1n;
    } else if ((await readBlock(chain, row.block_number)).hash === row.block_hash) low = row.block_number;
    else high = row.block_number - 1n;
  }
  await rollbackChain(db, chain, low + 1n, "reorg", head);
  return true;
}

/** One atomic unit: reconcile, apply facts, verify the observed ancestry again, then checkpoint and commit. */
export async function withCanonicalIndex<T>(chain: ChainKey, deploy: bigint, clearCaches: () => void,
  work: (db: Db, head: bigint, current: State) => Promise<T>): Promise<T> {
  return withIndexLock(chain, async (db) => {
    const cid = chainIdOf(chain);
    await db`INSERT INTO bb_launch_sync_cursor (chain_id) VALUES (${cid}) ON CONFLICT DO NOTHING`;
    let current = await state(db, cid);
    const head = await publicClient(chain).getBlockNumber();
    if (head < deploy) throw new Error("RPC head is behind indexed history");
    if (current.reorg_version !== 0 && current.reorg_version !== 1) throw new Error("unsupported index recovery version");
    if (current.reorg_version === 0) {
      const [old] = await db<{ n: bigint }[]>`
        SELECT GREATEST(${current.cursor_block},
          COALESCE((SELECT max(block_number) FROM bb_launches WHERE chain_id = ${cid}), 0),
          COALESCE((SELECT max(block_number) FROM bb_launch_swaps WHERE chain_id = ${cid}), 0),
          COALESCE((SELECT max(block_number) FROM bb_launch_fee_events WHERE chain_id = ${cid}), 0),
          COALESCE((SELECT max(block_number) FROM bb_token_transfers WHERE chain_id = ${cid}), 0),
          COALESCE((SELECT max(block_number) FROM bb_boosts WHERE chain_id = ${cid}), 0),
          COALESCE((SELECT max(block_number) FROM bb_pair_burns WHERE chain_id = ${cid}), 0)) AS n`;
      if (old.n > head) throw new Error("RPC head is behind legacy indexed history");
      if (old.n >= deploy) {
        await rollbackChain(db, chain, deploy, "rebuilding", head);
        await db`UPDATE bb_launch_sync_cursor SET cursor_block = ${deploy - 1n}, rebuilding_until = ${head} WHERE chain_id = ${cid}`;
      }
      await db`UPDATE bb_launch_sync_cursor SET reorg_version = 1 WHERE chain_id = ${cid}`;
      current = await state(db, cid);
    }
    if (await reconcile(db, chain, deploy, head)) current = await state(db, cid);
    if (current.cursor_block > head) throw new Error("RPC head is behind indexed history");
    // Process-local transaction/receipt/height caches cannot survive another
    // machine's rollback. Comparing the persisted generation avoids relying on local notifications.
    if (seenGenerations.get(chain) !== current.reorg_generation) {
      clearCaches();
      seenGenerations.set(chain, current.reorg_generation);
    }
    return observations.run({ chain, db, blocks: new Map() }, async () => {
      const [anchor] = await db<{ block_number: bigint }[]>`
        SELECT block_number FROM bb_launch_blocks WHERE chain_id = ${cid} ORDER BY block_number DESC LIMIT 1`;
      if (anchor) await observeBlock(chain, anchor.block_number);
      const value = await work(db, head, current);
      const blocks = [...observations.getStore()!.blocks.values()].sort((a, b) => a.number < b.number ? -1 : 1);
      if (blocks.length) {
        // Recheck all observed hashes, not only the tip: reject inconsistent RPC
        // responses as well as a fork arriving while the range was being applied.
        for (const b of blocks) if ((await readBlock(chain, b.number)).hash !== b.hash) throw new Error("chain changed before index commit");
        for (const b of blocks) await db`
          INSERT INTO bb_launch_blocks (chain_id, block_number, block_hash) VALUES (${cid}, ${b.number}, ${b.hash})
          ON CONFLICT (chain_id, block_number) DO NOTHING`;
      }
      return value;
    });
  }).catch((error) => {
    // SQL rolls back, but process-local receipt/transaction caches do not. A
    // failed range may have populated them from a fork that never committed.
    clearCaches();
    seenGenerations.delete(chain);
    throw error;
  });
}
