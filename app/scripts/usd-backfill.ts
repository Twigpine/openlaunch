/**
 * Trade-time USD backfill (lib/launchpad/usd-history.ts states the rule). Fetches hourly prices from launch day to now and
 * writes ONE SQL file that fills bb_quote_usd_hourly, prices every trade and fee that has no USD value yet at its own
 * hour, and recomputes each launch's USD totals. Nothing here touches a database: the file is reviewed, then run on the
 * database machine exactly like scripts/rebuild-launch-totals.sql.
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/usd-backfill.ts --mode dry-run [--from 2026-09-01] [--out file.sql]
 *   npx tsx --tsconfig tsconfig.test.json scripts/usd-backfill.ts --mode apply   [--from 2026-09-01] [--out file.sql]
 *
 * Dry run: the SQL fills the ledger inside a transaction, prints the report (old method vs trade-time, per chain and
 * quote, plus totals) and ROLLS BACK. Apply: same report, then writes the values and recomputes the totals. Both are safe
 * to run again: only rows with no USD value are priced, and an hour the indexer captured live is never replaced.
 *
 * Sources (all public, no key): ETH-USD and HYPE-USD hourly closes from Coinbase Exchange (the live site prices ETH from
 * Coinbase too), HYPE hours Coinbase lacks from Hyperliquid; GITLAWB from its GITLAWB/WETH Uniswap v4 pool on Base via
 * GeckoTerminal (price in WETH, forward-filled between trades: a pool's price only moves when it trades) times ETH-USD,
 * the live method (gitlawb.ts). TWIG takes GITLAWB's price (1:1 wrapper). Stables are $1. Stocks, community pairs and
 * unlisted quotes have no history here: their past trades stay without a USD value and count as partial.
 */
import { writeFileSync } from "node:fs";
import { GITLAWB_POOL_ID } from "../src/lib/launchpad/gitlawb.ts";
import {
  GITLAWB_HISTORY, HOUR_MS, backfillHours, buildBackfillSql, fillHours, multiplySeries, parseCoinbaseCandles, parseGeckoOhlcv,
  parseHyperliquidCandles, quoteSeriesRows, type BackfillMode, type HourPoint, type SeriesKey,
} from "../src/lib/launchpad/usd-history.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "");
const mode = args.get("mode") as BackfillMode;
if (mode !== "dry-run" && mode !== "apply") throw new Error("--mode dry-run | apply");
// up to the last COMPLETED hour: the hour in progress belongs to the indexer's live capture (usd-history.backfillHours)
const { from, to } = backfillHours(args.get("from") || "2026-09-01T00:00:00Z", Date.now());
const out = args.get("out") || `usd-backfill.${mode}.sql`;
const UA = { "user-agent": "openlaunch-usd-backfill" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, init?: RequestInit, tries = 4): Promise<unknown> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { ...init, headers: { ...UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return res.json();
    if (i + 1 >= tries || (res.status !== 429 && res.status < 500)) throw new Error(`${url.split("?")[0]}: HTTP ${res.status}`);
    await sleep(2_000 * (i + 1));
  }
}

/** Coinbase Exchange: at most 300 candles per request. */
async function coinbaseHourly(product: string): Promise<HourPoint[]> {
  const pts: HourPoint[] = [];
  for (let start = from; start <= to; start += 300 * HOUR_MS) {
    const end = Math.min(to, start + 299 * HOUR_MS);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    pts.push(...parseCoinbaseCandles(await getJson(url)));
    await sleep(250);
  }
  return pts;
}

/** Hyperliquid candleSnapshot: up to 5000 candles per request. */
async function hyperliquidHourly(coin: string): Promise<HourPoint[]> {
  const pts: HourPoint[] = [];
  for (let start = from; start <= to; start += 4_000 * HOUR_MS) {
    const end = Math.min(to + HOUR_MS - 1, start + 4_000 * HOUR_MS - 1);
    const body = { type: "candleSnapshot", req: { coin, interval: "1h", startTime: start, endTime: end } };
    pts.push(...parseHyperliquidCandles(await getJson("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })));
    await sleep(250);
  }
  return pts;
}

/** GeckoTerminal pool OHLCV, newest first, paged backwards with before_timestamp (1000 per page). Price in the pool's other token. */
async function geckoHourlyInPair(network: string, pool: string, token: string): Promise<HourPoint[]> {
  const pts: HourPoint[] = [];
  let before = Math.floor((to + HOUR_MS) / 1000);
  for (let page = 0; page < 20; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/hour?aggregate=1&limit=1000&currency=token&token=${token}&before_timestamp=${before}`;
    const got = parseGeckoOhlcv(await getJson(url, { headers: { accept: "application/json" } }));
    if (got.length === 0) break;
    pts.push(...got);
    const oldest = got[0].hour;
    if (oldest <= from) break;
    before = Math.floor(oldest / 1000);
    await sleep(2_500); // GeckoTerminal's public API allows about 30 calls a minute
  }
  return pts;
}

function summary(name: string, m: ReadonlyMap<number, number>): string {
  const v = [...m.values()];
  const hours = (to - from) / HOUR_MS + 1;
  return `${name.padEnd(12)} ${String(m.size).padStart(5)}/${hours} hours  min ${Math.min(...v).toPrecision(4)}  max ${Math.max(...v).toPrecision(4)}`;
}

async function main(): Promise<void> {
  const quotes = quoteSeriesRows();
  for (const q of quotes) if (q.series === "USD" && q.fixedUsd !== 1) throw new Error(`fixed quote ${q.chain}:${q.quote} is not $1 (${q.fixedUsd}); give it its own series`);

  console.error(`hours ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}`);
  const eth = fillHours(await coinbaseHourly("ETH-USD"), from, to, 6);
  const hypeCb = await coinbaseHourly("HYPE-USD");
  const hypeHl = await hyperliquidHourly("HYPE");
  // Coinbase first (the live HYPE price's primary source); Hyperliquid only for the hours Coinbase has no candle for
  const cbHours = new Set(hypeCb.map((p) => p.hour));
  const hype = fillHours([...hypeHl.filter((p) => !cbHours.has(p.hour)), ...hypeCb], from, to, 6);
  const gitlawbInWeth = fillHours(await geckoHourlyInPair(GITLAWB_HISTORY.network, GITLAWB_POOL_ID, GITLAWB_HISTORY.token), from, to, 24 * 365);
  const gitlawb = multiplySeries(gitlawbInWeth, eth);
  const usd = new Map<number, number>();
  for (let h = from; h <= to; h += HOUR_MS) usd.set(h, 1);

  // sanity bounds: a unit mix-up (a price in wei, a series in the wrong currency) fails here, before anything is written
  const bounds: Record<SeriesKey, [number, number]> = { USD: [1, 1], "ETH-USD": [100, 100_000], "HYPE-USD": [1, 10_000], "GITLAWB-USD": [1e-12, 1] };
  const series = new Map<SeriesKey, Map<number, number>>([["USD", usd], ["ETH-USD", eth], ["HYPE-USD", hype], ["GITLAWB-USD", gitlawb]]);
  for (const [k, m] of series) {
    console.error(summary(k, m));
    for (const v of m.values()) if (v < bounds[k][0] || v > bounds[k][1]) throw new Error(`${k}: ${v} is outside ${bounds[k].join("..")}`);
  }

  const sql = buildBackfillSql({ mode, generatedAt: new Date().toISOString(), from, to, quotes, series });
  writeFileSync(out, sql);
  console.error(`wrote ${out} (${(sql.length / 1024).toFixed(0)} KiB, ${quotes.length} quotes). Run it on the database machine as LAUNCH.md describes.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
