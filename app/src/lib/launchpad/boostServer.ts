import "server-only";
import { createHash } from "node:crypto";
import { isAddress } from "viem";
import { maybeDb } from "@/lib/db";
import { getLaunchesByRefs, type LaunchRow } from "./queries";
import { forgetMemo, memo } from "./memo";
import { boostEnabled } from "./boostSwitch";
import { tsFresh } from "./posts";
import { adminWallets, consumeNonce, isNonce, verify } from "./postsServer";
import { namesFor, type NameEntry } from "@/lib/profiles/server";
import {
  BOOST_CHAIN,
  BOOST_CHAIN_ID,
  BOOST_FLOOR_TWIG,
  BOOST_LANE_SIZE,
  BOOST_WINDOW_H,
  BOOST_CLICKS_KEEP_DAYS,
  boostClickSlot,
  boostExpiresAt,
  boostPlace,
  boostTimeLeft,
  boostViewHour,
  buildBoostModMessage,
  isBoostModAction,
  rankLane,
  topBoosters,
  type BoostSeen,
  type BoosterTotal,
  type BoostStatsDays,
  type LaneEntry,
  type LaneTotals,
} from "./boost";

export { boostEnabled };

/**
 * Server half of Boost (boost.ts holds the rule). The feature is OFF unless the runtime secret BOOST=on is set
 * (`fly secrets set BOOST=on`, which restarts the app; no rebuild). Off, the API says only `{ enabled: false }` and no
 * page shows the lane, the token page line or the dialog. The indexer records boosts either way: they are TWIG burns
 * on-chain whatever the switch says, and turning it on then shows the last 24 hours as they were.
 */
/**
 * `clicks`: the card's clicks from the lane in the last 24 hours (bb_boost_clicks), the window its TWIG is counted in.
 * `top_booster`: the wallet that sent the most TWIG for it in that window (the card's credit).
 * `names` (on the lane): the credited wallets' public names, null for a wallet with none, so the first paint shows them.
 * All optional for readers: a machine still on an older build answers polls without them while a deploy rolls.
 */
export type BoostLaneItem = LaneTotals & { expires_at: string; launch: LaunchRow; clicks?: number; top_booster?: string };
export type BoostLane = { enabled: false } | { enabled: true; window_h: number; floor_twig: string; items: BoostLaneItem[]; names?: Record<string, NameEntry | null> };
export type TokenBoost =
  | { enabled: false }
  | { enabled: true; hidden: boolean; twig: string; boosts: number; boosters: number; last_at: string | null; last_tx: string | null; expires_at: string | null; place: number | null; entry: LaneEntry; clicks?: number };

const RAW_FLOOR = (BOOST_FLOOR_TWIG * 10n ** 18n).toString();
const LANE_TTL_MS = 5_000;

/**
 * Every token's boosts inside the window, summed, for tokens not hidden from the lane, largest first. The launch is
 * joined by position id (the tag), so a boost that names no launch is never shown. `limit` bounds the read.
 */
async function laneTotals(limit: number): Promise<LaneTotals[]> {
  const db = maybeDb();
  if (!db) return [];
  return db<LaneTotals[]>`
    SELECT l.token, sum(b.amount)::text AS twig, count(*)::int AS boosts, count(DISTINCT b.booster)::int AS boosters,
           max(b.block_time) AS last_at,
           (array_agg(b.tx_hash ORDER BY b.block_number DESC, b.log_index DESC))[1] AS last_tx
      FROM bb_boosts b
      JOIN bb_launches l ON l.chain_id = b.chain_id AND l.token_id = b.tag
      LEFT JOIN bb_token_settings s ON s.chain_id = l.chain_id AND s.token = l.token
     WHERE b.chain_id = ${BOOST_CHAIN_ID}
       AND b.block_time > now() - make_interval(hours => ${BOOST_WINDOW_H})
       AND b.amount >= ${RAW_FLOOR}::numeric
       AND NOT COALESCE(s.boost_hidden, false)
     GROUP BY l.token
     ORDER BY sum(b.amount) DESC, max(b.block_time) DESC
     LIMIT ${limit}`;
}

