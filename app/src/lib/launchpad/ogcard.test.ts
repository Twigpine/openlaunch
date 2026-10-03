import { test } from "node:test";
import assert from "node:assert/strict";
import { ageLabel, shapeCard, type CardInput } from "./ogcard.ts";

const input = (over: Partial<CardInput> = {}): CardInput => ({
  name: "Test",
  symbol: "TEST",
  chain: "base",
  fdv_usd: 12345,
  fdv_quote: 12345,
  quote_key: "eth",
  quote_symbol: "ETH",
  change_from_launch: 0,
  lp_fee: 0,
  recipients: [],
  block_time: "2026-09-06T09:30:00Z",
  ...over,
});

test("ageLabel counts seconds under a minute and rejects garbage dates", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  assert.equal(ageLabel("2026-09-06T11:59:55Z", now), "5s old");
  assert.equal(ageLabel("2026-09-06T11:59:30Z", now), "30s old");
  assert.equal(ageLabel("2026-09-06T11:00:00Z", now), "1h old");
  assert.equal(ageLabel("2026-09-06T09:30:00Z", now), "2h old");
  assert.equal(ageLabel("garbage", now), "—", "invalid dates never render NaN");
  assert.equal(ageLabel("2026-09-06T09:30:00Z", Number.NaN), "—");
});

test("shapeCard never renders NaN/Infinity market caps", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  assert.equal(shapeCard(input({ fdv_usd: Number.NaN }), now).mcap, "—");
  assert.equal(shapeCard(input({ fdv_usd: Infinity }), now).mcap, "—");
  assert.equal(shapeCard(input({ fdv_usd: null, fdv_quote: Number.NaN, quote_symbol: "ETH" }), now).mcap, "—");
  assert.equal(shapeCard(input({ fdv_usd: 12345 }), now).mcap, "$12.3K", "finite caps keep their format");
  assert.equal(shapeCard(input({ fdv_usd: null, fdv_quote: 2.5, quote_symbol: "ETH" }), now).mcap, "2.50 ETH");
});

test("shapeCard renders a neutral dash for non-finite change, not NaN%/+—%", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  assert.deepEqual(
    { change: shapeCard(input({ change_from_launch: Number.NaN }), now).change, up: shapeCard(input({ change_from_launch: Number.NaN }), now).up },
    { change: "—", up: null },
  );
  assert.deepEqual(
    { change: shapeCard(input({ change_from_launch: Infinity }), now).change, up: shapeCard(input({ change_from_launch: Infinity }), now).up },
    { change: "—", up: null },
  );
  const finite = shapeCard(input({ change_from_launch: 0.234 }), now);
  assert.equal(finite.change, "+23%");
  assert.equal(finite.up, true);
});
