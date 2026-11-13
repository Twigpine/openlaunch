import { test } from "node:test";
import assert from "node:assert/strict";
import { MCAP_DEFAULT_INDEX, MCAP_USD_TARGETS, NO_USD_PRICE, capChipLabel, capDisplay, capEntry, capPick, capPresets, capQuoteLabel, capToQuote } from "./market-cap.ts";
import { fdvForStartTick, startTickForFdv } from "./math.ts";

const eth = { key: "eth" as const, symbol: "ETH", decimals: 18 };
const usdg = { key: "usdg" as const, symbol: "USDG", decimals: 6 };
const nvda = { key: "stock" as const, symbol: "NVDA", decimals: 18 };
const amc = { key: "stock" as const, symbol: "AMCc", decimals: 8 }; // a Coinbase stock: 8 decimals
const gitlawb = { key: "gitlawb" as const, symbol: "GITLAWB", decimals: 18 };

test("capEntry: dollars whenever the quote has a positive price, quote units otherwise", () => {
  assert.deepEqual(capEntry(2464.49), { unit: "usd", quoteUsd: 2464.49 });
  assert.deepEqual(capEntry(1), { unit: "usd", quoteUsd: 1 });
  assert.deepEqual(capEntry(null), { unit: "quote" });
  assert.deepEqual(capEntry(0), { unit: "quote" });
  assert.deepEqual(capEntry(Number.NaN), { unit: "quote" });
});

test("capPresets: the same four dollar targets for every priced quote; a quote's own units without a price", () => {
  const usd = capEntry(2464.49);
  for (const k of ["eth", "usdg", "gitlawb", "stock"] as const) assert.deepEqual(capPresets(usd, k), MCAP_USD_TARGETS);
  assert.deepEqual(capPresets(capEntry(null), "eth"), [1, 5, 10, 25], "ETH without a price: the old ETH presets");
  assert.deepEqual(capPresets(capEntry(null), "usdg"), [5_000, 10_000, 25_000, 100_000]);
  assert.deepEqual(capPresets(capEntry(null), "stock"), [], "a stock without a price has no presets: the form asks for a custom cap");
  assert.deepEqual(capPresets(capEntry(null), "gitlawb"), []);
  assert.equal(MCAP_USD_TARGETS[MCAP_DEFAULT_INDEX], 25_000);
});

test("capPick: a pick survives only among the presets it was made from; otherwise the default", () => {
  assert.equal(capPick(100_000, MCAP_USD_TARGETS), 100_000);
  assert.equal(capPick(null, MCAP_USD_TARGETS), 25_000);
  assert.equal(capPick(25_000, [1, 5, 10, 25]), 10, "a $25K pick does not become 25,000 ETH after switching to an unpriced quote");
  assert.equal(capPick(10, [1, 5, 10, 25]), 10);
  assert.equal(capPick(10, []), null, "no presets, no pick: the form needs a custom cap");
});

test("capToQuote feeds the tick maths: $25K at $2,500/ETH is 10 ETH, and the tick round-trips within one spacing step", () => {
  const usd = capEntry(2500);
  assert.equal(capToQuote(25_000, usd), 10);
  assert.equal(capToQuote(10, capEntry(null)), 10, "quote mode is the identity");
  const tick = startTickForFdv(capToQuote(25_000, usd), 18);
  const shown = fdvForStartTick(tick, 18) * 2500;
  assert.ok(Math.abs(shown / 25_000 - 1) < 0.02, `the cap the tick actually produces is shown, within one 2% tick step of the target: $${shown.toFixed(0)}`);
  const usdgTick = startTickForFdv(capToQuote(10_000, capEntry(1)), 6);
  const usdgShown = fdvForStartTick(usdgTick, 6);
  assert.ok(Math.abs(usdgShown / 10_000 - 1) < 0.02);
});

test("labels: chips in dollars or quote units; quote text per quote kind", () => {
  assert.equal(capChipLabel(25_000, capEntry(2500), eth), "$25K");
  assert.equal(capChipLabel(100_000, capEntry(1), usdg), "$100K");
  assert.equal(capChipLabel(10, capEntry(null), eth), "10 ETH");
  assert.equal(capQuoteLabel(10.1234, eth), "10.123 ETH");
  assert.equal(capQuoteLabel(25_000, usdg), "25,000 USDG");
  assert.equal(capQuoteLabel(0.5, usdg), "0.5 USDG", "fractional USDG keeps its cents (CodeRabbit, PR #27)");
  assert.equal(capQuoteLabel(99.99, usdg), "99.99 USDG");
  assert.equal(capQuoteLabel(100.4, usdg), "100 USDG", "from 100 units up, whole units");
  assert.equal(capQuoteLabel(0.11208, nvda), "0.112 NVDA");
  // a cheap stock, or one with no USD price where this figure is the headline: whole shares with separators, compact from 100K
  assert.equal(capQuoteLabel(99.9994, nvda), "99.999 NVDA", "under 100, three decimals as before");
  assert.equal(capQuoteLabel(150.5, amc), "151 AMCc");
  assert.equal(capQuoteLabel(25_000, amc), "25,000 AMCc", "not 25000.000 AMCc");
  assert.equal(capQuoteLabel(99_999.4, amc), "99,999 AMCc");
  assert.equal(capQuoteLabel(1_200_000, amc), "1.2M AMCc", "not 1200000.000 AMCc");
  assert.equal(capQuoteLabel(1_250_000, gitlawb), "1.25M GITLAWB");
});

test("capDisplay: dollars lead with the quote figure as detail; without a price the quote figure leads and says so", () => {
  assert.deepEqual(capDisplay(10, 2500, eth), { main: "$25K", detail: "10 ETH", compact: "$25K", usd: 25_000 });
  assert.deepEqual(capDisplay(25_000, 1, usdg), { main: "$25K", detail: "25,000 USDG", compact: "$25K", usd: 25_000 });
  assert.deepEqual(capDisplay(0.112, 223.05, nvda), { main: "$24.98", detail: "0.112 NVDA", compact: "$24.98", usd: 0.112 * 223.05 }, "under $1,000 the figure keeps cents");
  assert.deepEqual(capDisplay(10, null, eth), { main: "10 ETH", detail: NO_USD_PRICE, compact: "10 ETH · no USD price", usd: null }, "one-string sites still carry the mark");
  assert.deepEqual(capDisplay(0.5, 0, nvda), { main: "0.500 NVDA", detail: NO_USD_PRICE, compact: "0.500 NVDA · no USD price", usd: null });
  assert.deepEqual(capDisplay(0.5, 1, usdg), { main: "$0.5", detail: "0.5 USDG", compact: "$0.5", usd: 0.5 });
});

test("extreme quote valuations and invalid API values cannot produce endless digits or crash", () => {
  assert.equal(capQuoteLabel(1e35, usdg), "1.0e+35 USDG");
  assert.equal(capQuoteLabel(1e35, nvda), "1.0e+35 NVDA");
  for (const value of [NaN, Infinity, -1, null]) {
    assert.equal(capDisplay(value as number, 1, usdg).main, "—");
  }
  assert.equal(capDisplay(Number.MAX_VALUE, 2, eth).main, "—");
});
