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
  // community pairs are never stored: the report counts them as unpriced, whatever an earlier version captured
  assert.equal(s.match(/CASE WHEN EXISTS \(SELECT 1 FROM bb_pairs pr WHERE pr\.chain_id = l\.chain_id AND pr\.address = l\.quote\) THEN NULL/g)?.length, 3, "per-quote report, total, fees");
});

test("apply is ONE transaction: under the rebuild script's locks it clears pair values, prices rows with no USD yet at their own hour, recomputes totals", () => {
  const s = sql("apply");
  assert.equal(s.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(s.match(/^COMMIT;$/gm)?.length, 1, "no reader ever sees rows priced but not yet in the stored sums");
  const lockAt = s.indexOf("LOCK TABLE bb_launch_swaps IN SHARE MODE");
  assert.match(s, /LOCK TABLE bb_launch_fee_events IN SHARE MODE;\nLOCK TABLE bb_launches IN EXCLUSIVE MODE;/);
  const writes = [...s.matchAll(/^(UPDATE bb_launch_swaps|UPDATE bb_launch_fee_events|UPDATE bb_launches|DELETE FROM bb_quote_usd_hourly)\b/gm)];
  assert.equal(writes.length, 7, "2 pair clears, 1 pair ledger delete, 3 pricing updates, 1 recompute");
  for (const w of writes) assert.ok(w.index! > lockAt, `${w[1]} runs under the locks`);
  const pricing = s.match(/^UPDATE bb_launch_(swaps|fee_events) \w SET usd = (?!NULL)[\s\S]*?;/gm) ?? [];
  assert.equal(pricing.length, 3, "trades, collected fees, burned fees");
  for (const u of pricing) {
    assert.match(u, /\.usd IS NULL/, "never re-prices a row that has a value");
    assert.match(u, /p\.hour = to_timestamp\(floor\(extract\(epoch FROM [sf]\.block_time\) \/ 3600\) \* 3600\)/, "its own hour");
  }
  assert.match(pricing[2], /f\.kind = 'burned' AND f\.currency = l\.quote/, "a burn of the launched token is never priced as the quote");
  // community pairs: their stored values and ledger rows go, before anything is priced
  const clears = s.match(/^UPDATE bb_launch_(swaps|fee_events) \w SET usd = NULL[\s\S]*?;/gm) ?? [];
  assert.equal(clears.length, 2);
  for (const c of clears) assert.match(c, /usd IS NOT NULL[\s\S]*EXISTS \(SELECT 1 FROM bb_pairs pr WHERE pr\.chain_id = l\.chain_id AND pr\.address = l\.quote\)/);
  assert.match(s, /DELETE FROM bb_quote_usd_hourly h WHERE EXISTS \(SELECT 1 FROM bb_pairs pr WHERE pr\.chain_id = h\.chain_id AND pr\.address = h\.quote\);/);
  assert.ok(s.indexOf("SET usd = NULL") < s.indexOf("SET usd = abs("), "pairs are cleared before pricing (so they are never re-priced)");
  assert.ok(s.indexOf("UPDATE bb_launches l SET") > s.lastIndexOf("SET usd = f.amount"), "totals are recomputed after every row is priced");
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
  // the poller captures this hour's live prices before any trade in its range is priced
  const range = src.slice(src.indexOf("async function applyRange("), src.indexOf("async function applyRange(") + 4000);
  const capture = range.indexOf("await captureLiveUsd(db, chain, tokenQuote.values())");
  assert.ok(capture > 0 && range.indexOf("applySwap(db, chain,") > capture, "applyRange: capture before swaps");
  // the receipt path (the user is waiting) never fetches prices: the poller's heal pass prices what it could not
  const receipt = src.slice(src.indexOf("export async function applyLaunchTx("));
  assert.doesNotMatch(receipt, /captureLiveUsd\(/);
  const run = src.slice(src.indexOf("async function run(chain: ChainKey)"), src.indexOf("export async function applyLaunchTx("));
  assert.match(run, /await healUnpricedUsd\(db, chain\);\n\s*return \{ status: "synced"/, "the heal pass runs after every sync, outside the chunk loop");
});

test("the live capture never stores a community pair (or an unlisted token); the heal pass skips pairs and changes each row once", async () => {
  const { capturable } = await import("./usdLedger.ts");
  for (const key of ["eth", "hype", "usdc", "usdg", "gitlawb", "twig", "stock"]) assert.equal(capturable(key), true, key);
  assert.equal(capturable("pair"), false, "an outside pool can be pushed for a minute, and a delisted pair must show no USD");
  assert.equal(capturable("other"), false);
  const led = readFileSync(path.join(process.cwd(), "src/lib/launchpad/usdLedger.ts"), "utf8");
  assert.match(led, /return capturable\(p\.key\) && p\.usd !== null/);
  const heal = led.slice(led.indexOf("export async function healUnpricedUsd("));
  assert.equal(heal.match(/AND NOT EXISTS \(SELECT 1 FROM bb_pairs pr WHERE pr\.chain_id = l\.chain_id AND pr\.address = l\.quote\)/g)?.length, 2, "trades and fees");
  // only rows whose own hour has a price are picked, each re-tested inside the UPDATE, and the totals move by what was priced
  assert.match(heal, /JOIN bb_quote_usd_hourly p ON p\.chain_id = s\.chain_id AND p\.quote = l\.quote AND p\.hour = \$\{db\.unsafe\(hourSql\("s\.block_time"\)\)\}/);
  assert.match(heal, /UPDATE bb_launch_swaps s SET usd = t\.v FROM todo t\s+WHERE s\.chain_id = t\.chain_id AND s\.tx_hash = t\.tx_hash AND s\.log_index = t\.log_index AND s\.usd IS NULL/);
  assert.match(heal, /UPDATE bb_launches l SET volume_usd = l\.volume_usd \+ x\.v\s+FROM \(SELECT chain_id, token, sum\(usd\) AS v FROM priced GROUP BY chain_id, token\) x/);
  assert.match(heal, /f\.kind = 'collected' OR \(f\.kind = 'burned' AND f\.currency = l\.quote\)/);
});
