import "server-only";
import { maybeDb, type Db } from "@/lib/db";
import type { ChainKey } from "@/lib/chainPublic";

/** All canonical event writers use one transaction/lock per chain, across processes. */
export async function withIndexLock<T>(chain: ChainKey, work: (db: Db) => Promise<T>): Promise<T> {
  const pool = maybeDb();
  if (!pool) throw new Error("index database unavailable");
  return pool.begin(async (sql) => {
    const db = sql as unknown as Db;
    await db`SET LOCAL lock_timeout = '5s'`;
    await db`SELECT pg_advisory_xact_lock(hashtext(${`launch-index:${chain}`}))`;
    // Match the existing totals/USD maintenance scripts' table lock order.
    // Compatible across chains, but wait before touching launches if a rebuild
    // already owns SHARE locks on raw events.
    await db`LOCK TABLE bb_launch_swaps, bb_launch_fee_events, bb_launches IN ROW EXCLUSIVE MODE`;
    return work(db);
  }) as Promise<T>;
}

/** postgres.js transactions expose savepoint, not begin. Retain per-event atomicity. */
export async function indexAtomic<T>(db: Db, work: (db: Db) => Promise<T>): Promise<T> {
  const tx = db as unknown as { savepoint?: (fn: (sql: Db) => Promise<T>) => Promise<T> };
  if (tx.savepoint) return tx.savepoint(work);
  return db.begin((sql) => work(sql as unknown as Db)) as Promise<T>;
}
