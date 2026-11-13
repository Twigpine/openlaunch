import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPUTE_WARN_MS, COMPUTE_WARN_ROWS, computeLogLine } from "./log.ts";

test("the compute's log line: counts and time, a warning once a run gets heavy", () => {
  const read = { swaps: 10, firstBuys: 5, moves: 20, linked: 1 };
  assert.deepEqual(computeLogLine("s2", { wallets: 3, eligible: 1, ms: 120, read }), { level: "log", line: "[points] s2: 3 wallets (1 eligible) in 120ms from 10 swaps, 5 first buys, 20 moves, 1 linked transfers" });
  assert.equal(computeLogLine("s2", { wallets: 3, eligible: 1, ms: COMPUTE_WARN_MS + 1, read }).level, "warn");
  assert.equal(computeLogLine("s2", { wallets: 3, eligible: 1, ms: 5, read: { ...read, moves: COMPUTE_WARN_ROWS } }).level, "warn");
  assert.deepEqual(computeLogLine("s2", { skipped: "no ETH price" }), { level: "log", line: "[points] s2: skipped (no ETH price), last board kept" });
  // every source under the threshold, their total over it: heavy
  assert.equal(computeLogLine("s2", { wallets: 3, eligible: 1, ms: 5, read: { ...read, swaps: 500_000, moves: 500_001 } }).level, "warn");
  // a skipped run is timed too, and warned when slow
  assert.deepEqual(computeLogLine("s2", { skipped: "no price for twig" }, 1_200), { level: "log", line: "[points] s2: skipped (no price for twig), last board kept after 1200ms" });
  assert.equal(computeLogLine("s2", { skipped: "no price for twig" }, COMPUTE_WARN_MS + 1).level, "warn");
});
