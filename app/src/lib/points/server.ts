import "server-only";
import { isAddress } from "viem";
import { CHAIN_KEYS, chainKeyOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb, type Db } from "@/lib/db";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { DEAD_ADDR, ZERO_ADDR } from "@/lib/launchpad/holders";
import { systemAddresses } from "@/lib/launchpad/indexer";
import { quotePerToken } from "@/lib/launchpad/math";
import { quotePricer } from "@/lib/launchpad/queries";
import { namesFor, type NameEntry } from "@/lib/profiles/server";
import { isEligible, notEligibleReason, rankBy, scoreSeason, whyLine, type CreatorBreakdown, type FirstBuy, type NotEligibleReason, type ScoreLaunch, type ScoreSwap, type ScoutBreakdown } from "./score";

/**
 * Season points, the server half: load one season's chain data, score it (score.ts), replace the season's rows.
 * Runs hourly from the sync loop (fire-and-forget, so indexing never waits for it) on ONE machine (session advisory
 * lock on a reserved connection, which also runs the reads one after another so the request pool stays free), and on
 * demand from /admin. Everything is recomputed from scratch, so a rule change or an admin flag applies to the whole
 * season on the next run. A run whose prices are incomplete writes nothing: the last board stays.
 */

export type Season = { id: number; slug: string; name: string; starts_at: string; ends_at: string; public: boolean; computed_at: string | null };
export type Board = "creator" | "scout";
export type BoardRow = { rank: number; wallet: string; points: number; why: string };
export type WalletPoints = { creator: number; scout: number; total: number; eligible: boolean; rank_creator: number | null; rank_scout: number | null; why_creator: string; why_scout: string; computed_at: string };

/** The current season: the latest one that has started (a finished one stays as the final standings until the next). */
export async function currentSeason(): Promise<Season | null> {
  const db = maybeDb();
  if (!db) return null;
  const [s] = await db<Season[]>`SELECT id, slug, name, starts_at, ends_at, public, computed_at FROM bb_seasons WHERE starts_at <= now() ORDER BY starts_at DESC LIMIT 1`;
  return s ?? null;
}

export function seasonEnded(s: Pick<Season, "ends_at">, now = Date.now()): boolean {
  return new Date(s.ends_at).getTime() <= now;
}

/** The final standings are fixed once a compute has run after the season's end. */
function isFinal(s: Season): boolean {
  return Boolean(s.computed_at && seasonEnded(s) && new Date(s.computed_at).getTime() > new Date(s.ends_at).getTime());
}

// ── compute ──────────────────────────────────────────────────────────────────
type LaunchRowRaw = { chain_id: number; token: string; launcher: string; recipients: { payout: string; bps: number }[]; block_number: bigint; block_time: string; lp_fee: number; quote: string; sqrt_price_x96: string | null };

export type ComputeResult = { wallets: number; eligible: number; ms: number } | { skipped: string };

