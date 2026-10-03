import "server-only";
import { cache } from "react";
import { maybeDb } from "@/lib/db";
import { CHAIN_KEYS, DEFAULT_CHAIN, chainIdOf, chainKeyOf, type ChainKey } from "@/lib/chainPublic";
import { quoteInfo as staticQuoteInfo, quoteUsdOf, type Quote, NATIVE_QUOTES, fixedUsdQuotes, quotesWithKey } from "./config";
import { ensureRegistry, stockByAddress, stockList, stockUsdInUse } from "./stocksServer";
import { unlistedQuote, type QuoteTokenMeta } from "./unlisted-quote";
import { memo } from "./memo";
import { gitlawbUsd } from "./gitlawbServer";
import { GITLAWB_ADDRESS, reconcileGitlawbUsd } from "./gitlawb";
import { MUSEWORLD_ADDRESS, MUSEWORLD_TWAP_WINDOW_S, timeWeightedPrice } from "./museworld";
import { canonicalImageUrl } from "./images";
import { GRACE_HOURS, LIVE_WINDOW_HOURS, rankTrending, type LiveTier } from "./ranking";
import { SNIPER_BLOCKS } from "./holders";
import { imagePublicBase } from "./imageStore";
import { collectNonDust } from "./feed-dust";
import { fdvQuote, quotePerToken, tickToTokensPerQuote, units } from "./math";
import type { RawCandle } from "./candles";
import { normalizeQuery, isAddressQuery, escapeLike, compareSearchHit, type LaunchFilter } from "./search";

/**
 * Read model for the UI. Every money field comes in two flavours: raw quote
 * units (wei / micro-USDG, as strings) and a USD float derived with the ETH
 * price passed in (`ethUsd`) or the stable's fixed price. Chains are mixed in
 * one list; each row carries its chain.
 */
export type LaunchRow = {
  chain: ChainKey;
  chain_id: number;
  token: string;
  token_id: number;
  launcher: string;
  quote: string;
  quote_key: Quote["key"]; // eth | usdg | usdc | gitlawb | stock (a registry stock) | other (an unlisted ERC-20, unlisted-quote.ts)
  quote_symbol: string;
  quote_decimals: number;
  quote_decimals_known: boolean; // false only for an unlisted quote not read yet: quote_decimals is a placeholder, do not trade
  pool_id: string;
  start_tick: number;
  lp_fee: number;
  supply: string;
  metadata_uri: string;
  name: string;
  symbol: string;
  block_number: number;
  block_time: string;
  tx_hash: string;
  tick: number;
  sqrt_price_x96: string | null;
  volume_quote: string;
  buys: number;
  sells: number;
  last_trade_at: string | null;
  fees_quote_collected: string;
  fees_token_collected: string;
  fees_quote_burned: string;
  fees_token_burned: string;
  recipients: { payout: string; bps: number }[];
  trades_1h: number;
  traders_1h: number;
  traders_1h_ex: number; // distinct outside wallets in the hour (not the launcher, not sniper-window swaps)
  volume_1h: string;
  trades_24h: number;
  traders_24h_ex: number; // same over the day: the "live" gate (lib/launchpad/ranking.ts)
  volume_24h: string;
  last_outside_trade_at: string | null; // last swap by an outside wallet in the day window (last_trade_at counts everyone)
  live_tier: LiveTier | null; // sort "live" only: the tier the database ranked this row in
  launcher_collapsed: number; // sort "live" only: further rows of this launcher folded into this one
  description: string | null;
  image_url: string | null;
  holders: number;
  website: string | null;
  x_handle: string | null;
  // derived
  price_quote: number; // whole quote units per token
  fdv_quote: number; // whole quote units
  change_from_launch: number;
  quote_usd: number | null; // USD per 1 quote unit (null = unknown)
  price_usd: number | null;
  fdv_usd: number | null;
  volume_usd: number | null;
  volume_1h_usd: number | null;
  volume_24h_usd: number | null;
};

type Raw = Omit<LaunchRow, "chain" | "quote_key" | "quote_symbol" | "quote_decimals" | "quote_decimals_known" | "token_id" | "block_number" | "tick" | "trades_1h" | "traders_1h" | "traders_1h_ex" | "trades_24h" | "traders_24h_ex" | "last_outside_trade_at" | "live_tier" | "launcher_collapsed" | "price_quote" | "fdv_quote" | "change_from_launch" | "quote_usd" | "price_usd" | "fdv_usd" | "volume_usd" | "volume_1h_usd" | "volume_24h_usd"> & {
  token_id: bigint;
  block_number: bigint;
  tick: number | null;
  trades_1h: bigint | number;
  traders_1h?: bigint | number | null;
  traders_1h_ex?: bigint | number | null;
  trades_24h: bigint | number;
  traders_24h_ex?: bigint | number | null;
  last_outside_trade_at?: string | Date | null;
  live_tier?: number | null;
  launcher_collapsed?: bigint | number | null;
};

const TIERS: LiveTier[] = ["live", "new", "quiet"]; // index = the live_tier CASE in the live sort

/** Stock USD prices for this request (filled by `withStocks`). */
let stockUsdNow = new Map<string, number | null>();
/** Unlisted quotes' on-chain symbol / decimals (bb_quote_tokens, keyed `${chain_id}:${address}`), and each chain's stock tickers they may not borrow. */
let quoteTokensNow = new Map<string, QuoteTokenMeta>();
let stockSymbolsNow = new Map<ChainKey, string[]>();
/** MUSEWORLD USD for this request (filled by `withStocks` from its own GITLAWB pool; null = unknown → no USD, 0 weight in USD sorts). */
let museworldUsdNow: number | null = null;
/** GITLAWB USD for this request (filled by `withStocks`; null = unknown → no USD, 0 weight in USD sorts). */
let gitlawbUsdNow: number | null = null;

