/**
 * Trade-time USD, pure (node --test loads it directly): hour buckets, historical candle parsers, gap filling, which price
 * series prices which quote, and the backfill SQL that scripts/usd-backfill.ts writes.
 *
 * The rule: a trade's (or fee's) USD value is its quote amount times the quote's USD price in the trade's own UTC hour,
 * fixed once written (bb_launch_swaps.usd, bb_launch_fee_events.usd). bb_quote_usd_hourly holds one price per quote per
 * hour: the live price the indexer saw during that hour (source 'live', updated until the hour ends, so a trade indexed
 * seconds after it happened is priced at that spot), or a historical close filled in by the backfill.
 */
import type { ChainKey } from "../chainKeys.ts";
import { CHAIN_IDS, CHAIN_KEYS } from "../chainKeys.ts";
import { fixedUsdQuotes, quoteInfo, quotesWithKey } from "./config.ts";
import { GITLAWB_ADDRESS } from "./gitlawb.ts";

export const HOUR_MS = 3_600_000;

/** Start of the UTC hour containing `t` (ms, ISO string or Date), as ms. */
export function hourStartMs(t: number | string | Date): number {
  const ms = typeof t === "number" ? t : new Date(t).getTime();
  if (!Number.isFinite(ms)) throw new Error(`bad time: ${String(t)}`);
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}
/** Start of the UTC hour containing `t`, as an ISO string (the bb_quote_usd_hourly.hour key). */
export function hourIso(t: number | string | Date): string {
  return new Date(hourStartMs(t)).toISOString();
}
/**
 * The same bucket in SQL, for a timestamptz column. Time-zone independent on purpose: date_trunc('hour', timestamptz)
 * truncates in the session's zone, which would key a half-hour-offset session to the wrong row.
 */
export function hourSql(col: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(col)) throw new Error(`bad column: ${col}`);
  return `to_timestamp(floor(extract(epoch FROM ${col}) / 3600) * 3600)`;
}

/**
 * The hours a backfill covers: from `from` to the last COMPLETED hour before `now`. The hour in progress belongs to the
 * indexer's live capture: a partial candle written for it would block the capture (it never replaces a non-live row),
 * and every trade for the rest of that hour would be priced at that stale close.
 */
export function backfillHours(from: number | string, now: number): { from: number; to: number } {
  return { from: hourStartMs(from), to: hourStartMs(now) - HOUR_MS };
}

/** The live capture's rhythm (usdLedger.ts): at most once per `everyMs`, and always on the first run of a new UTC hour. */
export function captureDue(last: number | undefined, now: number, everyMs: number): boolean {
  return last === undefined || now - last >= everyMs || hourStartMs(now) !== hourStartMs(last);
}

export type HourPoint = { hour: number; usd: number };

function positive(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Coinbase Exchange candles: [[time s, low, high, open, close, volume], …] (newest first). The hour's close. */
export function parseCoinbaseCandles(body: unknown): HourPoint[] {
  if (!Array.isArray(body)) return [];
  const out: HourPoint[] = [];
  for (const c of body) {
    if (!Array.isArray(c) || c.length < 5) continue;
    const t = Number(c[0]);
    const close = positive(c[4]);
    if (Number.isFinite(t) && close !== null) out.push({ hour: hourStartMs(t * 1000), usd: close });
  }
  return out.sort((a, b) => a.hour - b.hour);
}

/** Hyperliquid candleSnapshot: [{ t: open ms, c: close as a string, … }, …]. The hour's close. */
export function parseHyperliquidCandles(body: unknown): HourPoint[] {
  if (!Array.isArray(body)) return [];
  const out: HourPoint[] = [];
  for (const c of body) {
    if (typeof c !== "object" || c === null) continue;
    const t = Number((c as { t?: unknown }).t);
    const close = positive((c as { c?: unknown }).c);
    if (Number.isFinite(t) && close !== null) out.push({ hour: hourStartMs(t), usd: close });
  }
  return out.sort((a, b) => a.hour - b.hour);
}

/** GeckoTerminal pool OHLCV: { data: { attributes: { ohlcv_list: [[time s, o, h, l, c, v], …] } } }. The hour's close. */
export function parseGeckoOhlcv(body: unknown): HourPoint[] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: HourPoint[] = [];
  for (const c of list) {
    if (!Array.isArray(c) || c.length < 5) continue;
    const t = Number(c[0]);
    const close = positive(c[4]);
    if (Number.isFinite(t) && close !== null) out.push({ hour: hourStartMs(t * 1000), usd: close });
  }
  return out.sort((a, b) => a.hour - b.hour);
}

