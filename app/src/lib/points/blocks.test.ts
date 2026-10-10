import { test } from "node:test";
import assert from "node:assert/strict";
import { lastBlockBetween } from "./blocks.ts";

/** A fake chain: block b's time (ms), and a counter of reads. */
function chain(times: (b: number) => number) {
  let reads = 0;
  return { reads: () => reads, timeOf: async (b: bigint) => (reads++, times(Number(b))) };
}
const check = async (c: ReturnType<typeof chain>, lo: number, hi: number, ms: number, times: (b: number) => number) => {
  const b = Number(await lastBlockBetween(BigInt(lo), times(lo), BigInt(hi), times(hi), ms, c.timeOf));
  assert.ok(times(b) < ms && times(b + 1) >= ms, `block ${b}: ${times(b)} < ${ms} <= ${times(b + 1)}`);
  return b;
};

test("steady 2 s blocks over 3 million blocks: found in a few reads", async () => {
  const t = (b: number) => 1_700_000_000_000 + b * 2_000;
  for (const ms of [t(1_234_567) + 1, t(2_999_998), t(5) + 1_999]) {
    const c = chain(t);
    await check(c, 0, 3_000_000, ms, t);
    assert.ok(c.reads() <= 4, `${c.reads()} reads`);
  }
});

test("uneven block times (bursts, a long halt): still exact, and never more reads than about two per halving", async () => {
  // fast blocks, then a 6-hour halt at block 400,000, then slow blocks
  const t = (b: number) => (b < 400_000 ? b * 250 : 400_000 * 250 + 6 * 3_600_000 + (b - 400_000) * 12_000);
  for (const ms of [t(399_999) + 1, t(400_000), t(400_000) - 1, t(123_456) + 7, t(900_000) + 11_999]) {
    const c = chain(t);
    await check(c, 0, 1_000_000, ms, t);
    assert.ok(c.reads() <= 2 * Math.ceil(Math.log2(1_000_000)), `${c.reads()} reads`);
  }
});

test("blocks sharing a timestamp: the last one before the time, not one of the same second", async () => {
  const t = (b: number) => Math.floor(b / 4) * 1_000; // four blocks a second
  const c = chain(t);
  const b = await check(c, 0, 10_000, 5_000, t); // blocks 20..23 are at 5,000 ms
  assert.equal(b, 19);
});

test("a range that does not bracket the time is refused", async () => {
  const t = (b: number) => b * 1_000;
  await assert.rejects(lastBlockBetween(10n, t(10), 20n, t(20), t(25), chain(t).timeOf));
});