/** Server-side quote resolution: static ETH/USDG/GITLAWB (GITLAWB gets the live price), else a registry stock, else an unlisted quote. */
function quoteInfo(chain: ChainKey, address: string): Quote {
  const q = staticQuoteInfo(chain, address);
  if (q.key === "gitlawb") return { ...q, usd: gitlawbUsdNow };
  if (q.key === "museworld") return { ...q, usd: museworldUsdNow };
  if (q.key !== "other") return q;
  const st = stockByAddress(chain, address);
  if (st) return { key: "stock", address: st.address as Quote["address"], symbol: st.symbol, decimals: st.decimals, usd: stockUsdNow.get(st.address) ?? null, name: st.name, logo: st.logo };
  return unlistedQuote(address, quoteTokensNow.get(`${chainIdOf(chain)}:${address.toLowerCase()}`) ?? null, stockSymbolsNow.get(chain) ?? []);
}

/**
 * USD per MUSEWORLD (museworld.ts): GITLAWB per MUSEWORLD in its own openlaunch pool, times GITLAWB's USD price. The pool
 * leg comes from our index: the spot (bb_launches) unless it strays >25% from the 30-minute time-weighted price of the
 * swaps, then that average, the same rule as GITLAWB's own price. null when GITLAWB has no price, the launch row is not
 * indexed, or it is not the GITLAWB pool it should be.
 */
async function readMuseworldUsd(gitlawbUsd: number | null): Promise<number | null> {
  const db = maybeDb();
  if (!db || gitlawbUsd === null || !(gitlawbUsd > 0)) return null;
  const cid = chainIdOf("base");
  const token = MUSEWORLD_ADDRESS.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const from = now - MUSEWORLD_TWAP_WINDOW_S;
  const [launch, before, recent] = await Promise.all([
    db<{ quote: string; sqrt_price_x96: string | null }[]>`SELECT quote, sqrt_price_x96 FROM bb_launches WHERE chain_id = ${cid} AND token = ${token}`,
    db<{ sqrt_price_x96: string }[]>`
      SELECT sqrt_price_x96 FROM bb_launch_swaps WHERE chain_id = ${cid} AND token = ${token} AND block_time < to_timestamp(${from})
       ORDER BY block_number DESC, log_index DESC LIMIT 1`,
    db<{ t: number; sqrt_price_x96: string }[]>`
      SELECT extract(epoch FROM block_time)::int AS t, sqrt_price_x96 FROM bb_launch_swaps
       WHERE chain_id = ${cid} AND token = ${token} AND block_time >= to_timestamp(${from})
       ORDER BY block_number, log_index LIMIT 5000`,
  ]);
  const row = launch[0];
  if (!row?.sqrt_price_x96 || row.quote !== GITLAWB_ADDRESS.toLowerCase()) return null;
  const spot = quotePerToken(BigInt(row.sqrt_price_x96), 18); // GITLAWB per MUSEWORLD
  const baseline = before[0] ? quotePerToken(BigInt(before[0].sqrt_price_x96), 18) : null;
  const twap = timeWeightedPrice(recent.map((r) => ({ t: Number(r.t), price: quotePerToken(BigInt(r.sqrt_price_x96), 18) })), baseline, from, now);
  const { usd: perMuseworld, source, deviation } = reconcileGitlawbUsd(spot > 0 ? spot : null, twap);
  if (source === "twap" && deviation !== null) console.warn(`[museworld] pool spot is ${Math.round(deviation * 100)}% off the 30m average; publishing the average`);
  return perMuseworld === null ? null : perMuseworld * gitlawbUsd;
}

/** bb_quote_tokens is tiny (one row per unlisted quote) and changes only when the indexer reads a new one. */
async function loadQuoteTokens(): Promise<Map<string, QuoteTokenMeta>> {
  const db = maybeDb();
  if (!db) return new Map();
  const rows = await db<{ chain_id: number; address: string; symbol: string | null; name: string | null; decimals: number | null }[]>`SELECT chain_id, address, symbol, name, decimals FROM bb_quote_tokens`;
  return new Map(rows.map((r) => [`${r.chain_id}:${r.address}`, { symbol: r.symbol, name: r.name, decimals: r.decimals }]));
}

/** Warm the stock registry + prices for the stocks in use (and the GITLAWB price), so `shape()` can stay synchronous. */
async function withStocks(): Promise<void> {
  gitlawbUsdNow = await gitlawbUsd(); // never throws; served from cache once warm (stale-while-revalidate)
  try {
    await ensureRegistry(); // robinhood registry (fail-soft); the Base list is static
    stockUsdNow = await stockUsdInUse();
  } catch {
    /* fail soft: stocks show without USD */
  }
  try {
    museworldUsdNow = await memo("museworld-usd", 15_000, () => readMuseworldUsd(gitlawbUsdNow));
  } catch (err) {
    museworldUsdNow = null; // fail soft: MUSEWORLD pools show without USD
    console.warn("[museworld] price read failed:", err instanceof Error ? err.message : err);
  }
  stockSymbolsNow = new Map(CHAIN_KEYS.map((k) => [k, stockList(k).map((s) => s.symbol)]));
  try {
    quoteTokensNow = await memo("quote-tokens", 30_000, loadQuoteTokens);
  } catch {
    /* fail soft (table not migrated yet, db blip): unlisted quotes show by address and do not trade */
  }
}

function quoteUsd(q: Quote, ethUsd: number | null): number | null {
  return quoteUsdOf(q, ethUsd);
}