const TOTALS_KEY = "boost:lane-totals";
const LANE_KEY = "boost:lane";

/** The lane's order, shared for a few seconds by every page load and poll. */
function rankedLane(): Promise<LaneTotals[]> {
  return memo(TOTALS_KEY, LANE_TTL_MS, async () => rankLane(await laneTotals(BOOST_LANE_SIZE * 4), BOOST_LANE_SIZE * 4));
}

/**
 * After a write that changes the lane (a boost just indexed, an admin hide): the next read on this machine is fresh,
 * so the booster's page shows its place and the admin's list drops the card. Another machine catches up within LANE_TTL_MS.
 */
export function forgetBoostLane(): void {
  forgetMemo(TOTALS_KEY);
  forgetMemo(LANE_KEY);
}

/** Is the lane full, and what does its last place hold: what a boost has to reach to show now. */
function laneEntry(ranked: readonly LaneTotals[]): LaneEntry {
  const full = ranked.length >= BOOST_LANE_SIZE;
  return { full, cutoff: full ? ranked[BOOST_LANE_SIZE - 1].twig : null };
}

/**
 * Each token's clicks from the lane in the last 24 hours. Every row was counted while its token was in the lane, once
 * per visitor and 30 minutes (recordBoostSeen). A failed read is no clicks shown, never a lane that fails.
 */
async function laneClicks(tokens: readonly string[]): Promise<Map<string, number>> {
  const db = maybeDb();
  if (!db || tokens.length === 0) return new Map();
  try {
    const rows = await db<{ token: string; clicks: number }[]>`
      SELECT token, count(*)::int AS clicks FROM bb_boost_clicks
       WHERE chain_id = ${BOOST_CHAIN_ID} AND token = ANY(${tokens as string[]}::text[])
         AND clicked_at > now() - make_interval(hours => ${BOOST_WINDOW_H})
       GROUP BY token`;
    return new Map(rows.map((r) => [r.token, r.clicks]));
  } catch (err) {
    console.warn("[boost] lane clicks read failed:", err instanceof Error ? err.message : err);
    return new Map();
  }
}

/**
 * Each token's wallets and what each sent for it inside the window, for the card's credit (topBoosters picks). A failed
 * read is no credit shown, never a lane that fails.
 */
async function laneBoosters(tokens: readonly string[]): Promise<Map<string, string>> {
  const db = maybeDb();
  if (!db || tokens.length === 0) return new Map();
  try {
    const rows = await db<BoosterTotal[]>`
      SELECT l.token, b.booster, sum(b.amount)::text AS twig, max(b.block_time) AS last_at
        FROM bb_boosts b
        JOIN bb_launches l ON l.chain_id = b.chain_id AND l.token_id = b.tag
       WHERE b.chain_id = ${BOOST_CHAIN_ID} AND l.token = ANY(${tokens as string[]}::text[])
         AND b.block_time > now() - make_interval(hours => ${BOOST_WINDOW_H})
         AND b.amount >= ${RAW_FLOOR}::numeric
       GROUP BY l.token, b.booster`;
    return topBoosters(rows);
  } catch (err) {
    console.warn("[boost] lane boosters read failed:", err instanceof Error ? err.message : err);
    return new Map();
  }
}

/**
 * The credited wallets' names for the lane's first paint (the same lookup the token page seeds its NamesProvider
 * with): null says "no profile" so the browser does not ask again. A failed lookup seeds nothing; the browser asks.
 */
async function creditNames(wallets: readonly string[]): Promise<Record<string, NameEntry | null>> {
  if (wallets.length === 0) return {};
  const known = await namesFor(wallets).catch(() => null);
  return known ? Object.fromEntries(wallets.map((w) => [w, known[w] ?? null])) : {};
}

