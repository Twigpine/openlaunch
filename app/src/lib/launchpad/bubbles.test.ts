import assert from "node:assert/strict";
import test from "node:test";
import type { FeedItem } from "./queries.ts";
import { BUBBLE_ENOUGH, BUBBLE_HISTORY_MS, BUBBLE_WINDOWS_MS, aggregateBubbles, bubbleLean, bubbleRadii, bubbleSummary, bubbleVolume, bubbleWindow, bubbleWindowLabel, type BubbleToken } from "./bubbles.ts";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
let n = 0;
const swap = (token: string, minutes: number, is_buy: boolean, usd: number | null, chain: FeedItem["chain"] = "base"): FeedItem => ({
  kind: "swap", chain, at: ago(minutes), tx_hash: `0x${(++n).toString(16).padStart(64, "0")}`, log_index: 0, token, name: `Token ${token}`, symbol: token.toUpperCase().slice(2, 6),
  trader: null, is_buy, is_dev: false, quote_wei: "1", quote_key: "eth", quote_symbol: "ETH", quote_decimals: 18, usd, image_url: null,
});
const launch = (token: string, minutes: number): FeedItem => ({
  kind: "launch", chain: "base", at: ago(minutes), tx_hash: `0x${(++n).toString(16).padStart(64, "0")}`, token, name: `Token ${token}`, symbol: token.toUpperCase().slice(2, 6), launcher: "0x1", lp_fee: 0, quote_key: "eth", image_url: null,
});

test("totals per token: priced dollars by side, every trade counted, unpriced ones never valued", () => {
  const items = [swap("0xaa", 1, true, 100), swap("0xaa", 2, false, 40), swap("0xAA", 3, true, null), swap("0xbb", 4, true, 10), launch("0xcc", 5)];
  const [a, b, c] = aggregateBubbles(items, NOW, BUBBLE_WINDOWS_MS[0]);
  assert.equal(a.id, "base:0xaa", "one bubble per token, whatever the address case");
  assert.deepEqual([a.bought, a.sold, a.buys, a.sells, a.unpriced, a.launched], [100, 40, 2, 1, 1, false]);
  assert.equal(bubbleVolume(a), 140);
  assert.equal(b.id, "base:0xbb");
  assert.equal(c.id, "base:0xcc");
  assert.equal(c.launched, true);
  assert.equal(c.buys + c.sells, 0);
});

test("the same token on two chains is two bubbles, and only the window counts", () => {
  const items = [swap("0xaa", 1, true, 5, "base"), swap("0xaa", 1, true, 5, "robinhood"), swap("0xaa", 45, true, 500, "base")];
  const held = aggregateBubbles(items, NOW, BUBBLE_WINDOWS_MS[0]);
  assert.deepEqual(held.map((b) => b.id).sort(), ["base:0xaa", "robinhood:0xaa"]);
  assert.equal(held.find((b) => b.id === "base:0xaa")!.bought, 5, "the 45-minute-old trade is outside 30 minutes");
});

test("the window widens only until it holds enough activity, and stops at a day", () => {
  const busy = Array.from({ length: BUBBLE_ENOUGH.events }, (_, i) => swap("0xaa", 1 + i, true, 1));
  assert.equal(bubbleWindow(busy, NOW), 30 * 60_000);
  const manyTokens = Array.from({ length: BUBBLE_ENOUGH.tokens }, (_, i) => swap(`0x${i}`, 20, true, 1));
  assert.equal(bubbleWindow(manyTokens, NOW), 30 * 60_000);
  const quiet = Array.from({ length: BUBBLE_ENOUGH.events }, (_, i) => swap("0xaa", 9 * 60 + i, true, 1));
  assert.equal(bubbleWindow(quiet, NOW), 24 * 3_600_000, "nine hours quiet: the day window holds them");
  const twoHours = Array.from({ length: BUBBLE_ENOUGH.events }, (_, i) => swap("0xaa", 100 + i, true, 1));
  assert.equal(bubbleWindow(twoHours, NOW), 3 * 3_600_000);
  assert.equal(bubbleWindow([], NOW), BUBBLE_HISTORY_MS);
});

test("the lean follows the priced dollars, falls back to counts, reads even inside a tenth, and new without trades", () => {
  const base: BubbleToken = { id: "base:0x", chain: "base", token: "0x", name: "x", symbol: "X", image_url: null, bought: 0, sold: 0, buys: 0, sells: 0, unpriced: 0, launched: true, lastAt: NOW };
  assert.deepEqual(bubbleLean(base), { side: "new", strength: 1 });
  assert.equal(bubbleLean({ ...base, bought: 90, sold: 10, buys: 3, sells: 1 }).side, "buy");
  assert.equal(bubbleLean({ ...base, bought: 90, sold: 10, buys: 3, sells: 1 }).strength, 0.8);
  assert.equal(bubbleLean({ ...base, bought: 10, sold: 90, buys: 9, sells: 1 }).side, "sell", "dollars decide, not the number of trades");
  assert.equal(bubbleLean({ ...base, bought: 52, sold: 48, buys: 1, sells: 1 }).side, "even");
  assert.equal(bubbleLean({ ...base, buys: 3, sells: 1, unpriced: 4 }).side, "buy", "no dollar price: counts decide");
});

test("radii: area follows dollars, zero-dollar tokens sit at the small end, and every radius stays in bounds", () => {
  const t = (id: string, bought: number): BubbleToken => ({ id, chain: "base", token: id, name: id, symbol: id, image_url: null, bought, sold: 0, buys: bought ? 1 : 0, sells: 0, unpriced: 0, launched: !bought, lastAt: NOW });
  const tokens = [t("a", 400), t("b", 100), t("c", 0)];
  const [ra, rb, rc] = bubbleRadii(tokens, 800 * 300, { min: 10, max: 200 });
  assert.ok(Math.abs(ra / rb - 2) < 1e-9, "four times the dollars, twice the radius");
  assert.equal(rc, rb, "a launch with no trade is drawn like the smallest priced token, never larger");
  const covered = [ra, rb, rc].reduce((sum, r) => sum + Math.PI * r * r, 0);
  assert.ok(Math.abs(covered / (800 * 300) - 0.4) < 1e-9, "the bubbles cover the asked share of the field");
  const clamped = bubbleRadii([t("a", 1e9), t("b", 1)], 800 * 300, { min: 14, max: 80 });
  assert.equal(clamped[0], 80);
  assert.equal(clamped[1], 14);
  assert.deepEqual(bubbleRadii([], 1000, { min: 1, max: 2 }), []);
});

test("labels and the summary say what is held, and a cut-off seed never claims the whole window", () => {
  assert.equal(bubbleWindowLabel(30 * 60_000), "30 minutes");
  assert.equal(bubbleWindowLabel(60 * 60_000), "hour");
  assert.equal(bubbleWindowLabel(6 * 3_600_000), "6 hours");
  const held = aggregateBubbles([swap("0xaa", 1, true, 5), swap("0xaa", 2, false, 5), swap("0xbb", 3, true, 5), launch("0xcc", 4)], NOW, 30 * 60_000);
  assert.equal(bubbleSummary(held, 30 * 60_000, true), "3 tokens, 3 trades and 1 launch in the last 30 minutes");
  assert.equal(bubbleSummary(held, 30 * 60_000, false), "3 tokens in the latest 3 trades and 1 launch");
  assert.equal(bubbleSummary([], 30 * 60_000, true), "Nothing traded or launched in the last 24 hours");
});