function shape(raw: Raw & { last_swap_block?: bigint; last_swap_log?: number; log_index?: number; holders_synced_block?: bigint | null }, ethUsd: number | null): LaunchRow {
  // drop indexer-only bigint columns so the row is JSON-safe
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { last_swap_block, last_swap_log, log_index, holders_synced_block, ...r } = raw;
  const chain = chainKeyOf(r.chain_id) ?? DEFAULT_CHAIN;
  const q = quoteInfo(chain, r.quote);
  const supply = BigInt(r.supply);
  const tick = r.tick ?? r.start_tick;
  const price = r.sqrt_price_x96 ? quotePerToken(BigInt(r.sqrt_price_x96), q.decimals) : 1 / tickToTokensPerQuote(tick, q.decimals);
  const fdv = r.sqrt_price_x96 ? fdvQuote(BigInt(r.sqrt_price_x96), supply, q.decimals) : price * (Number(supply) / 1e18);
  const launchFdv = (1 / tickToTokensPerQuote(r.start_tick, q.decimals)) * (Number(supply) / 1e18);
  const qu = quoteUsd(q, ethUsd);
  const usd = (raw: string) => (qu === null ? null : units(raw, q.decimals) * qu);
  return {
    ...r,
    chain,
    quote_key: q.key,
    quote_symbol: q.symbol,
    quote_decimals: q.decimals,
    quote_decimals_known: q.decimalsKnown !== false,
    token_id: Number(r.token_id),
    block_number: Number(r.block_number),
    tick,
    recipients: Array.isArray(r.recipients) ? r.recipients : [],
    trades_1h: Number(r.trades_1h ?? 0),
    traders_1h: Number(r.traders_1h ?? 0),
    traders_1h_ex: Number(r.traders_1h_ex ?? 0),
    volume_1h: String(r.volume_1h ?? "0"),
    trades_24h: Number(r.trades_24h ?? 0),
    traders_24h_ex: Number(r.traders_24h_ex ?? 0),
    volume_24h: String(r.volume_24h ?? "0"),
    last_outside_trade_at: r.last_outside_trade_at ? new Date(r.last_outside_trade_at).toISOString() : null,
    live_tier: r.live_tier === undefined || r.live_tier === null ? null : (TIERS[Number(r.live_tier)] ?? null),
    launcher_collapsed: Number(r.launcher_collapsed ?? 0),
    price_quote: price,
    fdv_quote: fdv,
    change_from_launch: launchFdv > 0 ? fdv / launchFdv - 1 : 0,
    image_url: canonicalImageUrl(r.image_url, imagePublicBase()),
    quote_usd: qu,
    price_usd: qu === null ? null : price * qu,
    fdv_usd: qu === null ? null : fdv * qu,
    volume_usd: usd(r.volume_quote),
    volume_1h_usd: usd(String(r.volume_1h ?? "0")),
    volume_24h_usd: usd(String(r.volume_24h ?? "0")),
  };
}

// Rolling stats per row, one probe of the swaps index per launch: the day window (LIVE_WINDOW_HOURS, the live gate) with
// the hour's figures as FILTERs. An "outside" swap is by a wallet that is not the launcher, not NULL (fails the FILTER)
// and not inside the sniper window (launch block + SNIPER_BLOCKS, the holders panel's definition: one bot buying every
// launch in its first seconds would otherwise make every token "live"). Sells in that window are excluded on purpose:
// all supply starts in the pool, so a sell there can only be a sniper flipping what it just bought. Outside counts are the live gate and the trending
// weight (lib/launchpad/ranking.ts); last_outside_at is what the live sort and its chip mean by "last trade", because
// bb_launches.last_trade_at also moves on the launcher's own swaps.
const OUTSIDE = `s.trader <> l.launcher AND s.block_number > l.block_number + ${SNIPER_BLOCKS}`;
const HOUR = `s.block_time > now() - interval '1 hour'`;
const SELECT = `SELECT l.*, m.description, m.image_url, m.website, m.x_handle,
  w.n1 AS trades_1h, w.t1 AS traders_1h, w.t1_ex AS traders_1h_ex, w.v1 AS volume_1h, w.n24 AS trades_24h, w.t24_ex AS traders_24h_ex, w.v24 AS volume_24h, w.last_outside_at AS last_outside_trade_at
  FROM bb_launches l
  LEFT JOIN bb_launch_meta m ON m.chain_id = l.chain_id AND m.token = l.token
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE ${HOUR})::int AS n1, count(DISTINCT s.trader) FILTER (WHERE ${HOUR})::int AS t1,
           count(DISTINCT s.trader) FILTER (WHERE ${HOUR} AND ${OUTSIDE})::int AS t1_ex, COALESCE(sum(abs(amount0)) FILTER (WHERE ${HOUR}), 0)::text AS v1,
           count(*)::int AS n24, count(DISTINCT s.trader) FILTER (WHERE ${OUTSIDE})::int AS t24_ex, COALESCE(sum(abs(amount0)), 0)::text AS v24,
           max(s.block_time) FILTER (WHERE ${OUTSIDE}) AS last_outside_at
      FROM bb_launch_swaps s WHERE s.chain_id = l.chain_id AND s.token = l.token AND s.block_time > now() - interval '${LIVE_WINDOW_HOURS} hours'
  ) w ON true`;

export type LaunchSort = "live" | "new" | "mcap" | "volume" | "gainers" | "holders";
export type VolumeWindow = "1h" | "24h" | "all";
export const LAUNCH_SORTS: LaunchSort[] = ["live", "new", "mcap", "volume", "gainers", "holders"];

/** The one place a sort name is parsed: allow-listed, with "trending" (the pre-Live name) kept as an alias of "live". */
export function parseSort<F extends LaunchSort | null>(raw: string | null | undefined, fallback: F): LaunchSort | F {
  if (raw === "trending") return "live";
  return LAUNCH_SORTS.includes(raw as LaunchSort) ? (raw as LaunchSort) : fallback;
}
export const VOLUME_WINDOWS: VolumeWindow[] = ["1h", "24h", "all"];

export type ListOpts = { sort?: LaunchSort; window?: VolumeWindow; chain?: ChainKey | null; filter?: LaunchFilter | null; limit?: number; offset?: number; launcher?: string; ethUsd?: number | null };
const NATIVE_ADDR = "0x0000000000000000000000000000000000000000";
const DEAD_ADDR = "0x000000000000000000000000000000000000dead";

export type ListPage = { items: LaunchRow[]; hasMore: boolean };

/**
 * Sorting + paging happen in SQL. Cross-chain money is normalized to USD inside
 * the query (USDG = 1, ETH = the price passed in) so "market cap" and "volume"
 * rank correctly across pools with different quotes. "New" orders by block
 * TIME, never by block number (chains have different heights).
 *
 * "Live" (the home default) applies the ranking rule from lib/launchpad/ranking.ts in SQL so paging stays
 * correct: tier 0 = an outside wallet traded it in the last day, ranked by outside wallets this hour, then today,
 * then the last outside trade; tier 1 = younger than the grace window; tier 2 = quiet; tiers 1 and 2 by age.
 * Outside tier 0 a launcher keeps only its newest row, and that row carries how many of its siblings were folded
 * (`launcher_collapsed`). The tier travels with the row (`live_tier`) so the client never recomputes it.
 */