/** `read` runs the season's reads one after another (a reserved connection); `write` (the pool) runs the replace. */
export async function computeSeason(read: Db, write: Db, season: Season): Promise<ComputeResult> {
  const t0 = Date.now();
  const start = new Date(season.starts_at).getTime();
  const end = new Date(season.ends_at).getTime();
  const now = Date.now();
  const until = new Date(Math.min(now, end)).toISOString();

  // prices first: a run without a complete price picture writes nothing (the last board stays)
  const usd = await ethUsd();
  if (usd === null) return { skipped: "no ETH price" };
  const price = await quotePricer(usd);

  // the season's swaps decide which tokens are in scope
  const swapRows = await read<{ chain_id: number; token: string; trader: string; is_buy: boolean; amount0: string; amount1: string; block_number: bigint; log_index: number; t: string }[]>`
    SELECT chain_id, token, trader, is_buy, amount0, amount1, block_number, log_index, block_time AS t
      FROM bb_launch_swaps WHERE block_time >= ${season.starts_at} AND block_time < ${until} AND trader IS NOT NULL`;
  const keyOf = (cid: number, token: string) => `${chainKeyOf(cid) ?? cid}:${token}`;
  const scope = new Map<string, { cid: number; token: string }>();
  for (const s of swapRows) scope.set(keyOf(s.chain_id, s.token), { cid: s.chain_id, token: s.token });
  const cids = [...scope.values()].map((x) => x.cid);
  const toks = [...scope.values()].map((x) => x.token);

  const launchRows = await read<LaunchRowRaw[]>`
    SELECT l.chain_id, l.token, l.launcher, l.recipients, l.block_number, l.block_time, l.lp_fee, l.quote, l.sqrt_price_x96
      FROM bb_launches l JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON l.chain_id = u.cid AND l.token = u.tok`;
  const launches: ScoreLaunch[] = [];
  for (const l of launchRows) {
    const chain = chainKeyOf(l.chain_id) as ChainKey;
    const q = price(chain, l.quote);
    // a listed quote (ETH, TWIG, GITLAWB, USDG, a stock…) without a price right now = an outage: keep the last board
    if (q.usd === null && q.key !== "other") return { skipped: `no price for ${q.key}` };
    const perToken = l.sqrt_price_x96 ? quotePerToken(BigInt(l.sqrt_price_x96), q.decimals) : 0;
    launches.push({
      key: keyOf(l.chain_id, l.token),
      launcher: l.launcher,
      recipients: (Array.isArray(l.recipients) ? l.recipients : []).map((r) => String(r.payout).toLowerCase()),
      launchBlock: Number(l.block_number),
      launchTime: new Date(l.block_time).getTime(),
      lpFee: Number(l.lp_fee),
      quoteDecimals: q.decimals,
      quoteUsd: q.usd,
      tokenUsd: q.usd === null || !perToken ? null : perToken * q.usd,
    });
  }

  const firstRows = await read<{ chain_id: number; token: string; trader: string; block_number: bigint; log_index: number; t: string; amount0: string; amount1: string }[]>`
    SELECT DISTINCT ON (s.chain_id, s.token, s.trader) s.chain_id, s.token, s.trader, s.block_number, s.log_index, s.block_time AS t, s.amount0, s.amount1
      FROM bb_launch_swaps s JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON s.chain_id = u.cid AND s.token = u.tok
     WHERE s.is_buy AND s.trader IS NOT NULL ORDER BY s.chain_id, s.token, s.trader, s.block_number, s.log_index`;
  // balances of wallets that ever bought the token (airdrop / dust recipients never matter to any rule)
  const holderRows = await read<{ chain_id: number; token: string; holder: string; balance: string }[]>`
    SELECT h.chain_id, h.token, h.holder, h.balance
      FROM bb_token_holders h JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON h.chain_id = u.cid AND h.token = u.tok
     WHERE h.balance > 0
       AND EXISTS (SELECT 1 FROM bb_launch_swaps s WHERE s.trader = h.holder AND s.chain_id = h.chain_id AND s.token = h.token AND s.is_buy)`;
  const boughtRows = await read<{ chain_id: number; token: string; bought: string }[]>`
    SELECT s.chain_id, s.token, sum(s.amount1)::text AS bought
      FROM bb_launch_swaps s JOIN bb_launches l ON l.chain_id = s.chain_id AND l.token = s.token
      JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON s.chain_id = u.cid AND s.token = u.tok
     WHERE s.is_buy AND s.trader = l.launcher GROUP BY s.chain_id, s.token`;
  const linkedRows = await read<{ chain_id: number; token: string; to_addr: string }[]>`
    SELECT DISTINCT t.chain_id, t.token, t.to_addr
      FROM bb_token_transfers t JOIN bb_launches l ON l.chain_id = t.chain_id AND l.token = t.token
      JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON t.chain_id = u.cid AND t.token = u.tok
     WHERE t.from_addr = l.launcher OR t.from_addr IN (SELECT lower(r->>'payout') FROM jsonb_array_elements(l.recipients) r)`;
  // every profile, deleted ones too: a flag must survive deleting the profile
  const profileRows = await read<{ wallet: string; x_status: string; x_account_created: string | null; x_followers: number | null; points_flag: string | null; hidden: boolean; deleted_at: string | null }[]>`
    SELECT wallet, x_status, x_account_created, x_followers, points_flag, hidden, deleted_at FROM bb_profiles`;

  const abs = (v: string) => (v.startsWith("-") ? BigInt(v.slice(1)) : BigInt(v));
  const int = (v: string) => abs(v.split(".")[0]);
  const swaps: ScoreSwap[] = swapRows.map((s) => ({ key: keyOf(s.chain_id, s.token), trader: s.trader, isBuy: s.is_buy, quoteRaw: abs(s.amount0), tokenRaw: abs(s.amount1), block: Number(s.block_number), logIndex: Number(s.log_index), time: new Date(s.t).getTime() }));
  const firstBuys: FirstBuy[] = firstRows.map((f) => ({ key: keyOf(f.chain_id, f.token), wallet: f.trader, block: Number(f.block_number), logIndex: Number(f.log_index), time: new Date(f.t).getTime(), quoteRaw: abs(f.amount0), tokenRaw: abs(f.amount1) }));
  const linked = new Map<string, Set<string>>();
  for (const r of linkedRows) {
    const k = keyOf(r.chain_id, r.token);
    const set = linked.get(k) ?? new Set<string>();
    set.add(r.to_addr);
    linked.set(k, set);
  }
  const eligible = new Set(profileRows.filter((p) => isEligible(p, now)).map((p) => p.wallet));
  const flagged = new Set(profileRows.filter((p) => p.points_flag).map((p) => p.wallet));
  const system = new Set<string>([ZERO_ADDR, DEAD_ADDR]);
  for (const c of CHAIN_KEYS) {
    try {
      for (const a of systemAddresses(c)) system.add(a);
    } catch {
      /* a chain without a deployment */
    }
  }

  const result = scoreSeason({
    seasonStart: start,
    seasonEnd: end,
    now,
    launches,
    swaps,
    firstBuys,
    holders: holderRows.map((h) => ({ key: keyOf(h.chain_id, h.token), wallet: h.holder, balanceRaw: int(h.balance) })),
    launcherBought: new Map(boughtRows.map((b) => [keyOf(b.chain_id, b.token), int(b.bought)])),
    linked,
    system,
    eligible,
    flagged,
  });

  const scores = [...result.wallets.values()];
  const rc = rankBy(scores, "creator", eligible);
  const rs = rankBy(scores, "scout", eligible);
  const rows = scores.map((s) => ({
    wallet: s.wallet,
    creator: s.creator,
    scout: s.scout,
    total: s.total,
    eligible: eligible.has(s.wallet),
    rank_creator: rc.get(s.wallet) ?? null,
    rank_scout: rs.get(s.wallet) ?? null,
    breakdown: { creator: s.creatorWhy, scout: s.scoutWhy },
  }));

  await write.begin(async (tx) => {
    const t = tx as unknown as Db;
    await t`DELETE FROM bb_points WHERE season_id = ${season.id}`;
    for (let i = 0; i < rows.length; i += 1000) {
      const part = rows.slice(i, i + 1000);
      await t`
        INSERT INTO bb_points (season_id, wallet, creator, scout, total, eligible, rank_creator, rank_scout, breakdown, computed_at)
        SELECT ${season.id}, u.w, u.c, u.s, u.tot, u.e = 't', NULLIF(u.rc, '')::int, NULLIF(u.rs, '')::int, u.b::jsonb, now()
          FROM unnest(${part.map((r) => r.wallet)}::text[], ${part.map((r) => r.creator)}::int[], ${part.map((r) => r.scout)}::int[], ${part.map((r) => r.total)}::int[],
                      ${part.map((r) => (r.eligible ? "t" : "f"))}::text[], ${part.map((r) => String(r.rank_creator ?? ""))}::text[], ${part.map((r) => String(r.rank_scout ?? ""))}::text[],
                      ${part.map((r) => JSON.stringify(r.breakdown))}::text[])
               AS u(w, c, s, tot, e, rc, rs, b)`; // booleans and nullable ints travel as text: the driver does not type those arrays
    }
    await t`UPDATE bb_seasons SET computed_at = now() WHERE id = ${season.id}`;
  });
  return { wallets: rows.length, eligible: rows.filter((r) => r.eligible).length, ms: Date.now() - t0 };
}

