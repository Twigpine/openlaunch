import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { creatorActivity, sniperSummary } from "./holders.ts";

const source = readFileSync(new URL("./holdersServer.ts", import.meta.url), "utf8");
const panelSql = source.slice(source.indexOf("const [rows,"), source.indexOf("const lite ="));
const swapQueries = panelSql.split("db<").filter((q) => q.includes("FROM bb_launch_swaps"));

test("holder panel never caps the swap rows it reads", () => {
  assert.equal(swapQueries.length, 2, "sniper window + creator aggregate");
  for (const q of swapQueries) assert.doesNotMatch(q, /\bLIMIT\b/, "swap facts are complete, not a row window");
});

test("sniper detection reads the complete launch window, not the first N swaps", () => {
  const sniperSql = swapQueries.find((q) => q.includes("SNIPER_BLOCKS"));
  assert.ok(sniperSql, "sniper query present");
  assert.match(sniperSql, /block_number BETWEEN/);
  assert.match(sniperSql, /is_buy AND trader IS NOT NULL/);
});

test("creator totals are SQL aggregates, so a sale past 5,000 swaps still counts", () => {
  const creatorSql = swapQueries.find((q) => q.includes("FILTER"));
  assert.ok(creatorSql, "creator aggregate present");
  assert.match(creatorSql, /sum\(abs\(amount1\)\) FILTER \(WHERE is_buy\)/);
  assert.match(creatorSql, /sum\(abs\(amount1\)\) FILTER \(WHERE NOT is_buy\)/);
  assert.match(creatorSql, /count\(\*\) FILTER \(WHERE NOT is_buy\)/);
});

test("sniperSummary covers a qualifying buy in the 5,001st row", () => {
  const launchBlock = 100n;
  const sniper = "0x" + "aa".repeat(20);
  const other = "0x" + "bb".repeat(20);
  const swaps = Array.from({ length: 5001 }, (_, i) => ({
    trader: i === 5000 ? sniper : other,
    is_buy: true,
    block_number: 101n,
    token_amount: 1n,
  }));
  const sn = sniperSummary(swaps, launchBlock, 50_000n);
  assert.ok(sn.wallets.includes(sniper), "a launch-window buy is not lost behind a row cap");
});

test("creatorActivity counts a sale past 5,000 swaps", () => {
  const creator = "0x" + "cc".repeat(20);
  const other = "0x" + "bb".repeat(20);
  const swaps = [
    ...Array.from({ length: 5000 }, () => ({ trader: other, is_buy: true, block_number: 101n, token_amount: 1n })),
    { trader: creator, is_buy: false, block_number: 9000n, token_amount: 7n },
  ];
  assert.deepEqual(creatorActivity(swaps, creator), { bought: 0n, sold: 7n, sells: 1 });
});