export async function listLaunchesPage(opts: ListOpts = {}): Promise<ListPage> {
  const db = maybeDb();
  if (!db) return { items: [], hasMore: false };
  await withStocks();
  const limit = Math.min(200, Math.max(1, opts.limit ?? 40));
  const offset = Math.max(0, opts.offset ?? 0);
  const sort = opts.sort ?? "new";
  const win = opts.window ?? "all";
  const ethUsd = opts.ethUsd ?? null;
  const ethFactor = ethUsd ?? 1; // no ETH price → rank ETH pools in ETH units (still monotonic within the chain)
  // stock quotes: per-address USD factors known this request (empty → treated like unknown = 0 weight in USD sorts)
  const stockEntries = [...stockUsdNow.entries()].filter(([, v]) => v !== null && v > 0) as [string, number][];
  const conds = [] as ReturnType<typeof db>[];
  if (opts.chain) conds.push(db`l.chain_id = ${chainIdOf(opts.chain)}`);
  if (opts.launcher) conds.push(db`l.launcher = ${opts.launcher.toLowerCase()}`);
  if (opts.filter === "fee0") conds.push(db`l.lp_fee = 0`);
  if (opts.filter === "burn") conds.push(db`l.lp_fee > 0 AND jsonb_array_length(l.recipients) = 1 AND lower(l.recipients->0->>'payout') = ${DEAD_ADDR}`);
  // a fixed quote (USDG, USDC) is matched per chain: the same address elsewhere is some other token
  const quoteArms = (key: Quote["key"]) => {
    const arms = quotesWithKey(key).map(({ chain, address }) => db`(l.chain_id = ${chainIdOf(chain)} AND l.quote = ${address})`);
    return arms.length ? db`(${arms.reduce((a, c) => db`${a} OR ${c}`)})` : db`false`;
  };
  if (opts.filter === "usdg" || opts.filter === "usdc") conds.push(db`${quoteArms(opts.filter)}`);
  // GITLAWB has a different address per chain (and none on Arc): the same chain-scoped match
  const isGitlawb = () => quoteArms("gitlawb");
  if (opts.filter === "gitlawb") conds.push(db`${isGitlawb()}`);
  if (opts.filter === "today") conds.push(db`l.block_time > now() - interval '24 hours'`);
  const where = conds.length ? db`WHERE ${conds.reduce((a, c) => db`${a} AND ${c}`)}` : db``;
  // per-row USD factor and quote decimals (the stables, USDG and USDC, are the only fixed-price and non-18-dec quotes we list)
  // a registry stock is matched per (chain, address) like every other arm: the address is only a stock on the chain whose registry lists it
  const stockChains = (a: string) => CHAIN_KEYS.filter((k) => stockByAddress(k, a) !== null);
  const stockArms = stockEntries.flatMap(([a, v]) => stockChains(a).map((k) => db`WHEN (l.chain_id = ${chainIdOf(k)} AND l.quote = ${a}) THEN ${v}::double precision`));
  const stockCase = stockArms.length ? stockArms.reduce((acc, c) => db`${acc} ${c}`) : db``;
  const gitlawbFactor = gitlawbUsdNow !== null && gitlawbUsdNow > 0 ? gitlawbUsdNow : 0; // unknown → 0 weight, like an unknown stock
  const museworldFactor = museworldUsdNow !== null && museworldUsdNow > 0 ? museworldUsdNow : 0;
  const stables = fixedUsdQuotes();
  const stableCase = stables.length ? stables.map((s) => db`WHEN (l.chain_id = ${chainIdOf(s.chain)} AND l.quote = ${s.address}) THEN ${s.usd}::double precision`).reduce((acc, c) => db`${acc} ${c}`) : db``;
  // address(0) is ETH only where the chain's native asset is ETH; a native stable (Arc: USDC) is already in stableCase above
  const ethNativeArms = CHAIN_KEYS.filter((k) => NATIVE_QUOTES[k].key === "eth").map((k) => db`WHEN (l.chain_id = ${chainIdOf(k)} AND l.quote = ${NATIVE_ADDR}) THEN ${ethFactor}::double precision`);
  const ethNativeCase = ethNativeArms.length ? ethNativeArms.reduce((acc, c) => db`${acc} ${c}`) : db``;
  const usdPerUnit = db`(CASE ${stableCase} ${stockCase} WHEN ${isGitlawb()} THEN ${gitlawbFactor}::double precision WHEN ${quoteArms("museworld")} THEN ${museworldFactor}::double precision ${ethNativeCase} ELSE 0.0 END)`;
  const stockDecArms = stockEntries.flatMap(([a]) => stockChains(a).flatMap((k) => { const d = stockByAddress(k, a)!.decimals; return d !== 18 ? [db`WHEN (l.chain_id = ${chainIdOf(k)} AND l.quote = ${a}) THEN ${d}`] : []; }));
  const decCase = stockDecArms.length ? stockDecArms.reduce((acc, c) => db`${acc} ${c}`) : db``;
  const stableDec = stables.filter((s) => s.decimals !== 18);
  const stableDecCase = stableDec.length ? stableDec.map((s) => db`WHEN (l.chain_id = ${chainIdOf(s.chain)} AND l.quote = ${s.address}) THEN ${s.decimals}`).reduce((acc, c) => db`${acc} ${c}`) : db``;
  const qd = db`(CASE ${stableDecCase} ${decCase} ELSE 18 END)`;
  const volCol = win === "1h" ? db`w1.v::numeric` : win === "24h" ? db`w24.v::numeric` : db`l.volume_quote`;
  const volUsd = db`(${volCol} / power(10, ${qd}) * ${usdPerUnit})`;
  // quote per token = 1 / (1.0001^tick · 10^(qd-18)); mcap = that · supply/1e18 · usd
  const mcapUsd = db`((1.0 / (power(1.0001, COALESCE(l.tick, l.start_tick)::double precision) * power(10, ${qd} - 18))) * (l.supply / 1e18) * ${usdPerUnit})`;
  const newest = db`l.block_time DESC, l.chain_id DESC, l.block_number DESC`;
  if (sort === "live") {
    const rows = await db<Raw[]>`
      WITH base AS (
        SELECT x.*, CASE WHEN x.traders_24h_ex >= 1 THEN 0 WHEN x.block_time > now() - make_interval(hours => ${GRACE_HOURS}) THEN 1 ELSE 2 END AS live_tier
          FROM (${db.unsafe(SELECT)} ${where}) x
      ), rest AS ( -- tiers 1 and 2 on purpose: the grace hour goes to a wallet's newest launch, not to every launch in a loop
        SELECT chain_id, token, row_number() OVER (PARTITION BY launcher ORDER BY block_time DESC, chain_id DESC, block_number DESC) AS rn,
               (count(*) OVER (PARTITION BY launcher) - 1)::int AS launcher_collapsed
          FROM base WHERE live_tier > 0
      )
      SELECT base.*, COALESCE(rest.launcher_collapsed, 0) AS launcher_collapsed
        FROM base LEFT JOIN rest ON rest.chain_id = base.chain_id AND rest.token = base.token
       WHERE base.live_tier = 0 OR rest.rn = 1
       ORDER BY base.live_tier, base.traders_1h_ex DESC, base.traders_24h_ex DESC, base.last_outside_trade_at DESC NULLS LAST, base.block_time DESC, base.chain_id DESC, base.block_number DESC
       LIMIT ${limit + 1} OFFSET ${offset}`;
    const shaped = rows.map((r) => shape(r, ethUsd));
    return { items: shaped.slice(0, limit), hasMore: shaped.length > limit };
  }
  const order =
    sort === "volume"
      ? db`ORDER BY ${volUsd} DESC, ${newest}`
      : sort === "mcap"
        ? db`ORDER BY ${mcapUsd} DESC, ${newest}`
        : sort === "gainers"
          ? db`ORDER BY (l.start_tick - COALESCE(l.tick, l.start_tick)) DESC, ${newest}`
          : sort === "holders"
            ? db`ORDER BY l.holders DESC, ${newest}`
            : db`ORDER BY ${newest}`;
  const rows = await db<Raw[]>`${db.unsafe(SELECT)} ${where} ${order} LIMIT ${limit + 1} OFFSET ${offset}`;
  const shaped = rows.map((r) => shape(r, ethUsd));
  return { items: shaped.slice(0, limit), hasMore: shaped.length > limit };
}

