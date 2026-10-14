import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_STOCKS } from "./baseStocks.ts";
import { stockByAddress, stockList, stockPrices } from "./stocksServer.ts";

// @/lib/chain is the test mock here, and its client has no multicall: any price read for a Base stock throws inside
// stockPrices, which catches it and warns once. So "no warning" below means "no chain read was attempted".

const NVDA = "0xb20000000000000000000078ee7ce2fe4908108c"; // has a Chainlink feed
const TSLA = "0xb2000000000000000000001e800a7f5189430cd0"; // has a Chainlink feed
const NFLX = "0xb20000000000000000000058b8c947e44011dfe6"; // listed, no feed
const AMD = "0xb2000000000000000000000d8ce462e99ee7a47b"; // listed, no feed
const NOT_A_STOCK = "0xb2000000000000000000004c27f6523082f41d01"; // a B20 token Coinbase did not issue

test("base: all 146 registry stocks resolve by address, each with 8 decimals and a tile logo", () => {
  const list = stockList("base");
  assert.equal(list.length, 146);
  for (const s of list) {
    assert.equal(s.chain, "base");
    assert.equal(s.decimals, 8);
    assert.ok(s.logo?.startsWith("data:image/svg+xml,"), s.symbol);
    assert.deepEqual(stockByAddress("base", s.address), s);
  }
  assert.equal(stockByAddress("base", NFLX.toUpperCase().replace("0X", "0x"))?.symbol, "NFLXc", "case-insensitive");
  assert.equal(stockByAddress("base", NOT_A_STOCK), null, "the B20 shape alone is never a stock");
  // the list is static: its rows and their logos are built once, not on every call
  assert.equal(stockList("base"), list);
  assert.equal(stockByAddress("base", NFLX), list.find((s) => s.symbol === "NFLXc"));
  assert.equal(list.filter((s) => s.priced).length, 13);
});

test("a Base stock belongs to Base only: Arc has no registry, and Robinhood's is its own", () => {
  assert.equal(stockByAddress("arc", NVDA), null);
  assert.deepEqual(stockList("arc"), []);
  assert.equal(stockByAddress("robinhood", NVDA), null);
});

test("base: a stock without a feed is priced null and no chain read is made for it", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const px = await stockPrices("base", [NFLX, AMD.toUpperCase().replace("0X", "0x"), NOT_A_STOCK]);
  assert.deepEqual(Object.fromEntries(px), { [NFLX]: null, [AMD]: null }, "listed stocks answer null; an address outside the registry is not answered at all");
  assert.equal(warn.mock.callCount(), 0);
  // the 133 feed-less stocks together still cost no read
  const all = await stockPrices("base", BASE_STOCKS.filter((s) => s.feed === null).map((s) => s.address));
  assert.equal(all.size, 133);
  assert.ok([...all.values()].every((v) => v === null));
  assert.equal(warn.mock.callCount(), 0);
});

test("base: a failed feed read fails soft to null, and is not retried inside the cache window", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const px = await stockPrices("base", [NVDA, TSLA, NFLX]);
  assert.deepEqual(Object.fromEntries(px), { [NVDA]: null, [TSLA]: null, [NFLX]: null });
  assert.equal(warn.mock.callCount(), 1, "one multicall for the two stocks that have a feed");
  await stockPrices("base", [NVDA, TSLA]);
  assert.equal(warn.mock.callCount(), 1);
});
