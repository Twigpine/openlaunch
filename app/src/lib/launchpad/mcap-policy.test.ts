import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { API_MCAP_DEFAULT, classifyMcap, MCAP_HIGH_USD, MCAP_SUPPORT_RATIO, parseMcapMode, type McapFacts } from "./mcap-policy.ts";

/** Start with an unsupported high valuation and override only the facts relevant to each policy boundary. */
const facts = (overrides: Partial<McapFacts> = {}): McapFacts => ({ startFdvQuote: 20_000_000, fdvQuote: 20_000_000, quoteUsd: 1, outsideVolumeQuote: 0, outsideTraders: 0, ...overrides });

test("small launches need no volume, trades or holders; DOTTIE remains included on a quiet day", () => {
  for (const fdv of [1, 5_000, 25_700, 100_000, MCAP_HIGH_USD - 1]) {
    assert.equal(classifyMcap(facts({ startFdvQuote: fdv, fdvQuote: fdv, outsideVolumeQuote: null, outsideTraders: null })), "included");
  }
});
test("both launch and current valuations must be high", () => {
  assert.equal(classifyMcap(facts({ startFdvQuote: 25_000, fdvQuote: 50_000_000 })), "included");
  assert.equal(classifyMcap(facts({ startFdvQuote: 50_000_000, fdvQuote: 25_000 })), "included");
  assert.equal(classifyMcap(facts({ startFdvQuote: 1e35, fdvQuote: 1e35, outsideVolumeQuote: 0.02 })), "limited-outside-trading");
});
test("extreme valuations need enough lifetime volume and distinct meaningful outside wallets", () => {
  const start = MCAP_HIGH_USD;
  const supported = facts({ startFdvQuote: start, fdvQuote: start, outsideVolumeQuote: start * MCAP_SUPPORT_RATIO, outsideTraders: 3 });
  assert.equal(classifyMcap(supported), "included");
  assert.equal(classifyMcap({ ...supported, outsideVolumeQuote: supported.outsideVolumeQuote! - 0.01 }), "limited-outside-trading");
  assert.equal(classifyMcap({ ...supported, outsideTraders: 2 }), "limited-outside-trading");
  assert.equal(classifyMcap(facts({ startFdvQuote: start / 2500, fdvQuote: start / 2500, quoteUsd: 2500, outsideVolumeQuote: start / 2500 * MCAP_SUPPORT_RATIO, outsideTraders: 3 })), "included");
});
test("unknown or invalid prices cannot classify a launch as an outlier", () => {
  for (const quoteUsd of [null, 0, -1, NaN, Infinity]) assert.equal(classifyMcap(facts({ quoteUsd })), "unpriced");
  for (const fdvQuote of [0, -1, NaN, Infinity]) assert.equal(classifyMcap(facts({ fdvQuote })), "unpriced");
  assert.equal(classifyMcap(facts({ fdvQuote: Number.MAX_VALUE, quoteUsd: 2 })), "unpriced");
});
test("market-cap mode is allow-listed and defaults to filtered", () => {
  assert.equal(parseMcapMode("all"), "all");
  for (const raw of [undefined, null, "filtered", "ALL", "true", ["all"]]) assert.equal(parseMcapMode(raw), "filtered");
});

test("the site defaults to the filter; the API keeps its unfiltered order unless asked", () => {
  for (const raw of [undefined, null, "", "ALL", "junk"]) assert.equal(parseMcapMode(raw), "filtered");
  for (const raw of [undefined, null, "", "junk"]) assert.equal(parseMcapMode(raw, API_MCAP_DEFAULT), "all");
  assert.equal(API_MCAP_DEFAULT, "all");
  for (const fallback of ["filtered", "all"] as const) {
    assert.equal(parseMcapMode("filtered", fallback), "filtered");
    assert.equal(parseMcapMode("all", fallback), "all");
  }
});

test("the list query's size does not grow with the unlisted quote tokens or a whole stock registry", () => {
  const q = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  // unlisted decimals come from one primary-key lookup in SQL, never one bound CASE arm per bb_quote_tokens row
  assert.match(q, /COALESCE\(\(SELECT qt\.decimals FROM bb_quote_tokens qt WHERE qt\.chain_id = l\.chain_id AND qt\.address = l\.quote AND qt\.decimals BETWEEN 0 AND 36\), 18\)/);
  assert.match(q, /const qd = db`\(CASE \$\{stableDecCase\} \$\{pairDecCase\} \$\{decCase\} ELSE \$\{unlistedDec\} END\)`/);
  assert.doesNotMatch(q, /prices\.quoteTokens\.entries\(\)/);
  // stock decimals arms cover the stocks launches use (stockUsdInUse), not every registry entry
  assert.match(q, /const stockDecArms = \[\.\.\.prices\.stocks\.keys\(\)\]/);
  assert.doesNotMatch(q, /\[\.\.\.prices\.stockQuotes\.values\(\)\]/);
});

test("an ETH price outage keeps the volume fallback, but market cap takes ETH as unpriced", () => {
  const q = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  assert.match(q, /const ethFactor = ethUsdKnown \?\? 1;/);
  assert.match(q, /const usdPerUnit = usdPerUnitFor\(ethFactor\);/);
  assert.match(q, /const mcapUsdPerUnit = usdPerUnitFor\(ethUsdKnown\);/);
  assert.match(q, /mcapPageQuery\(db, \{[^}]*quoteUsd: mcapUsdPerUnit,/);
});