/** Back-compat: first page only. */
export async function listLaunches(opts: ListOpts = {}): Promise<LaunchRow[]> {
  return (await listLaunchesPage(opts)).items;
}

export async function getLaunch(chain: ChainKey, token: string, ethUsd: number | null = null): Promise<LaunchRow | null> {
  const db = maybeDb();
  if (!db) return null;
  await withStocks();
  const rows = await db<Raw[]>`${db.unsafe(SELECT)} WHERE l.chain_id = ${chainIdOf(chain)} AND l.token = ${token.toLowerCase()}`;
  return rows[0] ? shape(rows[0], ethUsd) : null;
}

/** Find which chain a token lives on (for the legacy /t/<token> redirect). */
export async function findLaunchChain(token: string): Promise<ChainKey | null> {
  const db = maybeDb();
  if (!db) return null;
  const rows = await db<{ chain_id: number }[]>`SELECT chain_id FROM bb_launches WHERE token = ${token.toLowerCase()} ORDER BY block_time DESC, chain_id DESC, block_number DESC LIMIT 1`;
  return rows[0] ? chainKeyOf(rows[0].chain_id) : null;
}

export type SwapRow = { tx_hash: string; log_index: number; token: string; trader: string | null; amount0: string; amount1: string; is_buy: boolean; block_time: string; price_quote: number };

export async function getSwaps(chain: ChainKey, token: string, quoteDecimals: number, limit = 50): Promise<SwapRow[]> {
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<{ tx_hash: string; log_index: number; token: string; trader: string | null; amount0: string; amount1: string; is_buy: boolean; block_time: string; sqrt_price_x96: string }[]>`
    SELECT tx_hash, log_index, token, trader, amount0, amount1, is_buy, block_time, sqrt_price_x96 FROM bb_launch_swaps
    WHERE chain_id = ${chainIdOf(chain)} AND token = ${token.toLowerCase()} ORDER BY block_number DESC, log_index DESC LIMIT ${Math.min(200, limit)}`;
  return rows.map((r) => ({ ...r, price_quote: quotePerToken(BigInt(r.sqrt_price_x96), quoteDecimals) }));
}

/** Home tape: launches + trades across chains, newest first. */
export type FeedItem =
  | { kind: "launch"; chain: ChainKey; at: string; tx_hash: string; token: string; name: string; symbol: string; launcher: string; lp_fee: number; quote_key: Quote["key"]; image_url: string | null }
  | { kind: "swap"; chain: ChainKey; at: string; tx_hash: string; log_index: number; token: string; name: string; symbol: string; trader: string | null; is_buy: boolean; is_dev: boolean; quote_wei: string; quote_key: Quote["key"]; quote_symbol: string; quote_decimals: number; usd: number | null; image_url: string | null };

export type FeedSwap = Extract<FeedItem, { kind: "swap" }>;

