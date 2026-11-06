import assert from "node:assert/strict";
import { test } from "node:test";
import { rpcBudget } from "./rpc-budget";

test("RPC budget caps concurrency, duplicate release, and starts across IPs", () => {
  const acquire = rpcBudget(1, 2);
  const release = acquire(60_000);
  assert.ok(release);
  assert.equal(acquire(60_000), null);
  release();
  release();
  const second = acquire(60_001);
  assert.ok(second);
  assert.equal(acquire(60_001), null);
  second();
  assert.equal(acquire(60_002), null);
  assert.ok(acquire(120_000));
});
