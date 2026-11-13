import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getMock, resetMock } from "@/lib/db-mock";
import { applicantAction, expireStaleApplications, reviewApplication } from "./pairApplyServer";
import { pairsTick } from "./pairsServer";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const ready = { reorg_version: 1, reorg_generation: 0n, rebuilding_until: null };
function offline(t: TestContext) {
  resetMock();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline pair recovery test"); });
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
}

test("payment expiry takes the index lock and refuses partially rebuilt payment history", async (t) => {
  offline(t);
  const queries: string[] = [];
  getMock().query = async (sql) => {
    queries.push(sql);
    if (sql.includes("bb_launch_sync_cursor")) return [{ ...ready, rebuilding_until: 200n }];
    return [];
  };
  assert.equal(await expireStaleApplications(), 0);
  assert.ok(queries.findIndex((q) => q.includes("pg_advisory_xact_lock")) < queries.findIndex((q) => q.includes("bb_launch_sync_cursor")));
  assert.equal(queries.some((q) => q.includes("SET status = 'expired'")), false);
});

test("payment expiry resumes under the lock while preserving payment reconciliation rows", async (t) => {
  offline(t);
  let expired = false;
  getMock().query = async (sql) => {
    if (sql.includes("bb_launch_sync_cursor")) return [ready];
    if (sql.includes("SET status = 'expired'")) {
      assert.match(sql, /WHERE NOT a\.payment_reorg/);
      expired = true;
      return [{ id: 8 }];
    }
    return [];
  };
  assert.equal(await expireStaleApplications(), 1);
  assert.equal(expired, true);
});

async function againFixture(t: TestContext, changed: boolean) {
  offline(t);
  const previous = process.env.PAIRS_APPLY;
  process.env.PAIRS_APPLY = "on";
  t.after(() => { if (previous === undefined) delete process.env.PAIRS_APPLY; else process.env.PAIRS_APPLY = previous; });
  const app = { id: "7", chain_id: 8453, address: TOKEN, applicant: WALLET, code: "OL-7", status: "changes", reviews_used: 1,
    paid_at: new Date(Date.now() - 86_400_000), paid_usd: 200, fee_usd: 200, payment_reorg: false };
  const queries: string[] = [];
  getMock().query = async (sql) => {
    queries.push(sql);
    if (sql.includes("bb_launch_sync_cursor")) return [ready];
    if (sql.includes("SELECT * FROM bb_pair_applications")) return [{ ...app,
      ...(changed && sql.includes("FOR UPDATE") ? { paid_usd: 0, payment_reorg: true } : {}) }];
    if (sql.includes("SET status = 'paid'")) return [{ id: 7 }];
    return [];
  };
  const result = await applicantAction({ action: "again", id: 7, chain: "base", address: TOKEN, wallet: WALLET, nonce: "ab".repeat(16), ts: Date.now(), signature: "0x11" });
  return { result, queries };
}

test("another-review request rechecks payments after network precheck and rejects an intervening reorg", async (t) => {
  const { result, queries } = await againFixture(t, true);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.status, 409);
  assert.ok(queries.some((q) => q.includes("FOR UPDATE")));
  assert.equal(queries.some((q) => q.includes("SET status = 'paid'")), false);
});

test("another-review request succeeds only after the chain and application locks", async (t) => {
  const { result, queries } = await againFixture(t, false);
  assert.deepEqual(result, { ok: true, id: 7, code: "OL-7" });
  const chainLock = queries.findIndex((q) => q.includes("pg_advisory_xact_lock"));
  const appLock = queries.findIndex((q) => q.includes("FOR UPDATE"));
  const change = queries.findIndex((q) => q.includes("SET status = 'paid'"));
  assert.ok(chainLock >= 0 && appLock > chainLock && change > appLock);
});

let monitorClock = Date.now();
test("launch-pool monitor discards a health result when recovery changed its source generation", async (t) => {
  offline(t);
  const r = { chain_id: 8453, address: TOKEN, symbol: "TEST", status: "listed", status_by: "admin", status_at: new Date(Date.now() - 3 * 86_400_000),
    failing_since: new Date(Date.now() - 3 * 86_400_000), checked_at: new Date(), price_kind: "launch", price_pool: TOKEN, price_quote: WALLET, code_hash: null };
  let snapshots = 0;
  const queries: string[] = [];
  getMock().publicClient = { getCode: async () => "0x" }; // a failing read would normally start/sustain suspension
  getMock().query = async (sql) => {
    queries.push(sql);
    if (sql.includes("UPDATE bb_pairs SET checked_at = now()")) return [r];
    if (sql.includes("SELECT reorg_generation")) return [{ ...ready, reorg_generation: BigInt(snapshots++) }];
    return [];
  };
  await pairsTick(monitorClock += 61_000);
  assert.equal(snapshots, 2);
  assert.ok(queries.some((q) => q.includes("pg_advisory_xact_lock")));
  assert.ok(queries.some((q) => q.includes("UPDATE bb_pairs SET checked_at = NULL")));
  assert.equal(queries.some((q) => q.includes("UPDATE bb_pairs SET status =")), false);
  assert.equal(queries.some((q) => q.includes("INSERT INTO bb_pair_events")), false);
});

