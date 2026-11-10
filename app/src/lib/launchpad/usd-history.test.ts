import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HOUR_MS, backfillHours, buildBackfillSql, captureDue, fillHours, hourIso, hourSql, hourStartMs, multiplySeries, parseCoinbaseCandles,
  parseGeckoOhlcv, parseHyperliquidCandles, quoteSeriesRows, type SeriesKey,
} from "./usd-history.ts";

const H = (iso: string) => Date.parse(iso);

test("hour buckets are UTC hour starts, from ms, ISO or Date", () => {
  assert.equal(hourIso("2026-09-06T10:59:59.999Z"), "2026-09-06T10:00:00.000Z");
  assert.equal(hourIso(H("2026-09-06T11:00:00Z")), "2026-09-06T11:00:00.000Z");
  assert.equal(hourIso(new Date("2026-09-06T11:30:00+05:30")), "2026-09-06T06:00:00.000Z", "offsets resolve to the UTC hour");
  assert.throws(() => hourStartMs("not a date"));
  // the SQL bucket is zone independent (date_trunc on timestamptz truncates in the session zone) and refuses odd input
  assert.equal(hourSql("s.block_time"), "to_timestamp(floor(extract(epoch FROM s.block_time) / 3600) * 3600)");
  assert.throws(() => hourSql("s.block_time); DROP TABLE x; --"));
});