/**
 * One value per hour from `from` to `to` (inclusive, hour starts): each hour takes its own point, else the last earlier
 * point at most `maxGapHours` back (a market with no trade in an hour still has the previous close as its price), else
 * no value. Later points for the same hour win.
 */
export function fillHours(points: readonly HourPoint[], from: number, to: number, maxGapHours: number): Map<number, number> {
  const byHour = new Map<number, number>();
  for (const p of [...points].sort((a, b) => a.hour - b.hour)) byHour.set(hourStartMs(p.hour), p.usd);
  const out = new Map<number, number>();
  let last: { hour: number; usd: number } | null = null;
  // a point before the range still carries into it
  for (const [h, v] of [...byHour].sort((a, b) => a[0] - b[0])) if (h < hourStartMs(from)) last = { hour: h, usd: v };
  for (let h = hourStartMs(from); h <= hourStartMs(to); h += HOUR_MS) {
    const own = byHour.get(h);
    if (own !== undefined) last = { hour: h, usd: own };
    if (last && (h - last.hour) / HOUR_MS <= maxGapHours) out.set(h, last.usd);
  }
  return out;
}

/** Hour-by-hour product of two series (GITLAWB per WETH × ETH per USD); an hour missing from either has no value. */
export function multiplySeries(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [h, v] of a) {
    const w = b.get(h);
    if (w !== undefined) out.set(h, v * w);
  }
  return out;
}

/** The historical series the backfill knows. A quote whose key maps to none (stocks, community pairs, unlisted) has no history here. */
export type SeriesKey = "USD" | "ETH-USD" | "HYPE-USD" | "GITLAWB-USD";
export const SERIES_SOURCE: Record<SeriesKey, string> = {
  USD: "fixed",
  "ETH-USD": "coinbase",
  "HYPE-USD": "coinbase",
  "GITLAWB-USD": "geckoterminal",
};
/** The GITLAWB/WETH Uniswap v4 pool on Base and the GITLAWB token, for GeckoTerminal's OHLCV (price in WETH, × ETH-USD). */
export const GITLAWB_HISTORY = { network: "base", token: GITLAWB_ADDRESS };

export type QuoteSeriesRow = { chain: ChainKey; chainId: number; quote: string; series: SeriesKey; decimals: number; fixedUsd: number | null };

/**
 * Every quote the backfill can price, from the app's own quote config (so it can never price a quote the site does not):
 * the fixed-price quotes (stables, Arc's native USDC) at their fixed price; ETH and WETH from ETH-USD; HYPE and WHYPE from
 * HYPE-USD; GITLAWB (Base and the Robinhood OFT) and TWIG (one TWIG unwraps to one GITLAWB) from GITLAWB-USD.
 */
export function quoteSeriesRows(): QuoteSeriesRow[] {
  const rows: QuoteSeriesRow[] = [];
  const seen = new Set<string>();
  const add = (chain: ChainKey, address: string, series: SeriesKey, fixedUsd: number | null) => {
    const quote = address.toLowerCase();
    const k = `${chain}:${quote}`;
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({ chain, chainId: CHAIN_IDS[chain], quote, series, decimals: quoteInfo(chain, quote).decimals, fixedUsd });
  };
  for (const f of fixedUsdQuotes()) add(f.chain, f.address, "USD", f.usd);
  for (const q of quotesWithKey("eth")) add(q.chain, q.address, "ETH-USD", null);
  for (const q of quotesWithKey("hype")) add(q.chain, q.address, "HYPE-USD", null);
  for (const key of ["gitlawb", "twig"] as const) for (const q of quotesWithKey(key)) add(q.chain, q.address, "GITLAWB-USD", null);
  // stable output order: chain registry order, then series, then address
  const order = new Map(CHAIN_KEYS.map((k, i) => [k, i]));
  return rows.sort((a, b) => (order.get(a.chain)! - order.get(b.chain)!) || a.series.localeCompare(b.series) || a.quote.localeCompare(b.quote));
}

