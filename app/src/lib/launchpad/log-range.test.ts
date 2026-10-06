import { test } from "node:test";
import assert from "node:assert/strict";
import { SELECTOR_MARGIN, byChainOrder, chunkList, fetchBySelectors, fetchLogsSplit, isRangeTooLarge, selectorCapFromError } from "./log-range.ts";

test("isRangeTooLarge recognises the size refusals of Arc and Alchemy, through viem's cause chain", () => {
  assert.equal(isRangeTooLarge(new Error("request exceeded max allowed range: query exceeds max results 2000, retry with the range 21102592-21102595")), true);
  assert.equal(isRangeTooLarge(new Error("requested range too large")), true);
  assert.equal(isRangeTooLarge(new Error("Log response size exceeded. This block range should work: [0x1, 0x2]")), true);
  assert.equal(isRangeTooLarge({ message: "HTTP request failed.", cause: { message: "query returned more than 10000 results" } }), true);
  assert.equal(isRangeTooLarge({ message: "HTTP request failed.", details: "requested range too large" }), true);
  assert.equal(isRangeTooLarge(new Error("fetch failed")), false);
  assert.equal(isRangeTooLarge(new Error("rate limited")), false);
  assert.equal(isRangeTooLarge(new Error("query timeout of 10 seconds exceeded")), false, "an overloaded node is not bisected");
  assert.equal(isRangeTooLarge(null), false);
  const loop: { message: string; cause?: unknown } = { message: "x" };
  loop.cause = loop;
  assert.equal(isRangeTooLarge(loop), false, "a cyclic cause chain terminates");
});

test("fetchLogsSplit halves a refused range down to single blocks and keeps block order", async () => {
  const calls: [bigint, bigint][] = [];
  // the node accepts at most 3 blocks per call
  const fetch = async (from: bigint, to: bigint) => {
    calls.push([from, to]);
    if (to - from + 1n > 3n) throw new Error("query exceeds max results 2000, retry with the range 1-3");
    const out: bigint[] = [];
    for (let b = from; b <= to; b++) out.push(b);
    return out;
  };
  const logs = await fetchLogsSplit(fetch, 10n, 21n);
  assert.deepEqual(logs, [10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n, 18n, 19n, 20n, 21n]);
  assert.deepEqual(calls[0], [10n, 21n]);
  assert.ok(calls.every(([f, t]) => t >= f));
});

test("fetchLogsSplit gives up at one block and passes other errors through untouched", async () => {
  await assert.rejects(fetchLogsSplit(async () => { throw new Error("requested range too large"); }, 5n, 5n), /range too large/);
  let n = 0;
  await assert.rejects(fetchLogsSplit(async () => { n++; throw new Error("fetch failed"); }, 0n, 1999n), /fetch failed/);
  assert.equal(n, 1, "an outage is not retried as a size problem");
});

test("selectorCapFromError reads Robinhood Chain's selector refusals (and only those), through viem's cause chain", () => {
  const rh = "Invalid parameters were provided to the RPC method.";
  assert.equal(selectorCapFromError({ message: rh, details: "1011 address and topic selectors specified in query, but only 1000 are allowed" }), 1000);
  assert.equal(selectorCapFromError({ message: "HTTP request failed.", cause: { message: rh, details: "1002 address and topic selectors specified in query, but only 500 are allowed" } }), 500);
  assert.equal(selectorCapFromError({ message: rh, details: "invalid argument 0: exceed max topics" }), 1000, "no number stated: geth's default");
  assert.equal(selectorCapFromError(new Error("exceed max addresses")), 1000);
  assert.equal(selectorCapFromError(new Error("query exceeds max results 2000, retry with the range 1-3")), null, "a range refusal is not a selector refusal");
  assert.equal(selectorCapFromError(new Error("fetch failed")), null);
  assert.equal(selectorCapFromError(null), null);
  assert.equal(isRangeTooLarge({ message: rh, details: "1011 address and topic selectors specified in query, but only 1000 are allowed" }), false, "and it is never bisected by block range");
});

test("chunkList slices in order and never drops an item", () => {
  assert.deepEqual(chunkList([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkList([], 3), []);
  assert.deepEqual(chunkList([1, 2], 0), [[1], [2]], "a size below 1 still makes progress");
});

test("fetchBySelectors: one call where the node allows it; slices under a stated cap; learns the cap once", async () => {
  const list = Array.from({ length: 2500 }, (_, i) => i);
  // a node with no cap: one call with the whole list, nothing remembered
  {
    const caps = new Map<string, number>();
    const calls: number[] = [];
    const out = await fetchBySelectors(caps, "base", list, async (slice) => (calls.push(slice.length), slice));
    assert.deepEqual(calls, [2500]);
    assert.equal(out.length, 2500);
    assert.equal(caps.has("base"), false);
  }
  // a node capped at 1000 that the indexer did not know about: one refusal, then slices; the cap is remembered
  {
    const caps = new Map<string, number>();
    const calls: number[] = [];
    const node = async (slice: number[]) => {
      calls.push(slice.length);
      if (slice.length + 2 > 1000) throw { message: "Invalid parameters were provided to the RPC method.", details: `${slice.length + 2} address and topic selectors specified in query, but only 1000 are allowed` };
      return slice;
    };
    const out = await fetchBySelectors(caps, "robinhood", list, node);
    assert.deepEqual(calls, [2500, 1000 - SELECTOR_MARGIN, 1000 - SELECTOR_MARGIN, 2500 - 2 * (1000 - SELECTOR_MARGIN)]);
    assert.deepEqual(out, list, "every item, in order");
    assert.equal(caps.get("robinhood"), 1000);
    calls.length = 0;
    await fetchBySelectors(caps, "robinhood", list, node);
    assert.equal(calls[0], 1000 - SELECTOR_MARGIN, "next time no refusal: straight to slices");
  }
  // a known cap: slices from the start; a short list is still one call
  {
    const caps = new Map([["robinhood", 1000]]);
    const calls: number[] = [];
    await fetchBySelectors(caps, "robinhood", list.slice(0, 40), async (slice) => (calls.push(slice.length), slice));
    assert.deepEqual(calls, [40]);
  }
  // any other error propagates and teaches nothing
  {
    const caps = new Map<string, number>();
    await assert.rejects(fetchBySelectors(caps, "base", list, async () => { throw new Error("fetch failed"); }), /fetch failed/);
    assert.equal(caps.size, 0);
  }
});

test("byChainOrder merges slices back into block, then log-index order", () => {
  const logs = [
    { blockNumber: 12n, logIndex: 1 },
    { blockNumber: 10n, logIndex: 5 },
    { blockNumber: 12n, logIndex: 0 },
    { blockNumber: 10n, logIndex: 2 },
  ];
  assert.deepEqual(byChainOrder(logs).map((l) => `${l.blockNumber}:${l.logIndex}`), ["10:2", "10:5", "12:0", "12:1"]);
  assert.equal(logs[0].blockNumber, 12n, "the input is not reordered in place");
});
