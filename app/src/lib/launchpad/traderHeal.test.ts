import assert from "node:assert/strict";
import test from "node:test";
import { planTraderHeal, type HealSwapRow } from "./traderHeal.ts";

const row = (tx: string, block: number, log: number): HealSwapRow => ({ tx_hash: tx, log_index: log, token: "0x" + "11".repeat(20), block_number: BigInt(block) });

test("groups keep row order and only live groups spend a read", () => {
  const rows = [row("a", 10, 0), row("a", 10, 1), row("b", 11, 0), row("c", 12, 0)];
  const plan = planTraderHeal(rows, new Map([["base:b", 2_000]]), "base", 1_000, 20);
  assert.deepEqual(plan.groups.map((g) => g.tx), ["a", "b", "c"]);
  assert.equal(plan.groups[0]!.resting, false);
  assert.equal(plan.groups[1]!.resting, true);
  assert.equal(plan.reads, 2, "the parked group does not spend a chain read");
  assert.deepEqual(plan.cursor, { block: 12n, log: 0 });
});

test("a page made entirely of parked groups still advances the cursor", () => {
  const rows = [row("a", 10, 0), row("b", 11, 0), row("c", 12, 0)];
  const rest = new Map([["base:a", 2_000], ["base:b", 2_000], ["base:c", 2_000]]);
  const plan = planTraderHeal(rows, rest, "base", 1_000, 20);
  assert.equal(plan.reads, 0);
  assert.deepEqual(plan.groups.map((g) => g.tx), ["a", "b", "c"]);
  assert.deepEqual(plan.cursor, { block: 12n, log: 0 }, "the next tick starts after these rows, not on them again");
});

test("maxReads stops before the next live group, so the rest waits for the next tick", () => {
  const rows = [row("a", 10, 0), row("b", 11, 0), row("c", 12, 0)];
  const plan = planTraderHeal(rows, new Map(), "base", 1_000, 2);
  assert.deepEqual(plan.groups.map((g) => g.tx), ["a", "b"]);
  assert.equal(plan.reads, 2);
  assert.deepEqual(plan.cursor, { block: 11n, log: 0 });
});

test("an empty page has no cursor to store", () => {
  const plan = planTraderHeal([], new Map(), "base", 1_000, 20);
  assert.deepEqual(plan.groups, []);
  assert.equal(plan.reads, 0);
  assert.equal(plan.cursor, null);
});