test("a backfill stops at the last completed hour: the hour in progress is the live capture's", () => {
  const r = backfillHours("2026-09-01T00:00:00Z", H("2026-11-10T14:37:00Z"));
  assert.equal(new Date(r.from).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(new Date(r.to).toISOString(), "2026-11-10T13:00:00.000Z");
  assert.equal(new Date(backfillHours("2026-09-01T00:00:00Z", H("2026-11-10T14:00:00Z")).to).toISOString(), "2026-11-10T13:00:00.000Z", "even at the very start of an hour");
});

test("the live capture runs at most once a minute, and always on a new hour", () => {
  const m = 60_000;
  assert.equal(captureDue(undefined, H("2026-11-10T10:00:10Z"), m), true, "first run");
  assert.equal(captureDue(H("2026-11-10T10:00:10Z"), H("2026-11-10T10:00:40Z"), m), false, "inside the minute");
  assert.equal(captureDue(H("2026-11-10T10:00:10Z"), H("2026-11-10T10:01:10Z"), m), true, "a minute later");
  assert.equal(captureDue(H("2026-11-10T10:59:50Z"), H("2026-11-10T11:00:02Z"), m), true, "a new hour, even inside the minute");
});

test("candle parsers take each source's live shape, keep the close, sort by hour and skip junk", () => {
  // Coinbase: [time s, low, high, open, close, volume], newest first
  assert.deepEqual(parseCoinbaseCandles([[1789264800, 2400, 2500, 2450, 2490.4, 10], [1789261200, 2300, 2460, 2400, 2450, 9], ["x"], [1789258000, 1, 1, 1, 0, 1]]), [
    { hour: 1789261200_000, usd: 2450 },
    { hour: 1789264800_000, usd: 2490.4 },
  ]);
  assert.deepEqual(parseCoinbaseCandles({ message: "rate limited" }), []);
  // Hyperliquid: { t: open ms, c: close string }
  assert.deepEqual(parseHyperliquidCandles([{ t: 1789264800000, c: "79.223" }, { t: 1789261200000, c: "0" }, null, { c: "1" }]), [{ hour: 1789264800000, usd: 79.223 }]);
  // GeckoTerminal: data.attributes.ohlcv_list [[time s, o, h, l, c, v]], newest first
  assert.deepEqual(parseGeckoOhlcv({ data: { attributes: { ohlcv_list: [[1789264800, 1, 1, 1, 3e-9, 1], [1789261200, 1, 1, 1, 2.5e-9, 1]] } } }), [
    { hour: 1789261200_000, usd: 2.5e-9 },
    { hour: 1789264800_000, usd: 3e-9 },
  ]);
  assert.deepEqual(parseGeckoOhlcv({ errors: [{ status: "404" }] }), []);
});

test("fillHours: an hour's own close, else the previous close within the gap limit, else nothing", () => {
  const t0 = H("2026-09-06T00:00:00Z");
  const pts = [{ hour: t0 - HOUR_MS, usd: 9 }, { hour: t0, usd: 10 }, { hour: t0 + 3 * HOUR_MS, usd: 13 }, { hour: t0 + 3 * HOUR_MS, usd: 14 }];
  const m = fillHours(pts, t0, t0 + 7 * HOUR_MS, 2);
  assert.equal(m.get(t0), 10);
  assert.equal(m.get(t0 + HOUR_MS), 10, "carried 1h");
  assert.equal(m.get(t0 + 2 * HOUR_MS), 10, "carried 2h");
  assert.equal(m.get(t0 + 3 * HOUR_MS), 14, "a later point for the same hour wins");
  assert.equal(m.get(t0 + 5 * HOUR_MS), 14);
  assert.equal(m.has(t0 + 6 * HOUR_MS), false, "past the gap limit: no price, never a stale guess");
  // a point before the range carries into it
  assert.equal(fillHours([{ hour: t0 - HOUR_MS, usd: 9 }], t0, t0, 2).get(t0), 9);
  const product = multiplySeries(new Map([[t0, 2e-9], [t0 + HOUR_MS, 3e-9]]), new Map([[t0, 2000]]));
  assert.deepEqual([...product.keys()], [t0], "an hour missing on either side has no product");
  assert.ok(Math.abs(product.get(t0)! - 4e-6) < 1e-18);
});

test("quoteSeriesRows: every quote the backfill prices comes from the app's own quote config, once", () => {
  const rows = quoteSeriesRows();
  const by = (chainId: number, quote: string) => rows.filter((r) => r.chainId === chainId && r.quote === quote.toLowerCase());
  const one = (chainId: number, quote: string) => {
    const r = by(chainId, quote);
    assert.equal(r.length, 1, `${chainId}:${quote}`);
    return r[0];
  };
  const NATIVE = "0x0000000000000000000000000000000000000000";
  assert.deepEqual([one(8453, NATIVE).series, one(8453, NATIVE).decimals], ["ETH-USD", 18]);
  assert.equal(one(8453, "0x4200000000000000000000000000000000000006").series, "ETH-USD", "WETH at ETH's price");
  assert.equal(one(4663, NATIVE).series, "ETH-USD");
  assert.deepEqual([one(5042, NATIVE).series, one(5042, NATIVE).decimals], ["USD", 18], "Arc's native asset is USDC, never ETH");
  assert.deepEqual([one(5042, "0x3600000000000000000000000000000000000000").series, one(5042, "0x3600000000000000000000000000000000000000").decimals], ["USD", 6]);
  assert.equal(one(99901, NATIVE).series, "HYPE-USD");
  assert.equal(one(99901, "0xbA876237B0F021A6c6D852d6c26E107997cC5E81").series, "HYPE-USD", "WHYPE at HYPE's price");
  assert.deepEqual([one(99901, "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65").series, one(99901, "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65").decimals], ["USD", 6]);
  assert.equal(one(4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168").decimals, 6, "USDG");
  assert.equal(one(8453, "0x5F980Dcfc4c0fa3911554cf5ab288ed0eb13DBa3").series, "GITLAWB-USD");
  assert.equal(one(4663, "0xd1b0d44E4f6ed940fcC7A9F59Bf30Daf62cCFe3D").series, "GITLAWB-USD", "the Robinhood OFT is the same GITLAWB");
  assert.equal(one(8453, "0x6aC18bcf4eDE02591d4917452700ea5eaAea13c1").series, "GITLAWB-USD", "one TWIG unwraps to one GITLAWB");
  assert.equal(new Set(rows.map((r) => `${r.chainId}:${r.quote}`)).size, rows.length, "no quote twice");
  for (const r of rows) assert.equal(r.quote, r.quote.toLowerCase());
  for (const r of rows.filter((x) => x.series === "USD")) assert.equal(r.fixedUsd, 1);
});

function sql(mode: "dry-run" | "apply") {
  const t0 = H("2026-09-06T00:00:00Z");
  const series = new Map<SeriesKey, Map<number, number>>([["ETH-USD", new Map([[t0, 2490.4]])], ["USD", new Map([[t0, 1]])]]);
  return buildBackfillSql({ mode, generatedAt: "2026-11-10T14:00:00Z", from: t0, to: t0, quotes: quoteSeriesRows(), series });
}

test("a dry run writes nothing: it reports and rolls back", () => {
  const s = sql("dry-run");
  assert.match(s, /MODE: DRY-RUN/);
  assert.match(s, /^\\set ON_ERROR_STOP on$/m, "psql stops at the first error");
  assert.match(s, /ROLLBACK; -- dry run: nothing was written\n$/);
  assert.doesNotMatch(s, /UPDATE bb_|LOCK TABLE|^COMMIT;/m, "no write and no commit (the temp tables' ON COMMIT DROP is not one)");
  assert.match(s, /ALL-TIME VOLUME/);
  assert.match(s, /usd_at_latest_price/);
  assert.match(s, /usd_at_trade_time/);
  // the ledger fill never replaces an hour the indexer captured live
  assert.match(s, /INSERT INTO bb_quote_usd_hourly \(chain_id, quote, hour, usd, decimals, source\)[\s\S]*?ON CONFLICT \(chain_id, quote, hour\) DO NOTHING;/);
  assert.match(s, /\('ETH-USD', '2026-09-06T00:00:00\.000Z', 2490\.40000000000, 'coinbase'\)/);
});

test("apply prices only rows with no USD yet, at their own hour, then recomputes totals under the rebuild script's locks", () => {
  const s = sql("apply");
  const updates = s.match(/UPDATE bb_launch_(swaps|fee_events) [\s\S]*?;/g) ?? [];
  assert.equal(updates.length, 3, "trades, collected fees, burned fees");
  for (const u of updates) {
    assert.match(u, /\.usd IS NULL/, "never re-prices a row that has a value");
    assert.match(u, /p\.hour = to_timestamp\(floor\(extract\(epoch FROM [sf]\.block_time\) \/ 3600\) \* 3600\)/, "its own hour");
  }
  assert.match(updates[2], /f\.kind = 'burned' AND f\.currency = l\.quote/, "a burn of the launched token is never priced as the quote");
  const lockAt = s.indexOf("LOCK TABLE bb_launch_swaps IN SHARE MODE");
  const recomputeAt = s.indexOf("UPDATE bb_launches l SET");
  assert.ok(lockAt > 0 && recomputeAt > lockAt, "the totals are recomputed only under the locks");
  assert.match(s, /LOCK TABLE bb_launches IN EXCLUSIVE MODE/);
  assert.equal(s.match(/^COMMIT;$/gm)?.length, 2);
  assert.match(s, /AFTER APPLY/);
});

test("prices must be positive and finite, and text is quoted safely", () => {
  const t0 = H("2026-09-06T00:00:00Z");
  for (const bad of [0, -1, Number.NaN, Infinity]) {
    assert.throws(() => buildBackfillSql({ mode: "dry-run", generatedAt: "x", from: t0, to: t0, quotes: [], series: new Map([["ETH-USD", new Map([[t0, bad]])]]) }), /bad price/);
  }
  const s = buildBackfillSql({ mode: "dry-run", generatedAt: "x", from: t0, to: t0, quotes: [{ chain: "base", chainId: 8453, quote: "o'brien", series: "USD", decimals: 6, fixedUsd: 1 }], series: new Map() });
  assert.match(s, /'o''brien'/);
});

test("the indexer prices each trade and fee at its own hour, in the same transaction as the totals", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/launchpad/indexer.ts"), "utf8");
  const swap = src.slice(src.indexOf("async function applySwap("), src.indexOf("type TransferArgs"));
  assert.match(swap, /return db\.begin\(async \(tx\) => \{[\s\S]*INSERT INTO bb_launch_swaps \([^)]*, usd\)[\s\S]*FROM bb_quote_usd_hourly p[\s\S]*p\.hour = \$\{hourIso\(time\)\}::timestamptz[\s\S]*RETURNING tx_hash, usd[\s\S]*volume_usd = volume_usd \+ \$\{usd\}::float8/);
  const fee = src.slice(src.indexOf("async function applyFeeIn("), src.indexOf("async function poolMaps("));
  assert.match(fee, /'collected'[\s\S]*FROM bb_quote_usd_hourly p[\s\S]*fees_collected_usd = fees_collected_usd \+ \$\{usd\}::float8/);
  assert.match(fee, /const priceIn = cur === info\.quote \? cur : "";[\s\S]*p\.quote = \$\{priceIn\}[\s\S]*fees_burned_usd = fees_burned_usd \+ \$\{usd\}::float8/);
  // this hour's live prices are captured before any trade in the range is priced, on both ingestion paths
  for (const fn of ["async function applyRange(", "export async function applyLaunchTx("]) {
    const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 4000);
    const capture = body.indexOf("await captureLiveUsd(db, chain, tokenQuote.values())");
    const swaps = body.indexOf("applySwap(db, chain,");
    assert.ok(capture > 0 && swaps > capture, `${fn}: capture before swaps`);
  }
});
