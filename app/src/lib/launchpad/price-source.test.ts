import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getMock, resetMock } from "@/lib/db-mock";
import { NATIVE, hasPriceSource } from "./config.ts";
import { getLaunchTotals, quotePricer } from "./queries.ts";

// A registry stock without a price feed (133 of the 146 Coinbase stocks) has no USD by design, like an unlisted
// ERC-20. These tests pin that it is treated that way: nothing reports its missing price as an outage or waits for it.
// @/lib/db and @/lib/chain are the test mocks; fetch is refused, so no price loads and nothing leaves the machine.

const NVDA = "0xb20000000000000000000078ee7ce2fe4908108c"; // Coinbase stock with a Chainlink feed
const NFLX = "0xb20000000000000000000058b8c947e44011dfe6"; // Coinbase stock without one
const NOT_A_STOCK = "0xb2000000000000000000004c27f6523082f41d01"; // a B20 token Coinbase did not issue
const BASE = 8453;
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function offline(t: TestContext) {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline (test)");
  });
  t.mock.method(console, "warn", () => {});
}

test("hasPriceSource: an unlisted ERC-20 and a stock without a feed have none; every other quote does", () => {
  for (const key of ["eth", "usdg", "usdc", "gitlawb", "twig", "museworld"] as const) assert.equal(hasPriceSource({ key }), true, key);
  assert.equal(hasPriceSource({ key: "stock" }), true, "a stock with a feed, or any Robinhood Stock Token");
  assert.equal(hasPriceSource({ key: "stock", unpriced: false }), true);
  assert.equal(hasPriceSource({ key: "stock", unpriced: true }), false);
  assert.equal(hasPriceSource({ key: "other" }), false);
});

test("quote pricing: a feed-less Coinbase stock is a stock with no price source; one with a feed is only missing its price for now", async (t) => {
  offline(t);
  const price = await quotePricer(2500);
  assert.deepEqual(price("base", NFLX), { key: "stock", decimals: 8, usd: null, priced: false });
  assert.deepEqual(price("base", NVDA), { key: "stock", decimals: 8, usd: null, priced: true });
  assert.deepEqual(price("base", NOT_A_STOCK), { key: "other", decimals: 18, usd: null, priced: false }, "not in the registry: an unlisted pair, as before");
  assert.deepEqual(price("base", NATIVE), { key: "eth", decimals: 18, usd: 2500, priced: true });
  assert.equal(price("robinhood", NFLX).key, "other", "a Base stock address is not a stock on another chain");
});

test("hero totals: volume in a feed-less stock is left out without the undercount mark; a missing price on a stock with a feed sets it", async (t) => {
  offline(t);
  resetMock();
  const row = (quote: string, volume: bigint) => ({ chain_id: BASE, quote, launches: 1n, trades: 4n, volume: volume.toString(), burned: "0", creators: "0" });
  getMock().launchTotalsRows = [row(NATIVE, 10n ** 18n), row(NFLX, 5n * 10n ** 8n), row(NOT_A_STOCK, 10n ** 18n)];
  const quiet = await getLaunchTotals(2500);
  assert.equal(quiet.launches, 3);
  assert.equal(quiet.trades, 12);
  assert.equal(quiet.volume_usd, 2500, "only the ETH volume has a dollar value");
  assert.equal(quiet.usd_partial, false, "NFLXc and the unlisted token never had a price: nothing is missing");

  getMock().launchTotalsRows.push(row(NVDA, 10n ** 8n));
  const partial = await getLaunchTotals(2500);
  assert.equal(partial.volume_usd, 2500);
  assert.equal(partial.usd_partial, true, "NVDAc has a feed, so a null price is an outage and the dollar totals undercount");

  // an idle launch (no volume, no fees) never marks the totals, whatever its quote
  getMock().launchTotalsRows = [row(NATIVE, 10n ** 18n), row(NVDA, 0n)];
  assert.equal((await getLaunchTotals(2500)).usd_partial, false);
  resetMock();
});

test("the points run waits for a missing price only when the quote has a price source", () => {
  const points = read("../points/server.ts");
  assert.match(points, /if \(q\.usd === null && q\.priced && finalRun && now < end \+ PRICE_WAIT_MS\) return \{ skipped: `no price for \$\{q\.key\} right now; the final standings wait for it` \};/);
  assert.doesNotMatch(points, /q\.key !== "other"/, "the key alone no longer decides: a feed-less stock has the key 'stock'");
  // and that answer is the same one the hero totals use
  const queries = read("./queries.ts");
  assert.match(queries, /return \{ key: q\.key, decimals: q\.decimals, usd: quoteUsd\(q, ethUsd\), priced: hasPriceSource\(q\) \};/);
  assert.match(queries, /if \(usd === null && hasPriceSource\(q\) && \(/);
  assert.match(queries, /\.\.\.\(stock\.priced \? \{\} : \{ unpriced: true \}\)/);
  // every launch row carries the same answer to the client (the wallet page's holdings total reads it)
  assert.match(queries, /quote_decimals_known: q\.decimalsKnown !== false,\s*quote_priced: hasPriceSource\(q\),/);
});
