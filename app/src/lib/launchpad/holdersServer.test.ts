import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLDER_SWAPS_LIMIT } from "./holdersServer.ts";
import { creatorActivity, sniperSummary } from "./holders.ts";

test("holder panel scans a bounded oldest-first window, never the whole swaps table", () => {
  assert.ok(Number.isInteger(HOLDER_SWAPS_LIMIT), "limit is an integer");
  assert.ok(HOLDER_SWAPS_LIMIT > 0 && HOLDER_SWAPS_LIMIT <= 5000, `limit stays bounded (got ${HOLDER_SWAPS_LIMIT})`);
});

test("oldest-first truncation keeps sniper detection exact while bounding late tail work", () => {
  const launchBlock = 100n;
  const sniper = "0x" + "aa".repeat(20);
  const late = "0x" + "bb".repeat(20);
  const swaps = [
    { trader: sniper, is_buy: true, block_number: 101n, token_amount: 50n },
    { trader: late, is_buy: true, block_number: 10_000n, token_amount: 70n },
  ];
  const full = sniperSummary(swaps, launchBlock, 1000n);
  assert.deepEqual(full.wallets, [sniper.toLowerCase()]);
  // oldest-first LIMIT 1 keeps the sniper-window swap; newest-first would keep only the late one
  const oldestFirst = sniperSummary(swaps.slice(0, 1), launchBlock, 1000n);
  assert.deepEqual(oldestFirst.wallets, [sniper.toLowerCase()]);
  const creator = "0x" + "cc".repeat(20);
  const activity = creatorActivity(
    [
      { trader: creator, is_buy: true, block_number: 101n, token_amount: 10n },
      { trader: creator, is_buy: false, block_number: 102n, token_amount: 4n },
    ],
    creator,
  );
  assert.equal(activity.bought, 10n);
  assert.equal(activity.sold, 4n);
  assert.equal(activity.sells, 1);
});