/**
 * The Boosted lane: the top BOOST_LANE_SIZE tokens with their market rows. `{ enabled: false }` while the switch is off.
 * `fresh` skips the few-second ranking memo too (the admin panel after a hide: the other machine's memos may still hold
 * the token); pages and polls read it through boostLaneOrNull instead.
 */
export async function getBoostLane(ethUsd: number | null, opts: { fresh?: boolean } = {}): Promise<BoostLane> {
  if (!boostEnabled()) return { enabled: false };
  const ranked = opts.fresh ? rankLane(await laneTotals(BOOST_LANE_SIZE * 4), BOOST_LANE_SIZE * 4) : await rankedLane();
  // a few spare candidates, so a token whose market row cannot be read leaves its place to the next one, not a hole
  const top = ranked.slice(0, BOOST_LANE_SIZE + 3);
  const rows = top.length > 0 ? await getLaunchesByRefs(top.map((t) => ({ chain: BOOST_CHAIN, token: t.token })), ethUsd) : [];
  const byToken = new Map(rows.map((r) => [r.launch.token, r.launch]));
  const shown = top
    .flatMap((t) => {
      const launch = byToken.get(t.token);
      return launch ? [{ ...t, expires_at: new Date(boostExpiresAt(t.last_at)).toISOString(), launch }] : [];
    })
    .slice(0, BOOST_LANE_SIZE);
  const tokens = shown.map((t) => t.token);
  const [clicks, boosters] = await Promise.all([laneClicks(tokens), laneBoosters(tokens)]);
  const items = shown.map((t) => ({ ...t, clicks: clicks.get(t.token) ?? 0, top_booster: boosters.get(t.token) }));
  return { enabled: true, window_h: BOOST_WINDOW_H, floor_twig: BOOST_FLOOR_TWIG.toString(), items, names: await creditNames([...boosters.values()]) };
}

/**
 * The lane for a page render or a live poll, shared for a few seconds; null when it could not be read. Never the reason
 * a page fails: a page then shows no lane, and a poll sends none, so open tabs keep what they show until the next tick.
 * A boost that ran out inside the cache's few seconds is dropped here, once, for every reader (pages, polls, beacons).
 */
export async function boostLaneOrNull(ethUsd: number | null): Promise<BoostLane | null> {
  if (!boostEnabled()) return { enabled: false };
  const lane = await memo(LANE_KEY, LANE_TTL_MS, () => getBoostLane(ethUsd)).catch((err) => {
    console.warn("[boost] lane read failed:", err instanceof Error ? err.message : err);
    return null;
  });
  if (!lane?.enabled) return lane;
  const now = Date.now();
  return { ...lane, items: lane.items.filter((b) => boostTimeLeft(b.last_at, now) !== null) };
}

/**
 * One token's boost state for its page: TWIG inside the window, its place in the lane (1-based), whether an admin hid
 * it, and its clicks from the lane in the same 24 hours (the panel shows them from BOOST_PANEL_CLICKS_MIN up). `clicks`
 * is optional for readers: a machine on an older build answers without it while a deploy rolls.
 */