export async function getLaunchFeed(limit = 24, ethUsd: number | null = null): Promise<FeedItem[]> {
  const db = maybeDb();
  if (!db) return [];
  await withStocks();
  const n = Math.min(100, limit);
  const image = (url: string | null) => canonicalImageUrl(url, imagePublicBase());
  const shapeSwap = (r: { chain_id: number; at: string; tx_hash: string; log_index: number; token: string; name: string; symbol: string; quote: string; trader: string | null; is_buy: boolean; quote_wei: string; image_url: string | null; is_dev: boolean | null }): FeedSwap => {
    const chain = chainKeyOf(r.chain_id) ?? DEFAULT_CHAIN;
    const q = quoteInfo(chain, r.quote);
    const qu = quoteUsd(q, ethUsd);
    return { kind: "swap", chain, at: r.at, tx_hash: r.tx_hash, log_index: r.log_index, token: r.token, name: r.name, symbol: r.symbol, trader: r.trader, is_buy: r.is_buy, is_dev: Boolean(r.is_dev), quote_wei: r.quote_wei, quote_key: q.key, quote_symbol: q.symbol, quote_decimals: q.decimals, usd: qu === null ? null : units(r.quote_wei, q.decimals) * qu, image_url: image(r.image_url) };
  };
  const [launches, swaps] = await Promise.all([
    db<{ chain_id: number; at: string; tx_hash: string; token: string; name: string; symbol: string; quote: string; launcher: string | null; lp_fee: number | null; image_url: string | null }[]>`
      SELECT l.chain_id, l.block_time AS at, l.tx_hash, l.token, l.name, l.symbol, l.quote, l.launcher, l.lp_fee, m.image_url
        FROM bb_launches l LEFT JOIN bb_launch_meta m ON m.chain_id = l.chain_id AND m.token = l.token
        ORDER BY l.block_time DESC LIMIT ${n}`,
    // Dust (feed-dust.ts) is priced and dropped after the read, so swaps come in pages: the newest 2n first, older pages
    // only while dust keeps the count short. Each page is a keyset read on the complete unique ordering
    // (block_time, log_index, chain_id, tx_hash) — a bounded scan of the block_time index, never OFFSET over a live table.
    collectNonDust<FeedSwap>(
      async (after, size) =>
        (
          await db<{ chain_id: number; at: string; tx_hash: string; log_index: number; token: string; name: string; symbol: string; quote: string; trader: string | null; is_buy: boolean; quote_wei: string; image_url: string | null; is_dev: boolean | null }[]>`
            SELECT s.chain_id, s.block_time AS at, s.tx_hash, s.log_index, s.token, l.name, l.symbol, l.quote, s.trader, s.is_buy, abs(s.amount0) AS quote_wei, m.image_url, (s.trader = l.launcher) AS is_dev
              FROM (SELECT * FROM bb_launch_swaps
                      ${after ? db`WHERE block_time <= ${after.at} AND (block_time, log_index, chain_id, tx_hash) < (${after.at}, ${after.log_index}, ${chainIdOf(after.chain)}, ${after.tx_hash})` : db``}
                      ORDER BY block_time DESC, log_index DESC, chain_id DESC, tx_hash DESC LIMIT ${size}) s
              JOIN bb_launches l ON l.chain_id = s.chain_id AND l.token = s.token LEFT JOIN bb_launch_meta m ON m.chain_id = l.chain_id AND m.token = l.token
              ORDER BY s.block_time DESC, s.log_index DESC, s.chain_id DESC, s.tx_hash DESC`
        ).map(shapeSwap),
      n,
      (i) => `${i.chain}:${i.tx_hash}:${i.log_index}`,
    ),
  ]);
  const items: FeedItem[] = launches.map((r) => {
    const chain = chainKeyOf(r.chain_id) ?? DEFAULT_CHAIN;
    return { kind: "launch", chain, at: r.at, tx_hash: r.tx_hash, token: r.token, name: r.name, symbol: r.symbol, launcher: r.launcher ?? "", lp_fee: r.lp_fee ?? 0, quote_key: quoteInfo(chain, r.quote).key, image_url: image(r.image_url) };
  });
  return [...items, ...swaps].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, n);
}

export type LaunchTotals = {
  launches: number;
  trades: number;
  /** USD sums across chains. A quote with no price right now contributes nothing; `usd_partial` says when that happened. */
  volume_usd: number;
  fees_burned_usd: number;
  fees_to_creators_usd: number;
  /** True when a quote that normally prices had none for a launch with volume or fees (cold start, a price feed down >15 min), so the USD sums undercount right now. */
  usd_partial: boolean;
  /**
   * GITLAWB sent to 0x…dEaD by launches quoted in it, raw 18-dec, Base + Robinhood combined: one token, one supply
   * bridged across two chains, so one figure and no per-chain split. Shown as an amount, never in USD.
   */
  gitlawb_burned: string;
  by_chain: Record<ChainKey, { launches: number; trades: number; volume_quote_eth: string; volume_quote_usdg: string; volume_quote_usdc: string; volume_quote_gitlawb: string }>;
};

export async function getLaunchTotals(ethUsd: number | null = null): Promise<LaunchTotals> {
  const empty = (): LaunchTotals => ({
    launches: 0,
    trades: 0,
    volume_usd: 0,
    fees_burned_usd: 0,
    fees_to_creators_usd: 0,
    usd_partial: false,
    gitlawb_burned: "0",
    by_chain: Object.fromEntries(CHAIN_KEYS.map((k) => [k, { launches: 0, trades: 0, volume_quote_eth: "0", volume_quote_usdg: "0", volume_quote_usdc: "0", volume_quote_gitlawb: "0" }])) as LaunchTotals["by_chain"],
  });
  const db = maybeDb();
  if (!db) return empty();
  await withStocks();
  const rows = await db<{ chain_id: number; quote: string; launches: bigint; trades: bigint; volume: string; burned: string; creators: string }[]>`
    SELECT chain_id, quote, count(*)::bigint AS launches, COALESCE(sum(buys + sells), 0)::bigint AS trades,
           COALESCE(sum(volume_quote), 0)::text AS volume, COALESCE(sum(fees_quote_burned), 0)::text AS burned,
           COALESCE(sum(fees_quote_collected - fees_quote_burned), 0)::text AS creators
      FROM bb_launches GROUP BY chain_id, quote`;
  const t = empty();
  const add = (a: string, b: string) => (BigInt(a) + BigInt(b)).toString();
  for (const r of rows) {
    const chain = chainKeyOf(r.chain_id);
    if (!chain) continue;
    const q = quoteInfo(chain, r.quote);
    const usd = quoteUsd(q, ethUsd);
    const qu = usd ?? 0;
    // a quote that normally prices (ETH, GITLAWB, a registry stock) but has no price this instant → the USD sums undercount;
    // an unlisted ERC-20 (key "other") is unpriced by design and is left out of the USD figures silently, as always
    if (usd === null && q.key !== "other" && (BigInt(r.volume) > 0n || BigInt(r.burned) > 0n || BigInt(r.creators) > 0n)) t.usd_partial = true;
    t.launches += Number(r.launches);
    t.trades += Number(r.trades);
    t.volume_usd += units(r.volume, q.decimals) * qu;
    t.fees_burned_usd += units(r.burned, q.decimals) * qu;
    t.fees_to_creators_usd += units(r.creators, q.decimals) * qu;
    const bc = t.by_chain[chain];
    bc.launches += Number(r.launches);
    bc.trades += Number(r.trades);
    if (q.key === "eth") bc.volume_quote_eth = add(bc.volume_quote_eth, r.volume);
    else if (q.key === "usdg") bc.volume_quote_usdg = add(bc.volume_quote_usdg, r.volume);
    // USDC volume is reported at 6 decimals; Arc's native USDC is the same asset at 18, so it is scaled down to join the bucket
    else if (q.key === "usdc") bc.volume_quote_usdc = add(bc.volume_quote_usdc, q.decimals === 18 ? (BigInt(r.volume) / 10n ** 12n).toString() : r.volume);
    else if (q.key === "gitlawb") {
      bc.volume_quote_gitlawb = add(bc.volume_quote_gitlawb, r.volume);
      // GITLAWB is only ever the quote side (never a launched token), so the quote-fee burn is the whole GITLAWB burn
      t.gitlawb_burned = add(t.gitlawb_burned, r.burned);
    }
  }
  return t;
}

