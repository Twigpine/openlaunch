import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMcap, MCAP_HIGH_USD, MCAP_SUPPORT_RATIO, parseMcapMode, type McapFacts } from "./mcap-policy.ts";

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
