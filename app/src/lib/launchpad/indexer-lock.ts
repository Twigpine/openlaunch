import "server-only";
import { maybeDb, type Db } from "@/lib/db";
import type { ChainKey } from "@/lib/chainPublic";

/** Retryable writer contention, distinct from a failed RPC or database operation. */
export class IndexLockBusyError extends Error {
  constructor() { super("canonical index is busy"); this.name = "IndexLockBusyError"; }
}

/** All canonical event writers use one transaction/lock per chain, across processes. */
export async function withIndexLock<T>(chain: ChainKey, work: (db: Db) => Promise<T>): Promise<T> {
  const pool = maybeDb();
  if (!pool) throw new Error("index database unavailable");
  return pool.begin(async (sql) => {
    const db = sql as unknown as Db;
    // RPC work can hold this lock beyond the table-lock budget. Bound only the
    // wait to leave room within the sync client's 15s request deadline; the
    // transaction's table/RPC work can still take longer, so a timeout is pending.
    await db`SET LOCAL lock_timeout = '8s'`;
    try {
      await db`SELECT pg_advisory_xact_lock(hashtext(${`launch-index:${chain}`}))`;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") throw new IndexLockBusyError();
      throw error;
    }
    await db`SET LOCAL lock_timeout = '5s'`;
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
