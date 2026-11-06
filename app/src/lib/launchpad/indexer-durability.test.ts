import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contracts for the indexer durability changes. The paging planner itself is unit-tested in
 * traderHeal.test.ts; these assertions pin the SQL and the single-flight wiring that node --test cannot import
 * (indexer.ts is server-only).
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const indexer = read("./indexer.ts");
const indexes = read("../../../db/concurrent-indexes.sql");

test("cursor and head updates are monotonic across overlapping sync machines", () => {
  assert.match(indexer, /cursor_block = GREATEST\(cursor_block, \$\{to\}\)/);
  assert.match(indexer, /head_block = GREATEST\(COALESCE\(head_block, 0\), \$\{head\}\)/);
  assert.match(indexer, /last_error = CASE WHEN cursor_block <= \$\{to\} THEN NULL ELSE last_error END/);
  assert.match(indexer, /head_block = CASE WHEN \$\{knownHead\}::bigint IS NULL THEN head_block ELSE GREATEST\(COALESCE\(head_block, 0\), \$\{knownHead\}::bigint\) END/);
});

test("the whole poll pass is single-flight, not just each chain's run()", () => {
  assert.match(indexer, /let allInFlight: Promise<Record<string, LaunchSyncResult>> \| null = null;/);
  assert.match(indexer, /if \(allInFlight\) return allInFlight;/);
  assert.match(indexer, /async function pollAllOnce\(\): Promise<Record<string, LaunchSyncResult>>/);
  assert.match(indexer, /const p = pollAllOnce\(\)\.finally\(\(\) => \{/);
});

test("trader healing pages oldest-first with a keyset, not the newest 100 rows", () => {
  assert.match(indexer, /\(block_number, log_index\) > \(\$\{after\.block\}, \$\{after\.log\}\)/);
  assert.match(indexer, /ORDER BY block_number ASC, log_index ASC LIMIT \$\{HEAL_TRADER_PAGE\}/);
  assert.doesNotMatch(indexer, /ORDER BY block_number DESC LIMIT 100/);
  assert.match(indexer, /if \(plan\.cursor\) healTraderCursor\.set\(chain, plan\.cursor\)/);
  assert.match(indexer, /healTraderCursor\.delete\(chain\)/);
});

test("retry state is pruned, never cleared wholesale", () => {
  assert.match(indexer, /function restTraderHeal\(key: string\): void/);
  assert.match(indexer, /function noteAttributionTry\(key: string, n: number\): void/);
  assert.match(indexer, /setBounded\(healRestUntil,/);
  assert.match(indexer, /setBounded\(attributionTries,/);
  assert.doesNotMatch(indexer, /healRestUntil\.clear\(\)/);
  assert.doesNotMatch(indexer, /attributionTries\.clear\(\)/);
});

test("the partial index serves the missing-trader page and order", () => {
  assert.match(
    indexes,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS bb_launch_swaps_trader_null_idx ON bb_launch_swaps \(chain_id, block_number, log_index\) WHERE trader IS NULL;/,
  );
});