let running = false;
let lastCheck = 0;
const EVERY_MS = 60 * 60_000;

/** Compute one season under the cross-machine lock (reads on the reserved connection, the replace on the pool). */
async function computeLocked(season: Season): Promise<ComputeResult | null> {
  const pool = maybeDb();
  if (!pool) return null;
  const reserved = await pool.reserve();
  const db = reserved as unknown as Db;
  try {
    const [{ ok }] = await db<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('points-compute')) AS ok`;
    if (!ok) return null;
    try {
      const r = await computeSeason(db, pool, season);
      console.log(`[points] ${season.slug}:`, "skipped" in r ? `skipped (${r.skipped}), last board kept` : `${r.wallets} wallets (${r.eligible} eligible) in ${r.ms}ms`);
      return r;
    } finally {
      await db`SELECT pg_advisory_unlock(hashtext('points-compute'))`.catch(() => {});
    }
  } finally {
    reserved.release();
  }
}

/**
 * The hourly run, from the sync loop: at most hourly per season (bb_seasons.computed_at, so a season with no points
 * yet does not recompute every few minutes), one machine at a time, never while a run is in progress on this machine.
 * An ended season gets exactly one compute after its end, which becomes its final standings.
 */
export async function computePointsIfDue(): Promise<ComputeResult | null> {
  if (running || Date.now() - lastCheck < 5 * 60_000) return null;
  lastCheck = Date.now();
  running = true;
  try {
    const season = await currentSeason();
    if (!season || isFinal(season)) return null;
    if (season.computed_at && Date.now() - new Date(season.computed_at).getTime() < EVERY_MS && !seasonEnded(season)) return null;
    return await computeLocked(season);
  } finally {
    running = false;
  }
}

/** Admin "recompute now": refused once a season's final standings exist. */
export async function recomputeNow(): Promise<ComputeResult | { error: string } | null> {
  const season = await currentSeason();
  if (!season) return { error: "no season" };
  if (isFinal(season)) return { error: `${season.name} has ended; its final standings stay as they are` };
  return computeLocked(season);
}

// ── read ─────────────────────────────────────────────────────────────────────
type PointsRaw = { wallet: string; creator: number; scout: number; total: number; eligible: boolean; rank_creator: number | null; rank_scout: number | null; breakdown: { creator: CreatorBreakdown; scout: ScoutBreakdown }; computed_at: string };

export async function boardRows(seasonId: number, board: Board, limit = 100): Promise<{ rows: BoardRow[]; names: Record<string, NameEntry> }> {
  const db = maybeDb();
  if (!db) return { rows: [], names: {} };
  const n = Math.min(200, Math.max(1, limit));
  const raw =
    board === "creator"
      ? await db<PointsRaw[]>`SELECT wallet, creator, scout, total, eligible, rank_creator, rank_scout, breakdown, computed_at FROM bb_points WHERE season_id = ${seasonId} AND rank_creator IS NOT NULL ORDER BY rank_creator, wallet LIMIT ${n}`
      : await db<PointsRaw[]>`SELECT wallet, creator, scout, total, eligible, rank_creator, rank_scout, breakdown, computed_at FROM bb_points WHERE season_id = ${seasonId} AND rank_scout IS NOT NULL ORDER BY rank_scout, wallet LIMIT ${n}`;
  const rows = raw.map((r) => ({ rank: (board === "creator" ? r.rank_creator : r.rank_scout) ?? 0, wallet: r.wallet, points: board === "creator" ? r.creator : r.scout, why: whyLine(board, { creatorWhy: r.breakdown.creator, scoutWhy: r.breakdown.scout }) }));
  return { rows, names: await namesFor(rows.map((r) => r.wallet)) };
}

export async function walletPoints(seasonId: number, wallet: string): Promise<WalletPoints | null> {
  const db = maybeDb();
  if (!db || !isAddress(wallet)) return null;
  const [r] = await db<PointsRaw[]>`SELECT wallet, creator, scout, total, eligible, rank_creator, rank_scout, breakdown, computed_at FROM bb_points WHERE season_id = ${seasonId} AND wallet = ${wallet.toLowerCase()}`;
  if (!r) return null;
  const why = { creatorWhy: r.breakdown.creator, scoutWhy: r.breakdown.scout };
  return { creator: r.creator, scout: r.scout, total: r.total, eligible: r.eligible, rank_creator: r.rank_creator, rank_scout: r.rank_scout, why_creator: whyLine("creator", why), why_scout: whyLine("scout", why), computed_at: r.computed_at };
}

/** What stands between a wallet and the board right now (null = nothing: it is eligible). */
export async function walletReason(wallet: string): Promise<NotEligibleReason | null> {
  const db = maybeDb();
  if (!db || !isAddress(wallet)) return "no_profile";
  const [p] = await db<{ x_status: string; x_account_created: string | null; x_followers: number | null; points_flag: string | null; hidden: boolean; deleted_at: string | null }[]>`
    SELECT x_status, x_account_created, x_followers, points_flag, hidden, deleted_at FROM bb_profiles WHERE wallet = ${wallet.toLowerCase()}`;
  return notEligibleReason(p ?? null, Date.now());
}

// ── admin ────────────────────────────────────────────────────────────────────
export async function startSeason(days = 28): Promise<Season> {
  const db = maybeDb()!;
  const [{ n }] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM bb_seasons`;
  const [s] = await db<Season[]>`
    INSERT INTO bb_seasons (slug, name, starts_at, ends_at, public) VALUES (${`s${n + 1}`}, ${`Season ${n + 1}`}, now(), now() + make_interval(days => ${days}), false)
    RETURNING id, slug, name, starts_at, ends_at, public, computed_at`;
  return s;
}