export async function getTokenBoost(token: string): Promise<TokenBoost> {
  if (!boostEnabled()) return { enabled: false };
  const db = maybeDb();
  const t = token.toLowerCase();
  const none = { enabled: true as const, hidden: false, twig: "0", boosts: 0, boosters: 0, last_at: null, last_tx: null, expires_at: null, place: null, entry: { full: false, cutoff: null }, clicks: 0 };
  if (!db) return none;
  const [[row], [setting], ranked] = await Promise.all([
    db<{ twig: string; boosts: number; boosters: number; last_at: string | null; last_tx: string | null }[]>`
      SELECT COALESCE(sum(b.amount), 0)::text AS twig, count(*)::int AS boosts, count(DISTINCT b.booster)::int AS boosters,
             max(b.block_time) AS last_at,
             (array_agg(b.tx_hash ORDER BY b.block_number DESC, b.log_index DESC))[1] AS last_tx
        FROM bb_boosts b
        JOIN bb_launches l ON l.chain_id = b.chain_id AND l.token_id = b.tag
       WHERE b.chain_id = ${BOOST_CHAIN_ID} AND l.token = ${t}
         AND b.block_time > now() - make_interval(hours => ${BOOST_WINDOW_H})
         AND b.amount >= ${RAW_FLOOR}::numeric`,
    db<{ boost_hidden: boolean }[]>`SELECT boost_hidden FROM bb_token_settings WHERE chain_id = ${BOOST_CHAIN_ID} AND token = ${t}`,
    rankedLane(),
  ]);
  // the lane's own count (same window, same rows as the card); only for a token boosted in the window, since the panel
  // shows nothing otherwise. laneClicks never throws: a failed read is no clicks line.
  const clicks = row?.last_at ? ((await laneClicks([t])).get(t) ?? 0) : 0;
  const i = ranked.findIndex((r) => r.token === t);
  return {
    enabled: true,
    hidden: setting?.boost_hidden === true,
    twig: row?.twig ?? "0",
    boosts: row?.boosts ?? 0,
    boosters: row?.boosters ?? 0,
    last_at: row?.last_at ?? null,
    last_tx: row?.last_tx ?? null,
    expires_at: row?.last_at ? new Date(boostExpiresAt(row.last_at)).toISOString() : null,
    place: i >= 0 && i < BOOST_LANE_SIZE ? i + 1 : null,
    entry: laneEntry(ranked),
    clicks,
  };
}

/* ─────────────────────────────── views and clicks ─────────────────────────────── */

/** The lane's tokens as pages show them now, in order: the same few-second cache the pages and polls read. */
async function laneTokensNow(ethUsdNow: number | null): Promise<string[]> {
  const lane = await boostLaneOrNull(ethUsdNow);
  return lane?.enabled ? lane.items.map((b) => b.token) : [];
}

/**
 * Views are tallied in memory and written once every VIEW_FLUSH_MS per machine, not once per page: every view touches
 * the same few rows (one per lane token per hour), and a busy page must not queue writes on them. A restart loses at
 * most the views of the last few seconds.
 */
const VIEW_FLUSH_MS = 10_000;
const pendingViews = new Map<string, number>(); // `${token}|${hour}` → views
let viewFlush: ReturnType<typeof setTimeout> | null = null;

function queueViews(tokens: readonly string[], nowMs: number): void {
  const hour = boostViewHour(nowMs);
  // 5 tokens and at most 2 hours between flushes; a bound anyway, should flushes keep failing
  if (pendingViews.size > 1_000) pendingViews.clear();
  for (const t of tokens) pendingViews.set(`${t}|${hour}`, (pendingViews.get(`${t}|${hour}`) ?? 0) + 1);
  if (!viewFlush) {
    viewFlush = setTimeout(() => void flushViews(), VIEW_FLUSH_MS);
    viewFlush.unref?.();
  }
}

let lastPrune = 0;

async function flushViews(): Promise<void> {
  viewFlush = null;
  const batch = [...pendingViews];
  pendingViews.clear();
  const db = maybeDb();
  if (!db || batch.length === 0) return;
  const keys = batch.map(([k]) => k.split("|"));
  try {
    await db`INSERT INTO bb_boost_views (chain_id, token, hour_at, views)
             SELECT ${BOOST_CHAIN_ID}, u.t, u.h::timestamptz, u.n
               FROM unnest(${keys.map((k) => k[0])}::text[], ${keys.map((k) => k[1])}::text[], ${batch.map(([, n]) => n)}::int[]) AS u(t, h, n)
             ON CONFLICT (chain_id, token, hour_at) DO UPDATE SET views = bb_boost_views.views + EXCLUDED.views`;
  } catch (err) {
    console.warn("[boost] views flush failed:", err instanceof Error ? err.message : err);
  }
  // click rows name a visitor of one day: none outlives BOOST_CLICKS_KEEP_DAYS. Hourly, off the request path.
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    await db`DELETE FROM bb_boost_clicks WHERE chain_id = ${BOOST_CHAIN_ID} AND clicked_at < now() - make_interval(days => ${BOOST_CLICKS_KEEP_DAYS})`.catch((err) => {
      console.warn("[boost] clicks prune failed:", err instanceof Error ? err.message : err);
    });
  }
}

