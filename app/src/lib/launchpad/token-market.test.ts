import { test } from "node:test";
import assert from "node:assert/strict";
import { holderFactsAvailable, marketCount, tradeQuoteKey } from "./token-market.ts";

test("a swap quote is bound to chain, normalized token, side and exact input", () => {
  const key = tradeQuoteKey("base", "0xAbC", "buy", "0.1");
  assert.equal(key, tradeQuoteKey("base", "0xabc", "buy", "0.1"));
  assert.notEqual(key, tradeQuoteKey("robinhood", "0xabc", "buy", "0.1"));
  assert.notEqual(key, tradeQuoteKey("base", "0xdef", "buy", "0.1"));
  assert.notEqual(key, tradeQuoteKey("base", "0xabc", "sell", "0.1"));
  assert.notEqual(key, tradeQuoteKey("base", "0xabc", "buy", "0.2"));
});
test("unindexed holder data cannot render a positive verdict", () => {
  assert.equal(holderFactsAvailable(null), false);
  assert.equal(holderFactsAvailable({ synced: false }), false);
  assert.equal(holderFactsAvailable({ synced: true }), true);
});
test("trade counts stay integral while large values stay compact", () => {
  assert.equal(marketCount(0), "0");
  assert.equal(marketCount(3), "3");
  assert.equal(marketCount(12500), "12.5K");
});
test("trade counts never render NaN or Infinity", () => {
  assert.equal(marketCount(NaN), "—");
  assert.equal(marketCount(Infinity), "—");
  assert.equal(marketCount(-Infinity), "—");
});