export type BackfillMode = "dry-run" | "apply";

/** The SQL file scripts/usd-backfill.ts writes. Pure so the tests can read exactly what will run against production. */
export function buildBackfillSql(opts: {
  mode: BackfillMode;
  generatedAt: string;
  from: number;
  to: number;
  quotes: readonly QuoteSeriesRow[];
  series: ReadonlyMap<SeriesKey, ReadonlyMap<number, number>>;
}): string {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const num = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) throw new Error(`bad price: ${n}`);
    return n.toPrecision(15);
  };
  const out: string[] = [];
  out.push(`-- Trade-time USD backfill, generated by scripts/usd-backfill.ts at ${opts.generatedAt}. MODE: ${opts.mode.toUpperCase()}.`);
  out.push(`-- Hours ${new Date(hourStartMs(opts.from)).toISOString()} .. ${new Date(hourStartMs(opts.to)).toISOString()} (UTC). Idempotent: prices only rows that have no USD value yet,`);
  out.push(`-- and never overwrites an hour the indexer captured live. ${opts.mode === "dry-run" ? "Dry run: everything is ROLLED BACK at the end; only the report is real." : "Apply: ONE transaction that clears community-pair values, prices what has no value yet and recomputes every launch's USD totals."}`);
  out.push(`\\set ON_ERROR_STOP on`);
  out.push(`BEGIN;`);
  out.push(`CREATE TEMP TABLE usd_quote_map (chain_id integer, quote text, series text, decimals integer) ON COMMIT DROP;`);
  if (opts.quotes.length > 0) {
    out.push(`INSERT INTO usd_quote_map (chain_id, quote, series, decimals) VALUES`);
    out.push(opts.quotes.map((q) => `  (${q.chainId}, ${lit(q.quote)}, ${lit(q.series)}, ${q.decimals})`).join(",\n") + ";");
  }
  out.push(`CREATE TEMP TABLE usd_series (series text, hour timestamptz, usd double precision, source text) ON COMMIT DROP;`);
  for (const [key, hours] of opts.series) {
    const rows = [...hours].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < rows.length; i += 1000) {
      const part = rows.slice(i, i + 1000);
      out.push(`INSERT INTO usd_series (series, hour, usd, source) VALUES`);
      out.push(part.map(([h, v]) => `  (${lit(key)}, ${lit(new Date(h).toISOString())}, ${num(v)}, ${lit(SERIES_SOURCE[key])})`).join(",\n") + ";");
    }
  }
  out.push(`-- the hourly ledger: fill the hours the indexer did not capture live (a live capture is the spot at index time and wins)`);
  out.push(`INSERT INTO bb_quote_usd_hourly (chain_id, quote, hour, usd, decimals, source)`);
  out.push(`  SELECT m.chain_id, m.quote, s.hour, s.usd, m.decimals, s.source FROM usd_series s JOIN usd_quote_map m ON m.series = s.series`);
  out.push(`  ON CONFLICT (chain_id, quote, hour) DO NOTHING;`);
  const hour = (col: string) => hourSql(col);
  // community pairs are never stored (usdLedger.capturable): the report counts them as unpriced, and apply clears any value
  // an earlier version captured for them, so they count at the pair's price now (which follows its listing status)
  const isPair = (alias: string) => `EXISTS (SELECT 1 FROM bb_pairs pr WHERE pr.chain_id = ${alias}.chain_id AND pr.address = ${alias}.quote)`;
  out.push(`-- REPORT: every trade at today's price (the old method) vs at its own hour's price (the new one), per chain and quote`);
  out.push(`WITH latest AS (
  SELECT DISTINCT ON (chain_id, quote) chain_id, quote, usd, decimals FROM bb_quote_usd_hourly ORDER BY chain_id, quote, hour DESC
), sw AS (
  SELECT s.chain_id, l.quote, abs(COALESCE(s.trader_amount0, s.amount0)) AS amt,
         CASE WHEN ${isPair("l")} THEN NULL ELSE COALESCE(s.usd, abs(COALESCE(s.trader_amount0, s.amount0)) / power(10::numeric, p.decimals) * p.usd) END AS usd_trade_time
    FROM bb_launch_swaps s
    JOIN bb_launches l ON l.chain_id = s.chain_id AND l.token = s.token
    LEFT JOIN bb_quote_usd_hourly p ON p.chain_id = s.chain_id AND p.quote = l.quote AND p.hour = ${hour("s.block_time")}
)
SELECT sw.chain_id, sw.quote, count(*) AS trades,
       count(*) FILTER (WHERE sw.usd_trade_time IS NULL) AS trades_without_price,
       round(sum(sw.amt / power(10::numeric, lt.decimals))::numeric, 4) AS volume_in_quote,
       round(sum(sw.amt / power(10::numeric, lt.decimals) * lt.usd)::numeric) AS usd_at_latest_price,
       round(sum(sw.usd_trade_time)::numeric) AS usd_at_trade_time
  FROM sw LEFT JOIN latest lt ON lt.chain_id = sw.chain_id AND lt.quote = sw.quote
 GROUP BY 1, 2
 ORDER BY usd_at_trade_time DESC NULLS LAST;`);
  out.push(`WITH latest AS (
  SELECT DISTINCT ON (chain_id, quote) chain_id, quote, usd, decimals FROM bb_quote_usd_hourly ORDER BY chain_id, quote, hour DESC
), sw AS (
  SELECT abs(COALESCE(s.trader_amount0, s.amount0)) / power(10::numeric, lt.decimals) * lt.usd AS usd_latest,
         CASE WHEN ${isPair("l")} THEN NULL ELSE COALESCE(s.usd, abs(COALESCE(s.trader_amount0, s.amount0)) / power(10::numeric, p.decimals) * p.usd) END AS usd_trade_time
    FROM bb_launch_swaps s
    JOIN bb_launches l ON l.chain_id = s.chain_id AND l.token = s.token
    LEFT JOIN latest lt ON lt.chain_id = s.chain_id AND lt.quote = l.quote
    LEFT JOIN bb_quote_usd_hourly p ON p.chain_id = s.chain_id AND p.quote = l.quote AND p.hour = ${hour("s.block_time")}
)
SELECT 'ALL-TIME VOLUME' AS total, round(sum(usd_latest)::numeric) AS usd_at_latest_price, round(sum(usd_trade_time)::numeric) AS usd_at_trade_time,
       count(*) FILTER (WHERE usd_trade_time IS NULL) AS trades_without_price, count(*) AS trades
  FROM sw;`);
  out.push(`WITH fe AS (
  SELECT f.kind,
         CASE WHEN ${isPair("l")} THEN NULL
              ELSE COALESCE(f.usd, CASE WHEN f.kind = 'collected' THEN f.quote_amount ELSE f.amount END / power(10::numeric, p.decimals) * p.usd) END AS usd_trade_time
    FROM bb_launch_fee_events f
    JOIN bb_launches l ON l.chain_id = f.chain_id AND l.token = f.token
    LEFT JOIN bb_quote_usd_hourly p ON p.chain_id = f.chain_id AND p.quote = l.quote AND p.hour = ${hour("f.block_time")}
   WHERE f.kind = 'collected' OR (f.kind = 'burned' AND f.currency = l.quote)
)
SELECT 'FEES (quote side)' AS total, kind, round(sum(usd_trade_time)::numeric) AS usd_at_trade_time,
       count(*) FILTER (WHERE usd_trade_time IS NULL) AS events_without_price, count(*) AS events
  FROM fe GROUP BY kind ORDER BY kind;`);
  if (opts.mode === "dry-run") {
    out.push(`ROLLBACK; -- dry run: nothing was written`);
    return out.join("\n") + "\n";
  }
  // ONE transaction from here: clearing pair values, pricing rows and recomputing the totals commit together, so a reader
  // never sees rows that are neither unpriced nor in the stored sums (and a failure leaves everything as it was).
  out.push(`-- from here, under the same locks as scripts/rebuild-launch-totals.sql: the indexer's ingestion transactions (INSERT event +`);
  out.push(`-- UPDATE totals) and its heal pass wait until this commits, then apply on top. Nothing is lost or counted twice.`);
  out.push(`LOCK TABLE bb_launch_swaps IN SHARE MODE;`);
  out.push(`LOCK TABLE bb_launch_fee_events IN SHARE MODE;`);
  out.push(`LOCK TABLE bb_launches IN EXCLUSIVE MODE;`);
  out.push(`-- community pairs: no stored value and no ledger rows (an earlier version captured them)`);
  out.push(`UPDATE bb_launch_swaps s SET usd = NULL FROM bb_launches l
 WHERE s.usd IS NOT NULL AND l.chain_id = s.chain_id AND l.token = s.token AND ${isPair("l")};`);
  out.push(`UPDATE bb_launch_fee_events f SET usd = NULL FROM bb_launches l
 WHERE f.usd IS NOT NULL AND l.chain_id = f.chain_id AND l.token = f.token AND ${isPair("l")};`);
  out.push(`DELETE FROM bb_quote_usd_hourly h WHERE ${isPair("h")};`);
  out.push(`-- price every trade and fee that has no USD value yet, at its own hour`);
  out.push(`UPDATE bb_launch_swaps s SET usd = abs(COALESCE(s.trader_amount0, s.amount0)) / power(10::numeric, p.decimals) * p.usd
  FROM bb_launches l, bb_quote_usd_hourly p
 WHERE s.usd IS NULL AND l.chain_id = s.chain_id AND l.token = s.token
   AND p.chain_id = s.chain_id AND p.quote = l.quote AND p.hour = ${hour("s.block_time")};`);
  out.push(`UPDATE bb_launch_fee_events f SET usd = f.quote_amount / power(10::numeric, p.decimals) * p.usd
  FROM bb_launches l, bb_quote_usd_hourly p
 WHERE f.usd IS NULL AND f.kind = 'collected' AND l.chain_id = f.chain_id AND l.token = f.token
   AND p.chain_id = f.chain_id AND p.quote = l.quote AND p.hour = ${hour("f.block_time")};`);
  out.push(`UPDATE bb_launch_fee_events f SET usd = f.amount / power(10::numeric, p.decimals) * p.usd
  FROM bb_launches l, bb_quote_usd_hourly p
 WHERE f.usd IS NULL AND f.kind = 'burned' AND f.currency = l.quote AND l.chain_id = f.chain_id AND l.token = f.token
   AND p.chain_id = f.chain_id AND p.quote = l.quote AND p.hour = ${hour("f.block_time")};`);
  out.push(`-- every launch's USD totals, recomputed from the priced rows`);
  out.push(`UPDATE bb_launches l SET
  volume_usd = COALESCE((SELECT sum(s.usd) FROM bb_launch_swaps s WHERE s.chain_id = l.chain_id AND s.token = l.token), 0),
  fees_collected_usd = COALESCE((SELECT sum(f.usd) FROM bb_launch_fee_events f WHERE f.chain_id = l.chain_id AND f.token = l.token AND f.kind = 'collected'), 0),
  fees_burned_usd = COALESCE((SELECT sum(f.usd) FROM bb_launch_fee_events f WHERE f.chain_id = l.chain_id AND f.token = l.token AND f.kind = 'burned' AND f.currency = l.quote), 0);`);
  out.push(`SELECT 'AFTER APPLY' AS total, round(sum(volume_usd)::numeric) AS volume_usd, round(sum(fees_collected_usd)::numeric) AS fees_collected_usd,
       round(sum(fees_burned_usd)::numeric) AS fees_burned_usd,
       (SELECT count(*) FROM bb_launch_swaps WHERE usd IS NULL) AS trades_still_without_price
  FROM bb_launches;`);
  out.push(`COMMIT;`);
  return out.join("\n") + "\n";
}
