import { test } from "node:test";
import assert from "node:assert/strict";
import { healthBody, lagBlocks } from "./health.ts";

const base = { dbConfigured: true, dbOk: true, chain: true, launchpad: true };
const sync = (o: Partial<{ cursor_block: number | null; head_block: number | null; last_run_at: string | null; last_error: string | null }> = {}) => ({
  cursor_block: 100,
  head_block: 110,
  last_run_at: "2026-09-06T00:00:00.000Z",
  last_error: null,
  ...o,
});

test("healthy → 200 ok", () => {
  const r = healthBody({ ...base, sync: sync() });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.alerts, []);
  assert.equal(r.body.sync.lag_blocks, 10);
});

test("db configured but unreachable → 503", () => {
  const r = healthBody({ ...base, dbOk: false });
  assert.equal(r.status, 503);
  assert.deepEqual(r.body.alerts, ["db_unreachable"]);
});

test("db unconfigured → alive, db:false, no alert", () => {
  const r = healthBody({ ...base, dbConfigured: false, dbOk: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.db, false);
  assert.deepEqual(r.body.alerts, []);
});

test("lag beyond limit / last_error → ok:false but 200", () => {
  const r = healthBody({ ...base, sync: sync({ head_block: 1000 }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.alerts, ["sync_lag"]);
  const e = healthBody({ ...base, sync: sync({ last_error: "boom" }) });
  assert.deepEqual(e.body.alerts, ["sync_error"]);
});

test("lagBlocks never negative / null-safe", () => {
  assert.equal(lagBlocks(5, 10), 0);
  assert.equal(lagBlocks(null, 10), null);
});

test("health says which release is running, and nothing when it does not know", () => {
  const known = healthBody({ ...base, version: "1.0.0", commit: "df3e410" }).body;
  assert.equal(known.version, "1.0.0");
  assert.equal(known.commit, "df3e410");
  const unknown = healthBody(base).body;
  assert.equal(unknown.version, null);
  assert.equal(unknown.commit, null);
});
