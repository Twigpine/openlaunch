import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NATIVE, listedQuoteAddresses, quoteInfo, quoteUsdOf } from "./config.ts";
import { MAX_QUOTE_DECIMALS, addressLabel, cleanQuoteSymbol, unlistedQuote, validDecimals } from "./unlisted-quote.ts";
import { capDisplay } from "./market-cap.ts";
import { fdvQuote } from "./math.ts";

/**
 * The factory takes any ERC-20 as the quote (first seen 2026-09-25: SHEAF on Base). Such a pair is shown
 * as unlisted: the token's own symbol when it is safe to show, its real decimals, never a USD price, never trending.
 */
/** Any ERC-20 no list knows (UNLISTED, the first one seen, is an official quote since; see museworld.test.ts). */
const UNLISTED = "0x1234567890abcdef1234567890abcdef12345678";
const src = (rel: string) => readFileSync(path.join(import.meta.dirname, rel), "utf8");

test("an address no list knows is an unlisted quote: key other, labelled by address, never priced", () => {
  const q = quoteInfo("base", UNLISTED);
  assert.equal(q.key, "other");
  assert.equal(q.symbol, "0x1234…5678");
  assert.equal(q.decimalsKnown, false, "not read yet: 18 is a placeholder");
  assert.equal(quoteUsdOf(q, 4_000), null, "never priced, above all never at the ETH price");
  assert.ok(!listedQuoteAddresses("base").includes(UNLISTED));
  assert.ok(listedQuoteAddresses("base").includes(NATIVE), "the native asset is listed, so the indexer never reads address(0)");
});

test("the on-chain symbol and decimals are used once read", () => {
  const q = unlistedQuote(UNLISTED, { symbol: "PEPE", name: "Pepe", decimals: 18 });
  assert.deepEqual([q.key, q.symbol, q.decimals, q.decimalsKnown, q.usd], ["other", "PEPE", 18, true, null]);
});

test("a 6-decimal unlisted quote prices with 6 decimals, not the 18 placeholder (10^12 apart)", () => {
  const q = unlistedQuote(UNLISTED, { symbol: "MEME", name: null, decimals: 6 });
  assert.equal(q.decimals, 6);
  // 1 MEME per token: sqrtPriceX96 for price (currency1 per currency0 raw) = 1e18 / 1e6 = 1e12 → sqrt = 1e6 · 2^96
  const sqrt = 10n ** 6n * 2n ** 96n;
  const cap = fdvQuote(sqrt, 10n ** 27n, q.decimals);
  assert.ok(Math.abs(cap - 1e9) / 1e9 < 1e-9, `1B supply at 1 MEME = 1B MEME, got ${cap}`);
  assert.match(capDisplay(cap, null, q).compact, /MEME · no USD price$/);
});

test("unreadable or absurd decimals stay unknown", () => {
  for (const d of [null, -1, 1.5, MAX_QUOTE_DECIMALS + 1, 255, Number.NaN]) {
    assert.equal(validDecimals(d), false, String(d));
    assert.equal(unlistedQuote(UNLISTED, { symbol: "X", name: null, decimals: d as number | null }).decimalsKnown, false, String(d));
  }
  for (const d of [0, 6, 8, 18, MAX_QUOTE_DECIMALS]) assert.equal(validDecimals(d), true, String(d));
});

test("a symbol that is, or dresses up as, a listed asset is replaced by the address", () => {
  for (const fake of ["USDC", "usdc", "$ETH", "WETH", "USDC.e", "USD+", "USDbC", "cbBTC", "GITLAWB", "gitlawb2", "Ｕ​ＳＤＣ", " E T H "]) {
    assert.equal(cleanQuoteSymbol(fake), null, fake);
    assert.equal(unlistedQuote(UNLISTED, { symbol: fake, name: null, decimals: 6 }).symbol, addressLabel(UNLISTED), fake);
  }
  assert.equal(cleanQuoteSymbol("NVDAx", ["NVDAx"]), null, "the chain's stock tickers are reserved too");
});

test("look-alike letters from other scripts cannot spell a listed symbol", () => {
  // Cyrillic С (U+0421) and Greek Τ/Η: stripped, never shown as the ASCII look-alike
  assert.notEqual(cleanQuoteSymbol("USDС"), "USDC");
  assert.equal(cleanQuoteSymbol("EΤΗ"), "E");
  assert.equal(cleanQuoteSymbol("ЕΤΗ"), null, "nothing ASCII left");
});

test("symbols are cleaned: ASCII word characters only, bounded, no control or markup", () => {
  assert.equal(cleanQuoteSymbol("PEPE"), "PEPE");
  assert.equal(cleanQuoteSymbol("$PEPE"), "PEPE");
  assert.equal(cleanQuoteSymbol("<b>DOGE</b>"), "bDOGEb");
  assert.equal(cleanQuoteSymbol("A\u0000B\nC"), "ABC");
  assert.equal(cleanQuoteSymbol("ABCDEFGHIJKLMNOPQRST")?.length, 12);
  assert.equal(cleanQuoteSymbol(""), null);
  assert.equal(cleanQuoteSymbol(null), null);
  assert.equal(cleanQuoteSymbol("🚀🚀"), null);
});

test("the server resolves unlisted quotes from bb_quote_tokens, fails soft, and keeps them out of Trending", () => {
  const q = src("queries.ts");
  assert.match(q, /return unlistedQuote\(address, quoteTokensNow\.get\(`\$\{chainIdOf\(chain\)\}:\$\{address\.toLowerCase\(\)\}`\)/);
  assert.match(q, /quoteTokensNow = await memo\("quote-tokens"/);
  assert.match(q, /\/\* fail soft \(table not migrated yet/);
  assert.match(q, /rankTrending\(rows\.filter\(\(r\) => r\.quote_key !== "other"\)/);
  assert.match(q, /quote_decimals_known: q\.decimalsKnown !== false/);
  assert.match(q, /usd === null && q\.key !== "other"/, "unlisted quotes do not flag the site USD totals as partial");
});

test("the indexer reads unlisted quotes into bb_quote_tokens with printable text only", () => {
  const i = src("indexer.ts");
  assert.match(i, /await healQuoteTokens\(c\)\.catch/);
  assert.match(i, /l\.quote <> ALL\(\$\{listedQuoteAddresses\(chain\)\}\)/);
  assert.match(i, /replace\(\/\[\\u0000-\\u001f\\u007f\]\/g, ""\)/, "Postgres text refuses NUL; a token picks its own strings");
  const schema = readFileSync(path.join(import.meta.dirname, "../../../db/schema.sql"), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS bb_quote_tokens \(/);
});

test("the token page and trade panel mark the pair and refuse to trade unknown decimals", () => {
  const page = src("../../app/t/[chain]/[token]/page.tsx");
  assert.match(page, /key: l\.quote_key,/, "the server's key, not the static list's");
  assert.match(page, /decimalsKnown: l\.quote_decimals_known/);
  assert.match(page, /<UnlistedPairBadge symbol=\{quote\.symbol\} \/>/);
  const panel = src("../../components/launchpad/TradePanel.tsx");
  assert.match(panel, /const tradable = quote\.decimalsKnown !== false;/);
  assert.match(panel, /if \(!tradable \|\| !address/);
  assert.match(panel, /\{!configured \|\| !tradable \?/);
  assert.match(panel, /<b>Unlisted pair\.<\/b>/);
});
