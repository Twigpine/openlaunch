import assert from "node:assert/strict";
import test from "node:test";
import {
  dayRange,
  emptyStatsDay,
  fillStatsSeries,
  parseStatsChain,
  parseStatsFormat,
  parseStatsWindow,
  statsCsv,
  statsHref,
  statsTotals,
  utcDay,
  windowStartDay,
  type ProtocolStats,
  type StatsDay,
} from "./stats.ts";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0); // 2026-11-13T12:00:00Z

test("parseStatsWindow accepts only the four windows and keeps the caller's fallback", () => {
  assert.equal(parseStatsWindow("7d"), "7d");
  assert.equal(parseStatsWindow("30d"), "30d");
  assert.equal(parseStatsWindow("90d"), "90d");
  assert.equal(parseStatsWindow("all"), "all");
  assert.equal(parseStatsWindow("1y"), "30d");
  assert.equal(parseStatsWindow(null), "30d");
  assert.equal(parseStatsWindow("nope", "7d"), "7d");
});

test("parseStatsChain and parseStatsFormat reject everything they do not know", () => {
  assert.equal(parseStatsChain("base"), "base");
  assert.equal(parseStatsChain("elysium"), "elysium");
  assert.equal(parseStatsChain("ethereum"), null);
  assert.equal(parseStatsChain(null), null);
  assert.equal(parseStatsFormat("csv"), "csv");
  assert.equal(parseStatsFormat("JSON"), "json");
  assert.equal(parseStatsFormat(null), "json");
});

test("windowStartDay includes today and the days before it", () => {
  assert.equal(windowStartDay("7d", NOW), "2026-11-07");
  assert.equal(windowStartDay("30d", NOW), "2026-10-15");
  assert.equal(windowStartDay("90d", NOW), "2026-08-16");
  assert.equal(windowStartDay("all", NOW), null);
  assert.equal(utcDay(NOW), "2026-11-13");
});

test("dayRange is inclusive, finite and bounded", () => {
  assert.deepEqual(dayRange("2026-11-07", "2026-11-09"), ["2026-11-07", "2026-11-08", "2026-11-09"]);
  assert.deepEqual(dayRange("2026-11-09", "2026-11-07"), []);
  assert.deepEqual(dayRange("junk", "2026-11-09"), []);
});

test("fillStatsSeries leaves missing days at zero and keeps the values it has", () => {
  const a: StatsDay = { ...emptyStatsDay("2026-11-07"), launches: 2, launchers: 1, trades: 5, traders: 3, volume_usd: 100, fees_collected_usd: 4, fees_burned_usd: 1, unpriced_trades: 1 };
  const b: StatsDay = { ...emptyStatsDay("2026-11-09"), launches: 1, launchers: 1 };
  const out = fillStatsSeries([a, b], "2026-11-07", "2026-11-10");
  assert.deepEqual(out.map((d) => d.day), ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"]);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], emptyStatsDay("2026-11-08"));
  assert.deepEqual(out[2], b);
  assert.deepEqual(out[3], emptyStatsDay("2026-11-10"));
});

test("fillStatsSeries with no start day (all) begins at the first row", () => {
  const a = { ...emptyStatsDay("2026-10-01"), launches: 1 };
  const b = { ...emptyStatsDay("2026-10-03"), launches: 1 };
  assert.deepEqual(fillStatsSeries([b, a], null, "2026-10-04").map((d) => d.day), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(fillStatsSeries([], null, "2026-10-04"), []);
  assert.deepEqual(fillStatsSeries([a], "2026-10-02", "2026-10-04"), [emptyStatsDay("2026-10-02"), emptyStatsDay("2026-10-03"), emptyStatsDay("2026-10-04")]);
});

test("statsTotals derives creator fees and the partial-USD flag", () => {
  const totals = statsTotals({
    launches: 3,
    launchers: 2,
    trades: 10,
    traders: 4,
    volume_usd: 1_000,
    fees_collected_usd: 30,
    fees_burned_usd: 12,
    unpriced_trades: 0,
    unpriced_fee_events: 0,
  });
  assert.equal(totals.fees_to_creators_usd, 18);
  assert.equal(totals.usd_partial, false);
  assert.equal(statsTotals({ ...totals, unpriced_trades: 1 }).usd_partial, true);
  assert.equal(statsTotals({ ...totals, unpriced_fee_events: 1 }).usd_partial, true);
});

test("statsCsv is one header and one machine-readable row per day", () => {
  const day = { ...emptyStatsDay("2026-11-12"), launches: 2, launchers: 1, trades: 5, traders: 3, volume_usd: 1234.5, fees_collected_usd: 4, fees_burned_usd: 1.25, unpriced_trades: 1 };
  const stats: ProtocolStats = {
    window: "7d",
    chain: "base",
    available: true,
    since: "2026-11-12",
    until: "2026-11-13",
    generated_at: "2026-11-13T12:00:00.000Z",
    totals: statsTotals(day),
    by_chain: [{ chain: "base", ...statsTotals(day) }],
    series: [day],
    top: [],
  };
  const csv = statsCsv(stats);
  assert.equal(csv, "chain,day,launches,launchers,trades,traders,volume_usd,fees_collected_usd,fees_burned_usd,unpriced_trades,unpriced_fee_events\nbase,2026-11-12,2,1,5,3,1234.5,4,1.25,1,0\n");
  const allLines = statsCsv({ ...stats, chain: null }).trimEnd().split("\n");
  assert.match(allLines[1], /^all,2026-11-12,/);
});

test("statsHref keeps the default URL and encodes only real filters", () => {
  assert.equal(statsHref("30d", null), "/stats");
  assert.equal(statsHref("7d", null), "/stats?window=7d");
  assert.equal(statsHref("30d", "base"), "/stats?chain=base");
  assert.equal(statsHref("90d", "robinhood"), "/stats?window=90d&chain=robinhood");
});
