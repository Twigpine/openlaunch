import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as indexer from "../src/lib/launchpad/indexer";
import { launchpad } from "../src/lib/launchpad/config";
import { systemAddressesOf, holderRebuildSql } from "../src/lib/launchpad/holder-system-addresses";
import { A, ALICE, F, L, PM, ZERO, DEAD, hash, launched, standardModel, transfer, type ChainModel } from "./reorg-db-test-model";
import type { Db } from "./reorg-db-test-db";

type Context = {
  check: (label: string, run: () => Promise<unknown>) => Promise<void>;
  database: (label: string) => Promise<Db>;
  activate: (db: Db, model: ChainModel) => void;
  indexedOld: (label: string) => Promise<{ db: Db; model: ChainModel }>;
  compareOracle: (label: string, db: Db, model: ChainModel) => Promise<unknown>;
};

export async function indexerAuditDbChecks({ check, database, activate, indexedOld, compareOracle }: Context) {
  await check("a collection receipt before its launch is deferred and later counted exactly once", async () => {
    const db = await database("earlycollect"), model = standardModel();
    activate(db, model);
    const early = await indexer.applyLaunchTx("base", hash("old-fees"));
    assert.equal(early.fees, 0);
    assert.equal((await db`SELECT * FROM bb_launch_fee_events WHERE kind = 'collected'`).length, 0);
    assert.equal((await db`SELECT * FROM bb_launches`).length, 0);
    await indexer.applyLaunchTx("base", hash("common-launch"));
    await indexer.pollLaunches("base");
    await indexer.applyLaunchTx("base", hash("old-fees"));
    const [row] = await db`SELECT fees_quote_collected::text, fees_token_collected::text FROM bb_launches WHERE token=${A}`;
    assert.equal(row.fees_quote_collected, "7");
    assert.equal(row.fees_token_collected, "3");
    assert.equal((await db`SELECT * FROM bb_launch_fee_events WHERE kind='collected'`).length, 1);
    return compareOracle("earlycollect", db, model);
  });

  await check("holder backfill lowers first_block after newer transfers were indexed live", async () => {
    const db = await database("holderfirst"), model = standardModel();
    model.events.old = [launched(), transfer(101, A, ZERO, ALICE, 50n, "early-holder", 0),
      transfer(1002, A, ZERO, ALICE, 10n, "later-holder", 0)];
    model.head = 1004;
    activate(db, model);
    await indexer.applyLaunchTx("base", hash("common-launch"));
    // A known launch can still need historical holder backfill while live polling is near the tip.
    await db`UPDATE bb_launch_sync_cursor SET cursor_block=1000, head_block=1004 WHERE chain_id=8453`;
    await indexer.pollLaunches("base");
    assert.equal(BigInt((await db`SELECT first_block FROM bb_token_holders WHERE token=${A} AND holder=${ALICE}`)[0].first_block), 1002n);
    await indexer.backfillHolders("base");
    const [row] = await db`SELECT first_block, balance::text FROM bb_token_holders WHERE token=${A} AND holder=${ALICE}`;
    assert.equal(BigInt(row.first_block), 101n);
    assert.equal(row.balance, "60");
    await indexer.backfillHolders("base");
    assert.deepEqual((await db`SELECT first_block, balance::text FROM bb_token_holders WHERE token=${A} AND holder=${ALICE}`)[0], row);
  });

  await check("individual transaction receipts recover a capped token block without skipping balances", async () => {
    const db = await database("individualreceipts"), model = standardModel();
    model.events.old = [launched(), transfer(100, A, ZERO, PM, 1000000n, "common-launch", 1),
      transfer(101, A, PM, ALICE, 50n, "capped-transfer", 0)];
    const originalBlock = model.block.bind(model), originalRequest = model.request.bind(model);
    model.block = (height, branch = model.branch) => ({ ...originalBlock(height, branch),
      transactions: [...new Set((model.events[branch] ?? []).filter((event) => event.height === height).map((event) => hash(event.tx)))] });
    let recovered = 0;
    model.request = async (method, params) => {
      if (method === "eth_getLogs") {
        const filter = params[0] as { address: string | string[]; fromBlock: string; toBlock: string };
        const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
        if (addresses.includes(A) && BigInt(filter.fromBlock) <= 101n && BigInt(filter.toBlock) >= 101n) throw Error("query returned more than 10000 results");
      }
      if (method === "eth_getTransactionReceipt" && params[0] === hash("capped-transfer")) recovered++;
      return originalRequest(method, params);
    };
    activate(db, model);
    await indexer.pollLaunches("base");
    assert.ok(recovered > 0);
    assert.equal((await db`SELECT balance::text FROM bb_token_holders WHERE token=${A} AND holder=${ALICE}`)[0].balance, "50");
    model.request = originalRequest;
    return compareOracle("individualreceipts", db, model);
  });

  await check("configured holder rebuild excludes Arc and Elysium protocol addresses and rejects missing chains", async () => {
    const { db } = await indexedOld("holderrebuild");
    const exclusions: Record<string, string[]> = { "8453": [...indexer.systemAddresses("base"), ZERO, DEAD] };
    for (const [chain, cid] of [["arc", 5042], ["elysium", 99901]] as const) {
      const cfg = { ...launchpad(chain), factory: F as `0x${string}`, locker: L as `0x${string}` };
      const addresses = [cfg.v4.positionManager, cfg.v4.universalRouter, cfg.v4.poolManager].map((a) => a.toLowerCase());
      exclusions[cid] = [...systemAddressesOf(cfg), ZERO, DEAD];
      await db`INSERT INTO bb_launches SELECT (jsonb_populate_record(NULL::bb_launches,
        to_jsonb(l) || jsonb_build_object('chain_id', ${cid}::int, 'supply', 400, 'holders', 99))).*
        FROM bb_launches l WHERE chain_id=8453 AND token=${A}`;
      for (const [i, holder] of [...addresses, ALICE].entries()) {
        await db`INSERT INTO bb_token_transfers (chain_id,token,tx_hash,log_index,from_addr,to_addr,value,block_number,block_time)
          VALUES (${cid},${A},${hash(`rebuild-${cid}-${i}`)},0,${ZERO},${holder},100,100,now())`;
      }
    }
    // A Base-only protocol address is an ordinary address on Arc: exclusions must be keyed by chain.
    await db`INSERT INTO bb_token_transfers (chain_id,token,tx_hash,log_index,from_addr,to_addr,value,block_number,block_time)
      VALUES (5042,${A},${hash("cross-chain-holder")},0,${ZERO},${PM},1,100,now())`;
    const template = readFileSync(new URL("./rebuild-holders.sql", import.meta.url), "utf8");
    const connection = await db.reserve();
    try {
      await assert.rejects(connection.unsafe(holderRebuildSql(template, { "8453": exclusions[8453] })), /does not cover every stored launch chain/);
      await connection`ROLLBACK`;
      assert.deepEqual((await db`SELECT holders FROM bb_launches WHERE chain_id IN (5042,99901) ORDER BY chain_id`).map((r) => r.holders), [99, 99]);
      const generated = holderRebuildSql(template, exclusions);
      await connection.unsafe(generated);
      assert.deepEqual((await db`SELECT holders FROM bb_launches WHERE chain_id IN (5042,99901) ORDER BY chain_id`).map((r) => r.holders), [2, 1]);
      await connection.unsafe(generated);
      assert.deepEqual((await db`SELECT holders FROM bb_launches WHERE chain_id IN (5042,99901) ORDER BY chain_id`).map((r) => r.holders), [2, 1]);
    } finally {
      await connection`ROLLBACK`.catch(() => {});
      connection.release();
    }
  });

  await check("holder rebuild waits before transfer locks so an active index writer can complete", async () => {
    const { db } = await indexedOld("holderlocks");
    const generated = holderRebuildSql(readFileSync(new URL("./rebuild-holders.sql", import.meta.url), "utf8"),
      { "8453": [...indexer.systemAddresses("base"), ZERO, DEAD] });
    const writer = await db.reserve(), rebuilder = await db.reserve();
    let rebuilding: Promise<unknown> | undefined;
    try {
      await writer`BEGIN`;
      await writer`LOCK TABLE bb_launch_swaps, bb_launch_fee_events, bb_launches IN ROW EXCLUSIVE MODE`;
      const [{ pid }] = await rebuilder`SELECT pg_backend_pid() AS pid`;
      rebuilding = Promise.resolve(rebuilder.unsafe(generated));
      // Observe the real PostgreSQL lock wait rather than guessing from a fixed delay.
      const until = Date.now() + 3_000;
      while (true) {
        const waiting = await db`SELECT 1 FROM pg_locks WHERE pid=${pid} AND relation='bb_launches'::regclass AND NOT granted`;
        if (waiting.length) break;
        assert.ok(Date.now() < until, "rebuild must wait on launches");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal((await db`SELECT 1 FROM pg_locks WHERE pid=${pid} AND relation='bb_token_transfers'::regclass AND granted`).length, 0);
      await writer`INSERT INTO bb_token_transfers (chain_id,token,tx_hash,log_index,from_addr,to_addr,value,block_number,block_time)
        VALUES (8453,${A},${hash("lock-order-transfer")},0,${ZERO},${ALICE},1,102,now())`;
      await writer`COMMIT`;
      await rebuilding;
      assert.equal((await db`SELECT balance::text FROM bb_token_holders WHERE token=${A} AND holder=${ALICE}`)[0].balance, "51");
    } finally {
      await writer`ROLLBACK`.catch(() => {});
      await rebuilding?.catch(() => {});
      await rebuilder`ROLLBACK`.catch(() => {});
      writer.release(); rebuilder.release();
    }
  });
}
