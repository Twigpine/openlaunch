import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CHAIN_IDS, CHAIN_KEYS, type ChainKey } from "../chainKeys.ts";
import { NATIVE_QUOTES, fixedUsdQuotes, quoteInfo as staticQuoteInfo, quotesWithKey } from "./config.ts";
import { unlistedQuote } from "./unlisted-quote.ts";
import type { Stock } from "./stocksServer";

const stocksSource = readFileSync(new URL("./stocksServer.ts", import.meta.url), "utf8");
const queriesSource = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
const SAME_ADDRESS = `0x${"ab".repeat(20)}`;
const NO_PRICE = `0x${"cd".repeat(20)}`;
const prices = new Map<ChainKey, Map<string, number | null>>([
  ["base", new Map([[SAME_ADDRESS, 125], [NO_PRICE, null]])],
  ["robinhood", new Map([[SAME_ADDRESS, 9]])],
  ["arc", new Map()],
]);

function evaluate<T>(source: string, globals: Record<string, unknown>): T {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api = {};
  new Function("exports", ...Object.keys(globals), output)(api, ...Object.values(globals));
  return api as T;
}

function stockByAddress(chain: ChainKey, address: string): Stock | null {
  if (chain === "arc" || ![SAME_ADDRESS, NO_PRICE].includes(address)) return null;
  return { chain, address, symbol: chain === "base" ? "BASEstock" : "RHstock", name: "Fixture stock", decimals: chain === "base" ? 18 : 6, logo: null };
}

test("in-use stock prices preserve different prices for the same address on different chains", async () => {
  const calls: { chain: ChainKey; addresses: string[] }[] = [];
  const source = stocksSource.slice(stocksSource.indexOf("export async function stockUsdInUse("));
  const api = evaluate<{ stockUsdInUse: () => Promise<Map<ChainKey, Map<string, number | null>>> }>(source, {
    CHAIN_KEYS,
    stockQuotesInUse: async () => ({ base: [SAME_ADDRESS, NO_PRICE], robinhood: [SAME_ADDRESS], arc: [] }),
    stockPrices: async (chain: ChainKey, addresses: string[]) => { calls.push({ chain, addresses }); return prices.get(chain)!; },
  });
  const result = await api.stockUsdInUse();
  assert.equal(result.get("base")?.get(SAME_ADDRESS), 125);
  assert.equal(result.get("robinhood")?.get(SAME_ADDRESS), 9);
  assert.equal(result.get("base")?.get(NO_PRICE), null);
  assert.equal(result.get("arc")?.size, 0);
  assert.deepEqual(calls, CHAIN_KEYS.map((chain) => ({ chain, addresses: [...prices.get(chain)!.keys()] })));
});

test("launch shaping resolves a registry stock price from its own chain only", () => {
  const start = queriesSource.indexOf("function quoteInfo(");
  const end = queriesSource.indexOf("async function readMuseworldUsd(");
  const api = evaluate<{ quoteInfo: (chain: ChainKey, address: string) => { usd: number | null; decimals: number; key: string } }>(`export ${queriesSource.slice(start, end)}`, {
    staticQuoteInfo, stockByAddress, stockUsdNow: prices, unlistedQuote,
    chainIdOf: (chain: ChainKey) => CHAIN_IDS[chain], quoteTokensNow: new Map(), stockSymbolsNow: new Map(),
    gitlawbUsdNow: null, museworldUsdNow: null,
  });
  assert.equal(api.quoteInfo("base", SAME_ADDRESS).usd, 125);
  assert.equal(api.quoteInfo("robinhood", SAME_ADDRESS).usd, 9);
  assert.equal(api.quoteInfo("robinhood", SAME_ADDRESS).decimals, 6);
  assert.equal(api.quoteInfo("base", NO_PRICE).usd, null);
  assert.equal(api.quoteInfo("arc", SAME_ADDRESS).key, "other", "an address registered elsewhere is still unlisted on Arc");
  assert.equal(api.quoteInfo("arc", SAME_ADDRESS).usd, null);
});

test("SQL USD sorts keep each stock's price and decimals scoped to its chain", async () => {
  for (const sort of ["mcap", "volume"]) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const db = Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
      const fragment = { sql: parts.join("?"), values };
      calls.push(fragment);
      return fragment.sql.includes("LIMIT") ? Promise.resolve([]) : fragment;
    }, { unsafe: (sql: string) => sql });
    const source = queriesSource.slice(queriesSource.indexOf("export async function listLaunchesPage("), queriesSource.indexOf("/** Back-compat:"));
    const api = evaluate<{ listLaunchesPage: (opts: { sort: string }) => Promise<{ items: unknown[] }> }>(source, {
      maybeDb: () => db, withStocks: async () => {}, stockUsdNow: prices, stockByAddress,
      CHAIN_KEYS, chainIdOf: (chain: ChainKey) => CHAIN_IDS[chain], NATIVE_QUOTES, fixedUsdQuotes, quotesWithKey,
      NATIVE_ADDR: "0x0000000000000000000000000000000000000000", DEAD_ADDR: "0x000000000000000000000000000000000000dead",
      gitlawbUsdNow: null, museworldUsdNow: null, SELECT: "SELECT l.* FROM bb_launches l", shape: (row: unknown) => row,
    });
    assert.deepEqual((await api.listLaunchesPage({ sort })).items, []);
    const arms = calls.filter((call) => call.sql === "WHEN (l.chain_id = ? AND l.quote = ?) THEN ?::double precision" && call.values[1] === SAME_ADDRESS);
    assert.deepEqual(arms.map((call) => call.values), [[8453, SAME_ADDRESS, 125], [4663, SAME_ADDRESS, 9]], sort);
    assert.ok(calls.some((call) => call.sql === "WHEN (l.chain_id = ? AND l.quote = ?) THEN ?" && call.values[0] === 4663 && call.values[1] === SAME_ADDRESS && call.values[2] === 6));
    assert.ok(!calls.some((call) => call.values[1] === NO_PRICE), "unknown stock prices receive no USD sorting arm");
  }
});
