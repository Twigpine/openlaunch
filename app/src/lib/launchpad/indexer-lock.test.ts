import assert from "node:assert/strict";
import test from "node:test";
import { getMock, resetMock } from "@/lib/db-mock";
import { IndexLockBusyError, withIndexLock } from "./indexer-lock";

test("the chain wait budget is separate from the table lock budget", async () => {
  resetMock();
  const calls: string[] = [];
  getMock().query = async (sql) => { calls.push(sql); return []; };
  assert.equal(await withIndexLock("base", async () => { calls.push("work"); return 42; }), 42);
  assert.match(calls[0], /lock_timeout = '8s'/);
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.match(calls[2], /lock_timeout = '5s'/);
  assert.match(calls[3], /LOCK TABLE bb_launch_swaps, bb_launch_fee_events, bb_launches IN ROW EXCLUSIVE MODE/);
  assert.equal(calls[4], "work");
});

test("an advisory timeout never enters work and is retryable", async () => {
  resetMock();
  let worked = false;
  getMock().query = async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) throw { code: "55P03", detail: "private database diagnostic" };
    assert.doesNotMatch(sql, /LOCK TABLE/);
    return [];
  };
  await assert.rejects(withIndexLock("base", async () => { worked = true; }), IndexLockBusyError);
  assert.equal(worked, false);
});

test("other database failures are not misreported as advisory contention", async () => {
  for (const [stage, code] of [["advisory", "08006"], ["table", "55P03"]]) {
    resetMock();
    const failure = Object.assign(new Error("synthetic failure"), { code });
    getMock().query = async (sql) => {
      if (stage === "advisory" ? sql.includes("pg_advisory_xact_lock") : sql.includes("LOCK TABLE")) throw failure;
      return [];
    };
    await assert.rejects(withIndexLock("base", async () => assert.fail("failed lock entered work")), error => error === failure);
  }
});
