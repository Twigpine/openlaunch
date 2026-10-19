import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHAIN_KEYS } from "../chainKeys.ts";
import { fixedUsdQuotes, hasPriceSource, launchpad, listedQuoteAddresses, quoteInfo, quoteUsdOf } from "./config.ts";
import { FILTERS, filterOnChain, matchesFilter } from "./search.ts";

/**
 * Circle's USDC and WETH on Base: the form offers neither, but scripts and agents pair with them (31 USDC launches and
 * one WETH launch by 2026-10-16), and until now they showed as unlisted pairs labelled by address, unpriced.
 */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

test("Base USDC is a known quote: USDC, 6 decimals, a fixed dollar", () => {
  for (const a of [USDC_BASE, USDC_BASE.toLowerCase()]) {
    const q = quoteInfo("base", a);
    assert.equal(q.key, "usdc");
    assert.equal(q.symbol, "USDC");
    assert.equal(q.decimals, 6);
    assert.equal(q.usd, 1);
    assert.equal(hasPriceSource(q), true);
  }
  assert.ok(fixedUsdQuotes().some((q) => q.chain === "base" && q.address === USDC_BASE.toLowerCase() && q.usd === 1 && q.decimals === 6), "the SQL sorts price it and read it at 6 decimals");
});

test("Base WETH is a known quote priced at ETH's live price, under its own symbol", () => {
  const q = quoteInfo("base", WETH_BASE);
  assert.equal(q.key, "eth");
  assert.equal(q.symbol, "WETH");
  assert.equal(q.decimals, 18);
  assert.equal(q.usd, null, "live, not fixed");
  assert.equal(quoteUsdOf(q, 3_210), 3_210);
  assert.equal(quoteUsdOf(q, null), null);
  assert.ok(!fixedUsdQuotes().some((x) => x.address === WETH_BASE.toLowerCase()), "never a fixed-price quote");
});

test("only on Base: the same addresses elsewhere are unlisted pairs", () => {
  for (const k of CHAIN_KEYS.filter((c) => c !== "base")) {
    assert.equal(quoteInfo(k, USDC_BASE).key, "other", k);
    assert.equal(quoteInfo(k, WETH_BASE).key, "other", k);
  }
});

test("known, so the indexer no longer reads them as unknown tokens", () => {
  const listed = listedQuoteAddresses("base");
  assert.ok(listed.includes(USDC_BASE.toLowerCase()));
  assert.ok(listed.includes(WETH_BASE.toLowerCase()));
});

test("never offered in the launch form", () => {
  const offered = launchpad("base").quotes.map((q) => q.address.toLowerCase());
  assert.ok(!offered.includes(USDC_BASE.toLowerCase()));
  assert.ok(!offered.includes(WETH_BASE.toLowerCase()));
  assert.deepEqual(launchpad("base").quotes.map((q) => q.key), ["eth", "twig"], "the form's eth is native ETH, never WETH");
});

test("WETH trades as an ERC-20: the trade panel decides native by address, not by key", () => {
  const panel = readFileSync(path.join(process.cwd(), "src/components/launchpad/TradePanel.tsx"), "utf8");
  assert.match(panel, /const isNative = quote\.address\.toLowerCase\(\) === NATIVE;/);
});

test("the USDC chip covers Base too", () => {
  const usdc = FILTERS.find((f) => f.key === "usdc")!;
  assert.equal(filterOnChain(usdc, "base"), true);
  assert.equal(filterOnChain(usdc, "arc"), true);
  assert.equal(filterOnChain(usdc, "robinhood"), false);
  const row = { name: "x", symbol: "X", token: "0x1", lp_fee: 10_000, quote_key: quoteInfo("base", USDC_BASE).key, block_time: new Date().toISOString(), recipients: [] };
  assert.equal(matchesFilter(row, "usdc"), true);
});