/**
 * getLaunchTotals, shared per request: the root layout and a chain landing page both need the site totals,
 * and this is one unfiltered aggregation over bb_launches. React's cache hands the second caller the first
 * caller's result within a server render (same ethUsd argument; ethUsd() is memoized so both read the same
 * price). Outside a render (route handlers) it simply calls through.
 */
export const getLaunchTotalsForRequest = cache(getLaunchTotals);

export type FeeEventRow = { tx_hash: string; kind: string; currency: string | null; account: string | null; amount: string | null; quote_amount: string | null; token_amount: string | null; block_time: string };

export async function getFeeEvents(chain: ChainKey, token: string, limit = 30): Promise<FeeEventRow[]> {
  const db = maybeDb();
  if (!db) return [];
  return db<FeeEventRow[]>`
    SELECT tx_hash, kind, currency, account, amount, quote_amount, token_amount, block_time FROM bb_launch_fee_events
    WHERE chain_id = ${chainIdOf(chain)} AND token = ${token.toLowerCase()} ORDER BY block_number DESC, log_index DESC LIMIT ${Math.min(200, limit)}`;
}

export type SyncCursor = { chain: ChainKey; cursor_block: number; head_block: number | null; last_run_at: string | null; last_error: string | null };

export async function launchSyncCursors(): Promise<SyncCursor[]> {
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<{ chain_id: number; cursor_block: bigint; head_block: bigint | null; last_run_at: string | null; last_error: string | null }[]>`SELECT * FROM bb_launch_sync_cursor`;
  return rows
    .map((r) => ({ chain: chainKeyOf(r.chain_id), cursor_block: Number(r.cursor_block), head_block: r.head_block === null ? null : Number(r.head_block), last_run_at: r.last_run_at, last_error: r.last_error }))
    .filter((r): r is SyncCursor => r.chain !== null && CHAIN_KEYS.includes(r.chain));
}

/** Search by name / symbol (substring) or exact address, across chains. Ranked: symbol exact, symbol prefix, name prefix, substring. */
export async function searchLaunches(q: string, opts: { chain?: ChainKey | null; limit?: number; ethUsd?: number | null } = {}): Promise<LaunchRow[]> {
  const db = maybeDb();
  const n = normalizeQuery(q);
  if (!db || !n) return [];
  await withStocks();
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const chainCond = opts.chain ? db`AND l.chain_id = ${chainIdOf(opts.chain)}` : db``;
  const rows = isAddressQuery(n)
    ? await db<Raw[]>`${db.unsafe(SELECT)} WHERE l.token = ${n} ${chainCond}`
    // LIKE metacharacters in n are escaped (ESCAPE '\'): a search for "%" or
    // "_" matches those literal characters, not every row. Pre-limit orders by
    // block time — never raw block numbers across chains (Base heights dwarf
    // Robinhood's, so the old ORDER BY hid exact matches on the low chain).
    : await db<Raw[]>`${db.unsafe(SELECT)} WHERE (l.name ILIKE ${"%" + escapeLike(n) + "%"} ESCAPE '\\' OR l.symbol ILIKE ${"%" + escapeLike(n) + "%"} ESCAPE '\\') ${chainCond} ORDER BY l.block_time DESC, l.chain_id DESC, l.block_number DESC LIMIT 200`;
  const shaped = rows.map((r) => shape(r, opts.ethUsd ?? null));
  shaped.sort((a, b) => compareSearchHit(a, b, n));
  return shaped.slice(0, limit);
}

/**
 * OHLCV buckets from the swap log (sparse; the client fills gaps). Prices are
 * whole quote units per token, derived from each swap's post-trade sqrtPrice.
 * `from` = earliest bucket start (unix seconds).
 */
export async function getCandles(chain: ChainKey, token: string, intervalS: number, from: number, quoteDecimals: number, asOf = Math.floor(Date.now() / 1000)): Promise<RawCandle[]> {
  const db = maybeDb();
  if (!db) return [];
  // quote-per-token = 1 / ((sqrt/2^96)^2 · 10^(qd-18))
  const scale = Math.pow(10, quoteDecimals - 18);
  const rows = await db<{ t: number; open: number; high: number; low: number; close: number; volume: string; trades: number }[]>`
    WITH s AS (
      SELECT floor(extract(epoch FROM block_time) / ${intervalS})::bigint * ${intervalS} AS t,
             1.0 / (power(sqrt_price_x96::double precision / 79228162514264337593543950336.0, 2) * ${scale}) AS p,
             abs(amount0) AS v, block_number, log_index
        FROM bb_launch_swaps
       WHERE chain_id = ${chainIdOf(chain)} AND token = ${token.toLowerCase()}
         AND block_time >= to_timestamp(${from}) AND block_time <= to_timestamp(${asOf})
    )
    SELECT t::int AS t,
           (array_agg(p ORDER BY block_number, log_index))[1] AS open,
           max(p) AS high, min(p) AS low,
           (array_agg(p ORDER BY block_number DESC, log_index DESC))[1] AS close,
           sum(v)::text AS volume, count(*)::int AS trades
      FROM s GROUP BY t ORDER BY t`;
  return rows.map((r) => ({ t: Number(r.t), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: units(r.volume, quoteDecimals), trades: Number(r.trades) }));
}