/**
 * A click's visitor: the hash of the address with the daily salt (the route passes visitorHash(address, ""), no user
 * agent), mixed with the token and cut short, so two tokens' clicks never link.
 */
function clickVisitor(visitorHash: string, token: string): string {
  return createHash("sha256").update(`${visitorHash}|${token}`).digest("hex").slice(0, 32);
}

/**
 * Record a lane beacon; true when it counted. A view adds 1 to this hour of every token in the lane now (queued, see
 * queueViews). A click counts
 * once per visitor, token and 30-minute slot, and only while the token is in the lane: its place is read from the
 * server's lane, never taken from the request, and a tab left open after a boost ran out counts nothing.
 */
export async function recordBoostSeen(seen: BoostSeen, visitorHash: string, ethUsdNow: number | null): Promise<boolean> {
  if (!boostEnabled()) return false;
  const db = maybeDb();
  if (!db) return false;
  const lane = await laneTokensNow(ethUsdNow);
  if (seen.kind === "view") {
    if (lane.length === 0) return false;
    queueViews(lane, Date.now());
    return true;
  }
  const place = boostPlace(lane, seen.token);
  if (place === null) return false;
  const rows = await db`INSERT INTO bb_boost_clicks (chain_id, token, visitor, slot, place, source)
                        VALUES (${BOOST_CHAIN_ID}, ${seen.token}, ${clickVisitor(visitorHash, seen.token)}, ${boostClickSlot(Date.now())}, ${place}, ${seen.source})
                        ON CONFLICT DO NOTHING RETURNING 1`;
  return rows.length > 0;
}

/** One token's lane figures over a period: views, clicks, visitors (one per person per day) and the TWIG burned for it. */
export type BoostStatsRow = { token: string; name: string | null; symbol: string | null; views: number; clicks: number; visitors: number; twig: string; boosts: number };
/**
 * The period's totals over every token, not only the rows listed. Visitors have no total: a visitor is counted per
 * token (the hash mixes the token in), so one person on five cards cannot be told from five people.
 */
export type BoostStats = { rows: BoostStatsRow[]; total: { tokens: number; views: number; clicks: number; twig: string } };

const STATS_ROWS = 100;

/**
 * Every token seen, clicked or boosted in the last `days` days, most clicks first. Views, clicks and burns all start
 * at the same whole hour, so the click rate compares like with like (views are counted by the hour).
 */