test("launch-pool monitor avoids price reads while its source is rebuilding", async (t) => {
  offline(t);
  let rpcReads = 0;
  let released = false;
  const checkedAt = new Date();
  getMock().publicClient = { getCode: async () => { rpcReads++; return "0x"; } };
  getMock().query = async (sql, values) => {
    if (sql.includes("UPDATE bb_pairs SET checked_at = now()")) return [{ chain_id: 8453, address: TOKEN, price_kind: "launch", checked_at: checkedAt }];
    if (sql.includes("SELECT reorg_generation")) return [{ ...ready, rebuilding_until: 200n }];
    if (sql.includes("UPDATE bb_pairs SET checked_at = NULL")) {
      assert.match(sql, /date_trunc\('milliseconds', checked_at\)/);
      assert.deepEqual(values, [8453, TOKEN, checkedAt]);
      released = true;
    }
    return [];
  };
  await pairsTick(monitorClock += 61_000);
  assert.equal(rpcReads, 0);
  assert.equal(released, true, "the current claim is eligible again after recovery");
});

for (const failure of ["cursor read", "advisory timeout"]) test(`pair monitor releases ${failure} and continues its claimed batch`, async (t) => {
  offline(t);
  const secondToken = "0x3333333333333333333333333333333333333333";
  const checkedAt = new Date();
  const row = { chain_id: 8453, symbol: "TEST", status: "listed", status_by: "admin", status_at: new Date(Date.now() - 3 * 86_400_000),
    failing_since: new Date(Date.now() - 3 * 86_400_000), checked_at: checkedAt, price_kind: "launch", code_hash: null };
  let snapshots = 0, locks = 0;
  const released: string[] = [], updated: string[] = [];
  getMock().publicClient = { getCode: async () => "0x" };
  getMock().query = async (sql, values) => {
    if (sql.includes("UPDATE bb_pairs SET checked_at = now()")) return [{ ...row, address: TOKEN }, { ...row, address: secondToken }];
    if (sql.includes("SELECT reorg_generation")) {
      if (++snapshots === 1 && failure === "cursor read") throw Error("synthetic cursor outage");
      return [ready];
    }
    if (sql.includes("pg_advisory_xact_lock") && ++locks === 1 && failure === "advisory timeout") throw { code: "55P03" };
    if (sql.includes("UPDATE bb_pairs SET checked_at = NULL")) {
      assert.match(sql, /date_trunc\('milliseconds', checked_at\)/);
      assert.deepEqual(values, [8453, TOKEN, checkedAt]);
      released.push(String(values[1]));
    }
    if (sql.includes("UPDATE bb_pairs SET status =")) {
      assert.match(sql, /date_trunc\('milliseconds', checked_at\)/);
      assert.ok(values.includes(secondToken));
      updated.push(secondToken);
      return [{ address: secondToken }];
    }
    return [];
  };
  await pairsTick(monitorClock += 61_000);
  assert.deepEqual(released, [TOKEN]);
  assert.deepEqual(updated, [secondToken]);
});

test("launch-pool monitor still records a sustained failure when its source generation is unchanged", async (t) => {
  offline(t);
  const r = { chain_id: 8453, address: TOKEN, symbol: "TEST", status: "listed", status_by: "admin", status_at: new Date(Date.now() - 3 * 86_400_000),
    failing_since: new Date(Date.now() - 3 * 86_400_000), checked_at: new Date(), price_kind: "launch", code_hash: null };
  let updated = false;
  let audited = false;
  getMock().publicClient = { getCode: async () => "0x" };
  getMock().query = async (sql, values) => {
    if (sql.includes("UPDATE bb_pairs SET checked_at = now()")) return [r];
    if (sql.includes("SELECT reorg_generation")) return [ready];
    if (sql.includes("UPDATE bb_pairs SET status =")) {
      assert.equal(values[0], "suspended");
      updated = true;
      return [{ address: TOKEN }];
    }
    if (sql.includes("INSERT INTO bb_pair_events")) audited = true;
    return [];
  };
  await pairsTick(monitorClock += 61_000);
  assert.equal(updated, true);
  assert.equal(audited, true);
});

test("a failed listing reacquires the payment lock and restores using current payment facts", async (t) => {
  offline(t);
  const previous = process.env.ADMIN_WALLETS;
  process.env.ADMIN_WALLETS = WALLET;
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_WALLETS; else process.env.ADMIN_WALLETS = previous; });
  const app = { id: "7", chain_id: 8453, address: TOKEN, status: "paid", paid_usd: 200, fee_usd: 200, reviews_used: 0,
    quote_until: null, last_quote_until: null, payment_reorg: false, paid_at: new Date(), reason: null, decided_by: null, decided_at: null };
  let locks = 0;
  let restored = false;
  getMock().query = async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) locks++;
    if (sql.includes("bb_launch_sync_cursor")) return [ready];
    if (sql.includes("SELECT * FROM bb_pair_applications")) return [app];
    if (sql.includes("RETURNING id") && sql.includes("UPDATE bb_pair_applications")) return [{ id: 7 }];
    if (sql.includes("SELECT 1 FROM bb_pairs")) throw new Error("listing failed after a concurrent rollback");
    if (sql.includes("UPDATE bb_pair_applications SET") && sql.includes("CASE WHEN NOT payment_reorg")) {
      assert.equal(locks, 2, "restore holds a fresh chain lock after the asynchronous listing");
      assert.match(sql, /THEN 'paid' ELSE 'open' END/);
      assert.match(sql, /payment_reorg OR paid_usd < fee_usd/);
      restored = true;
    }
    return [];
  };
  await assert.rejects(reviewApplication({ decision: "approve", id: 7, wallet: WALLET, nonce: "cd".repeat(16), ts: Date.now(), signature: "0x11" }), /listing failed/);
  assert.equal(restored, true);
});
