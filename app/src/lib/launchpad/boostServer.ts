import "server-only";
import { isAddress } from "viem";
import { maybeDb } from "@/lib/db";
import { getLaunchesByRefs, type LaunchRow } from "./queries";
import { forgetMemo, memo } from "./memo";
import { boostEnabled } from "./boostSwitch";
import { tsFresh } from "./posts";
import { adminWallets, consumeNonce, isNonce, verify } from "./postsServer";
import {
  BOOST_CHAIN,
  BOOST_CHAIN_ID,
  BOOST_FLOOR_TWIG,
  BOOST_LANE_SIZE,
  BOOST_WINDOW_H,
  boostExpiresAt,
  buildBoostModMessage,
  isBoostModAction,
  rankLane,
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
export type BoostLaneItem = LaneTotals & { expires_at: string; launch: LaunchRow };
export type BoostLane = { enabled: false } | { enabled: true; window_h: number; floor_twig: string; items: BoostLaneItem[] };
export type TokenBoost =
  | { enabled: false }
  | { enabled: true; hidden: boolean; twig: string; boosts: number; boosters: number; last_at: string | null; last_tx: string | null; expires_at: string | null; place: number | null; entry: LaneEntry };

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

/** The Boosted lane: the top BOOST_LANE_SIZE tokens with their market rows. `{ enabled: false }` while the switch is off. */
export async function getBoostLane(ethUsd: number | null): Promise<BoostLane> {
  if (!boostEnabled()) return { enabled: false };
  // a few spare candidates, so a token whose market row cannot be read leaves its place to the next one, not a hole
  const top = (await rankedLane()).slice(0, BOOST_LANE_SIZE + 3);
  const rows = top.length > 0 ? await getLaunchesByRefs(top.map((t) => ({ chain: BOOST_CHAIN, token: t.token })), ethUsd) : [];
  const byToken = new Map(rows.map((r) => [r.launch.token, r.launch]));
  const items = top
    .flatMap((t) => {
      const launch = byToken.get(t.token);
      return launch ? [{ ...t, expires_at: new Date(boostExpiresAt(t.last_at)).toISOString(), launch }] : [];
    })
    .slice(0, BOOST_LANE_SIZE);
  return { enabled: true, window_h: BOOST_WINDOW_H, floor_twig: BOOST_FLOOR_TWIG.toString(), items };
}

/**
 * The lane for a page render or a live poll, shared for a few seconds; null when it could not be read. Never the reason
 * a page fails: a page then shows no lane, and a poll sends none, so open tabs keep what they show until the next tick.
 */
export async function boostLaneOrNull(ethUsd: number | null): Promise<BoostLane | null> {
  if (!boostEnabled()) return { enabled: false };
  return memo(LANE_KEY, LANE_TTL_MS, () => getBoostLane(ethUsd)).catch((err) => {
    console.warn("[boost] lane read failed:", err instanceof Error ? err.message : err);
    return null;
  });
}

/** One token's boost state for its page: TWIG inside the window, its place in the lane (1-based) and whether an admin hid it. */
export async function getTokenBoost(token: string): Promise<TokenBoost> {
  if (!boostEnabled()) return { enabled: false };
  const db = maybeDb();
  const t = token.toLowerCase();
  const none = { enabled: true as const, hidden: false, twig: "0", boosts: 0, boosters: 0, last_at: null, last_tx: null, expires_at: null, place: null, entry: { full: false, cutoff: null } };
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