/**
 * Publishing starts the season for everyone: its clock restarts now with the same length, and the shadow run's points
 * are dropped (they were for tuning). Hiding again keeps the clock.
 */
export async function publishSeason(id: number): Promise<void> {
  const db = maybeDb()!;
  await db.begin(async (tx) => {
    const t = tx as unknown as Db;
    await t`UPDATE bb_seasons SET public = true, ends_at = now() + (ends_at - starts_at), starts_at = now(), computed_at = NULL WHERE id = ${id} AND NOT public`;
    await t`DELETE FROM bb_points WHERE season_id = ${id}`;
  });
}

export async function hideSeason(id: number): Promise<void> {
  const db = maybeDb()!;
  await db`UPDATE bb_seasons SET public = false WHERE id = ${id}`;
}

export async function endSeasonNow(id: number): Promise<void> {
  const db = maybeDb()!;
  await db`UPDATE bb_seasons SET ends_at = LEAST(ends_at, now()) WHERE id = ${id}`;
}

/** The final standings of an ended season, before another one starts (so starting never skips them). */
export async function finalizeIfEnded(season: Season): Promise<void> {
  if (seasonEnded(season) && !isFinal(season)) await computeLocked(season);
}

/** The shadow view for admins: top wallets on each board, eligible or not, with why lines (the trial-week review). */
export async function previewBoards(seasonId: number, limit = 50): Promise<{ creator: (BoardRow & { eligible: boolean })[]; scout: (BoardRow & { eligible: boolean })[]; names: Record<string, NameEntry>; computed_at: string | null; wallets: number; eligible: number }> {
  const db = maybeDb();
  if (!db) return { creator: [], scout: [], names: {}, computed_at: null, wallets: 0, eligible: 0 };
  const [c, s, [meta]] = await Promise.all([
    db<PointsRaw[]>`SELECT wallet, creator, scout, total, eligible, rank_creator, rank_scout, breakdown, computed_at FROM bb_points WHERE season_id = ${seasonId} AND creator > 0 ORDER BY creator DESC, wallet LIMIT ${limit}`,
    db<PointsRaw[]>`SELECT wallet, creator, scout, total, eligible, rank_creator, rank_scout, breakdown, computed_at FROM bb_points WHERE season_id = ${seasonId} AND scout > 0 ORDER BY scout DESC, wallet LIMIT ${limit}`,
    db<{ at: string | null; n: number; e: number }[]>`SELECT (SELECT computed_at FROM bb_seasons WHERE id = ${seasonId}) AS at, count(*)::int AS n, count(*) FILTER (WHERE eligible)::int AS e FROM bb_points WHERE season_id = ${seasonId}`,
  ]);
  const row = (board: Board) => (r: PointsRaw, i: number) => ({ rank: i + 1, wallet: r.wallet, points: board === "creator" ? r.creator : r.scout, eligible: r.eligible, why: whyLine(board, { creatorWhy: r.breakdown.creator, scoutWhy: r.breakdown.scout }) });
  const creator = c.map(row("creator"));
  const scout = s.map(row("scout"));
  return { creator, scout, names: await namesFor([...creator, ...scout].map((r) => r.wallet)), computed_at: meta?.at ?? null, wallets: meta?.n ?? 0, eligible: meta?.e ?? 0 };
}