export async function getBoostStats(days: BoostStatsDays): Promise<BoostStats> {
  const db = maybeDb();
  const empty: BoostStats = { rows: [], total: { tokens: 0, views: 0, clicks: 0, twig: "0" } };
  if (!db) return empty;
  const rows = await db<(BoostStatsRow & { all_tokens: number; all_views: number; all_clicks: number; all_twig: string })[]>`
    WITH v AS (
      SELECT token, sum(views)::int AS views FROM bb_boost_views
       WHERE chain_id = ${BOOST_CHAIN_ID} AND hour_at >= date_trunc('hour', now() - make_interval(days => ${days}))
       GROUP BY token
    ), k AS (
      SELECT token, count(*)::int AS clicks, count(DISTINCT visitor)::int AS visitors FROM bb_boost_clicks
       WHERE chain_id = ${BOOST_CHAIN_ID} AND clicked_at >= date_trunc('hour', now() - make_interval(days => ${days}))
       GROUP BY token
    ), b AS (
      SELECT l.token, sum(x.amount) AS twig, count(*)::int AS boosts
        FROM bb_boosts x
        JOIN bb_launches l ON l.chain_id = x.chain_id AND l.token_id = x.tag
       WHERE x.chain_id = ${BOOST_CHAIN_ID} AND x.block_time >= date_trunc('hour', now() - make_interval(days => ${days}))
         AND x.amount >= ${RAW_FLOOR}::numeric
       GROUP BY l.token
    ), t AS (SELECT token FROM v UNION SELECT token FROM k UNION SELECT token FROM b)
    SELECT t.token, l.name, l.symbol, COALESCE(v.views, 0) AS views, COALESCE(k.clicks, 0) AS clicks,
           COALESCE(k.visitors, 0) AS visitors, COALESCE(b.twig, 0)::text AS twig, COALESCE(b.boosts, 0) AS boosts,
           -- window totals run before LIMIT: they cover every token, not only the rows listed
           (count(*) OVER ())::int AS all_tokens, (sum(COALESCE(v.views, 0)) OVER ())::int AS all_views,
           (sum(COALESCE(k.clicks, 0)) OVER ())::int AS all_clicks, (sum(COALESCE(b.twig, 0)) OVER ())::text AS all_twig
      FROM t
      LEFT JOIN v ON v.token = t.token
      LEFT JOIN k ON k.token = t.token
      LEFT JOIN b ON b.token = t.token
      LEFT JOIN bb_launches l ON l.chain_id = ${BOOST_CHAIN_ID} AND l.token = t.token
     ORDER BY clicks DESC, views DESC, t.token
     LIMIT ${STATS_ROWS}`;
  if (rows.length === 0) return empty;
  const first = rows[0];
  return {
    rows: rows.map((r) => ({ token: r.token, name: r.name, symbol: r.symbol, views: r.views, clicks: r.clicks, visitors: r.visitors, twig: r.twig, boosts: r.boosts })),
    total: { tokens: first.all_tokens, views: first.all_views, clicks: first.all_clicks, twig: first.all_twig },
  };
}

type Fail = { ok: false; error: string; status: number };
const fail = (error: string, status: number): Fail => ({ ok: false, error, status });

/**
 * Admin hide / unhide of one Base token in the Boosted lane: an ADMIN_WALLETS signature over buildBoostModMessage with
 * a single-use nonce and a fresh timestamp. Boosts already sent stay recorded and are never refunded; a hidden token
 * simply does not appear, and its page says so (so nobody burns TWIG for a place it cannot get).
 */
export async function moderateBoost(p: { action: unknown; token: unknown; wallet: unknown; nonce: unknown; ts: unknown; signature: unknown }): Promise<{ ok: true } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (typeof p.wallet !== "string" || !isAddress(p.wallet)) return fail("bad address", 400);
  const wallet = p.wallet.toLowerCase();
  if (!isBoostModAction(p.action)) return fail("bad action", 400);
  if (typeof p.token !== "string" || !isAddress(p.token)) return fail("bad token", 400);
  const token = p.token.toLowerCase();
  if (!isNonce(p.nonce) || !tsFresh(p.ts, Date.now())) return fail("stale or bad nonce", 400);
  if (!adminWallets().has(wallet)) return fail("admin only", 403);
  const [known] = await db<{ token: string }[]>`SELECT token FROM bb_launches WHERE chain_id = ${BOOST_CHAIN_ID} AND token = ${token}`;
  if (!known) return fail("unknown token", 404);
  const message = buildBoostModMessage({ action: p.action, token, wallet, nonce: p.nonce, ts: Number(p.ts) });
  if (!(await verify(BOOST_CHAIN, wallet, message, p.signature))) return fail("signature does not match", 401);
  if (!(await consumeNonce(p.nonce, wallet))) return fail("nonce already used", 401);
  await db`INSERT INTO bb_token_settings (chain_id, token, boost_hidden) VALUES (${BOOST_CHAIN_ID}, ${token}, ${p.action === "hide"})
           ON CONFLICT (chain_id, token) DO UPDATE SET boost_hidden = EXCLUDED.boost_hidden, updated_at = now()`;
  forgetBoostLane();
  return { ok: true };
}
