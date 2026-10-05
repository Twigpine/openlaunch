import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedItem } from "./queries";
import { COMPACT_SCALE, RIVER_HEIGHT, RIVER_WINDOW_MS, feedKey, inRiverWindow, initialRiver, layoutRiver, mergeRiver, pruneRiver, riverCoverage, riverSummary, riverUsd, type RiverEntry } from "./river.ts";

const NOW = Date.parse("2026-10-04T16:48:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const WIDTH = { wide: 1120, compact: 340 };

let n = 0;
function swap(o: { ago: number; buy?: boolean; usd?: number | null; symbol?: string; token?: string; log?: number }): FeedItem {
  n += 1;
  return {
    kind: "swap", chain: "base", at: iso(o.ago), tx_hash: `0x${n.toString(16).padStart(64, "0")}`, log_index: o.log ?? 0,
    token: o.token ?? "0xf3018d16d3c75f86df76bdeed12027c813f4e4a0", name: "Waifu", symbol: o.symbol ?? "WAIFU",
    trader: "0x1111111111111111111111111111111111111111", is_buy: o.buy ?? true, is_dev: false, quote_wei: "1000000000000000",
    quote_key: "eth", quote_symbol: "ETH", quote_decimals: 18, usd: o.usd === undefined ? 50 : o.usd, image_url: null,
  };
}
function launch(o: { ago: number; symbol?: string; token?: string }): FeedItem {
  n += 1;
  return {
    kind: "launch", chain: "robinhood", at: iso(o.ago), tx_hash: `0x${n.toString(16).padStart(64, "0")}`,
    token: o.token ?? `0x${n.toString(16).padStart(40, "0")}`, name: o.symbol ?? "Fresh", symbol: o.symbol ?? "FRESH",
    launcher: "0x2222222222222222222222222222222222222222", lp_fee: 10_000, quote_key: "eth", image_url: null,
  };
}
const entries = (items: FeedItem[], seenAt = NOW): RiverEntry[] => initialRiver(items, seenAt);
const only = (items: FeedItem[]) => layoutRiver(entries(items), WIDTH);

test("feed keys separate logs within one transaction and kinds within one token", () => {
  const a = swap({ ago: 1_000, log: 3 });
  const b = { ...a, log_index: 4 };
  assert.notEqual(feedKey(a), feedKey(b));
  assert.equal(feedKey(a), feedKey({ ...a }));
  const l = launch({ ago: 1_000 });
  assert.match(feedKey(l), /^robinhood:launch:0x[0-9a-f]+:0x[0-9a-f]+$/);
});

test("the window is the last 30 minutes, with a minute of grace for a clock running ahead", () => {
  assert.equal(inRiverWindow(swap({ ago: 0 }), NOW), true);
  assert.equal(inRiverWindow(swap({ ago: RIVER_WINDOW_MS }), NOW), true);
  assert.equal(inRiverWindow(swap({ ago: RIVER_WINDOW_MS + 1 }), NOW), false);
  assert.equal(inRiverWindow(swap({ ago: -30_000 }), NOW), true, "a server clock 30s ahead keeps the trade");
  assert.equal(inRiverWindow(swap({ ago: -120_000 }), NOW), false);
  assert.equal(inRiverWindow({ ...swap({ ago: 0 }), at: "not a date" }, NOW), false);
});

test("the first paint holds only in-window events, newest first, none of them fresh", () => {
  const old = swap({ ago: 40 * 60_000 });
  const a = swap({ ago: 60_000 });
  const b = launch({ ago: 5 * 60_000 });
  const river = initialRiver([b, old, a, a], NOW);
  assert.deepEqual(river.map((e) => feedKey(e.item)), [feedKey(a), feedKey(b)]);
  assert.ok(river.every((e) => !e.fresh && e.seenAt === NOW));
});

test("a poll keeps when known events were first seen, refreshes their payload and marks arrivals fresh", () => {
  const known = swap({ ago: 2 * 60_000, usd: null });
  const river = initialRiver([known], NOW - 5_000);
  const priced = { ...known, usd: 42 };
  const arrival = swap({ ago: 1_000, buy: false });
  const next = mergeRiver(river, [arrival, priced], NOW);
  assert.equal(next.length, 2);
  const [first, second] = next;
  assert.equal(feedKey(first.item), feedKey(arrival));
  assert.equal(first.fresh, true);
  assert.equal(first.seenAt, NOW);
  assert.equal(second.seenAt, NOW - 5_000, "a known event never re-seeds its animation offset");
  assert.equal(second.fresh, false);
  assert.equal(second.item.kind === "swap" && second.item.usd, 42, "the newer payload wins");
});

test("events leave once they pass the window; pruning without change keeps the same array", () => {
  const leaving = swap({ ago: RIVER_WINDOW_MS - 1_000 });
  const staying = swap({ ago: 1_000 });
  const river = initialRiver([leaving, staying], NOW);
  assert.equal(pruneRiver(river, NOW), river);
  const later = pruneRiver(river, NOW + 2_000);
  assert.deepEqual(later.map((e) => feedKey(e.item)), [feedKey(staying)]);
  assert.equal(mergeRiver(river, [], NOW + 2_000).length, 1);
});

test("dollar labels stay short", () => {
  assert.equal(riverUsd(0.004), "<$0.01");
  assert.equal(riverUsd(5.2), "$5.20");
  assert.equal(riverUsd(9.999), "$10");
  assert.equal(riverUsd(54.4), "$54");
  assert.equal(riverUsd(999.4), "$999");
  assert.equal(riverUsd(999.6), "$1K");
  assert.equal(riverUsd(1_240), "$1.2K");
  assert.equal(riverUsd(2_500_000), "$2.5M");
  assert.equal(riverUsd(Number.NaN), "$0");
});

test("the summary counts trades and launches in plain words", () => {
  assert.equal(riverSummary([]), "Nothing in the last 30 minutes");
  assert.equal(riverSummary(entries([swap({ ago: 1 })])), "1 trade in the last 30 minutes");
  assert.equal(riverSummary(entries([launch({ ago: 1 })])), "1 launch in the last 30 minutes");
  assert.equal(riverSummary(entries([swap({ ago: 1 }), swap({ ago: 2 }), launch({ ago: 3 })])), "2 trades and 1 launch in the last 30 minutes");
  assert.equal(riverSummary(entries([swap({ ago: 1 }), launch({ ago: 2 }), launch({ ago: 3 })])), "1 trade and 2 launches in the last 30 minutes");
});

test("a full seed whose oldest event is inside the window says latest, never a window total", () => {
  const busy = Array.from({ length: 5 }, (_, i) => swap({ ago: i * 60_000 }));
  assert.equal(riverCoverage(busy, 10, NOW), null, "fewer than the limit: nothing was cut off");
  const cutAt = Date.parse(busy[4].at);
  assert.equal(riverCoverage(busy, 5, NOW), cutAt, "full, and the oldest is 4 minutes old: older events may be missing");
  assert.equal(riverCoverage([...busy.slice(0, 4), swap({ ago: RIVER_WINDOW_MS + 60_000 })], 5, NOW), null, "the seed reaches past the window");
  const seen = entries(busy);
  assert.equal(riverSummary(seen, false), "Latest 5 trades");
  assert.equal(riverSummary(seen, true), "5 trades in the last 30 minutes");
});

test("buys rise above the line, sells sit below it, launches land on it, and size follows dollars", () => {
  const [buy, sell, l] = only([swap({ ago: 60_000, usd: 50 }), swap({ ago: 120_000, buy: false, usd: 50 }), launch({ ago: 180_000 })]);
  assert.equal(buy.kind, "buy");
  assert.ok(buy.y < 0.5);
  assert.equal(sell.kind, "sell");
  assert.ok(sell.y > 0.5);
  assert.ok(Math.abs(Math.abs(0.5 - buy.y) - Math.abs(sell.y - 0.5)) < 1e-9, "same size, mirrored");
  assert.equal(l.kind, "launch");
  assert.equal(l.y, 0.5);
  const [small, big] = only([swap({ ago: 60_000, usd: 5 }), swap({ ago: 6 * 60_000, usd: 5_000 })]);
  assert.ok(big.r > small.r);
  assert.ok(big.y < small.y, "a bigger buy rises further");
});

test("even a whale stays inside both field sizes", () => {
  for (const buy of [true, false]) {
    const [m] = only([swap({ ago: 60_000, buy, usd: 5_000_000 })]);
    for (const size of ["wide", "compact"] as const) {
      const h = RIVER_HEIGHT[size];
      const r = m.r * (size === "compact" ? COMPACT_SCALE : 1);
      assert.ok(m.y * h - r >= 0 && m.y * h + r <= h, `${buy ? "buy" : "sell"} fits the ${size} field`);
    }
  }
});

test("an unpriced trade draws small and unlabelled; it never borrows a dollar figure", () => {
  const [m] = only([swap({ ago: 60_000, usd: null })]);
  assert.equal(m.label, null);
  assert.deepEqual(m.showLabel, { wide: false, compact: false });
  assert.ok(m.r < 8);
});

test("a mark's animation offset is its age when this client first saw it", () => {
  const item = swap({ ago: 90_000 });
  const [m] = layoutRiver(initialRiver([item], NOW), WIDTH);
  assert.equal(m.ageAtSeen, 90_000);
  const [future] = layoutRiver(initialRiver([swap({ ago: -20_000 })], NOW), WIDTH);
  assert.equal(future.ageAtSeen, 0, "a trade stamped slightly ahead starts at the right edge");
});

test("a burst in one lane stacks instead of overlapping, and arrivals never move earlier marks", () => {
  const a = swap({ ago: 30_000, usd: 50 });
  const b = swap({ ago: 26_000, usd: 50 });
  const c = swap({ ago: 22_000, usd: 50 });
  const [mc, mb, ma] = only([a, b, c]);
  assert.deepEqual([ma.nudge, mb.nudge, mc.nudge], [0, 7, 14]);
  assert.ok(mc.y < mb.y && mb.y < ma.y, "each stacked buy sits a little higher");
  const before = only([a, b]);
  const after = only([a, b, c]);
  for (const m of before) {
    const same = after.find((x) => x.key === m.key)!;
    assert.deepEqual([same.y, same.r, same.nudge], [m.y, m.r, m.nudge]);
  }
  const [lone] = only([swap({ ago: 30_000 + 60_000, usd: 50 })]);
  assert.equal(lone.nudge, 0);
});

test("labels show where they fit: the bigger of two colliding trades wins, small ones wait for hover", () => {
  const big = swap({ ago: 60_000, usd: 400, symbol: "BIG" });
  const near = swap({ ago: 61_000, usd: 380, symbol: "NEAR", token: "0x5b3c2cd87083ea5c4436525dca6213740405b69e" });
  const tiny = swap({ ago: 10 * 60_000, usd: 8, symbol: "TINY" });
  const marks = only([big, near, tiny]);
  const by = (s: string) => marks.find((m) => m.label?.startsWith(s))!;
  assert.equal(by("BIG").label, "BIG $400");
  assert.equal(by("BIG").showLabel.wide, true);
  assert.equal(by("NEAR").showLabel.wide, false, "it would overlap BIG");
  assert.equal(by("TINY").showLabel.wide, false, "under the $20 floor");
  assert.equal(by("TINY").label, "TINY $8.00", "still labelled on hover");
});

test("launch labels try their side, then the other; a phone shows the mark without the name", () => {
  const first = launch({ ago: 60_000, symbol: "ONE", token: "0x0000000000000000000000000000000000000002" });
  const second = launch({ ago: 61_000, symbol: "TWO", token: "0x0000000000000000000000000000000000000004" });
  const marks = only([first, second]);
  assert.ok(marks.every((m) => m.showLabel.wide), "two launches a second apart both get names");
  assert.notEqual(marks[0].side, marks[1].side, "one above the line, one below");
  assert.ok(marks.every((m) => !m.showLabel.compact));
});

test("labels near the far edge give way rather than spill out of the field", () => {
  const edge = swap({ ago: RIVER_WINDOW_MS - 5_000, usd: 500, symbol: "OLD" });
  const [m] = only([edge, swap({ ago: 0, usd: 1 })]).filter((x) => x.label?.startsWith("OLD"));
  assert.equal(m.showLabel.wide, false);
});