/**
 * Seed an empty leading chart bucket from actual earlier history, not launch.
 * The chain/token index supplies chain order including multiple swaps per block;
 * the strict time boundary keeps the first requested bucket in the OHLCV query.
 */
export async function getCandleBaseline(chain: ChainKey, token: string, from: number, quoteDecimals: number): Promise<number | null> {
  const db = maybeDb();
  if (!db) return null;
  const rows = await db<{ sqrt_price_x96: string }[]>`
    SELECT sqrt_price_x96 FROM bb_launch_swaps
     WHERE chain_id = ${chainIdOf(chain)} AND token = ${token.toLowerCase()}
       AND block_time < to_timestamp(${from})
     ORDER BY block_number DESC, log_index DESC LIMIT 1`;
  return rows[0] ? quotePerToken(BigInt(rows[0].sqrt_price_x96), quoteDecimals) : null;
}

/** Trades by one wallet on one token, bounded to the chart snapshot's time. */
export async function getWalletSwaps(chain: ChainKey, token: string, wallet: string, asOf: number, limit = 200): Promise<{ t: number; is_buy: boolean; quote: string }[]> {
  if (!Number.isFinite(asOf)) return [];
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<{ t: number; is_buy: boolean; quote: string }[]>`
    SELECT extract(epoch FROM block_time)::int AS t, is_buy, abs(amount0)::text AS quote FROM bb_launch_swaps
     WHERE chain_id = ${chainIdOf(chain)} AND token = ${token.toLowerCase()} AND trader = ${wallet.toLowerCase()}
       AND block_time <= to_timestamp(${asOf})
     ORDER BY block_number DESC, log_index DESC LIMIT ${Math.min(500, limit)}`;
  return rows.map((r) => ({ t: Number(r.t), is_buy: r.is_buy, quote: r.quote }));
}

/** Tokens (launched here) that a wallet has traded, with its trade counts. Balances are read on-chain by the client. */
export async function getWalletTokens(wallet: string, ethUsd: number | null = null, limit = 100): Promise<(LaunchRow & { my_buys: number; my_sells: number; my_last_trade: string })[]> {
  const db = maybeDb();
  if (!db) return [];
  await withStocks();
  const w = wallet.toLowerCase();
  const rows = await db<(Raw & { my_buys: bigint; my_sells: bigint; my_last_trade: string })[]>`
    ${db.unsafe(SELECT)}
    JOIN LATERAL (
      SELECT count(*) FILTER (WHERE is_buy)::bigint AS my_buys, count(*) FILTER (WHERE NOT is_buy)::bigint AS my_sells, max(block_time) AS my_last_trade
        FROM bb_launch_swaps s WHERE s.chain_id = l.chain_id AND s.token = l.token AND s.trader = ${w}
    ) mine ON mine.my_buys + mine.my_sells > 0
    ORDER BY mine.my_last_trade DESC LIMIT ${Math.min(200, limit)}`;
  return rows.map((r) => ({ ...shape(r, ethUsd), my_buys: Number(r.my_buys), my_sells: Number(r.my_sells), my_last_trade: r.my_last_trade }));
}

export type WalletTrade = { chain: ChainKey; token: string; symbol: string; name: string; tx_hash: string; is_buy: boolean; quote_raw: string; quote_symbol: string; quote_decimals: number; usd: number | null; tokens: string; block_time: string };

export async function getWalletTrades(wallet: string, ethUsd: number | null = null, limit = 50): Promise<WalletTrade[]> {
  const db = maybeDb();
  if (!db) return [];
  await withStocks();
  const rows = await db<{ chain_id: number; token: string; symbol: string; name: string; quote: string; tx_hash: string; is_buy: boolean; amount0: string; amount1: string; block_time: string }[]>`
    SELECT s.chain_id, s.token, l.symbol, l.name, l.quote, s.tx_hash, s.is_buy, s.amount0, s.amount1, s.block_time
      FROM bb_launch_swaps s JOIN bb_launches l ON l.chain_id = s.chain_id AND l.token = s.token
     WHERE s.trader = ${wallet.toLowerCase()} ORDER BY s.block_number DESC, s.log_index DESC LIMIT ${Math.min(200, limit)}`;
  return rows.map((r) => {
    const chain = chainKeyOf(r.chain_id) ?? DEFAULT_CHAIN;
    const q = quoteInfo(chain, r.quote);
    const qu = quoteUsd(q, ethUsd);
    const raw = BigInt(r.amount0) < 0n ? (-BigInt(r.amount0)).toString() : r.amount0;
    const tok = BigInt(r.amount1) < 0n ? (-BigInt(r.amount1)).toString() : r.amount1;
    return { chain, token: r.token, symbol: r.symbol, name: r.name, tx_hash: r.tx_hash, is_buy: r.is_buy, quote_raw: raw, quote_symbol: q.symbol, quote_decimals: q.decimals, usd: qu === null ? null : units(raw, q.decimals) * qu, tokens: tok, block_time: r.block_time };
  });
}

export type TrendingSnap = { window: "1h" | "24h"; items: LaunchRow[] };

export const TRENDING_CANDIDATES = 40;

/**
 * "Hot right now" from rows already fetched: the first page of the live sort (all chains, no filter) is the candidate set.
 * Unlisted pairs stay in the lists (with their badge) but are never promoted here.
 */
export function trendingFrom(rows: LaunchRow[]): TrendingSnap {
  return rankTrending(rows.filter((r) => r.quote_key !== "other"), Date.now());
}

/** True when a list request's first page doubles as the trending candidate set, so callers can skip `getTrending`. */
export function isTrendingSource(opts: ListOpts): boolean {
  return opts.sort === "live" && !opts.chain && !opts.filter && (opts.window ?? "all") === "all" && !opts.offset && (opts.limit ?? 0) >= TRENDING_CANDIDATES;
}

/** "Hot right now": the top of the live sort, ranked for the strip by lib/launchpad/ranking.ts. */
export async function getTrending(ethUsd: number | null = null): Promise<TrendingSnap> {
  const page = await listLaunchesPage({ sort: "live", limit: TRENDING_CANDIDATES, ethUsd });
  return trendingFrom(page.items);
}
