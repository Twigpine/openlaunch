import "server-only";
import { isAddress } from "viem";
import { publicClient } from "@/lib/chain";
import { CHAIN_KEYS, chainKeyOf, chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { CONFIGURED_CHAINS } from "@/lib/launchpad/config";
import { maybeDb, type Db } from "@/lib/db";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { DEAD_ADDR, ZERO_ADDR } from "@/lib/launchpad/holders";
import { launchDeployBlock, systemAddresses } from "@/lib/launchpad/indexer";
import { quotePerToken } from "@/lib/launchpad/math";
import { quotePricer } from "@/lib/launchpad/queries";
import { lastBlockBetween } from "./blocks";
import { namesFor, type NameEntry } from "@/lib/profiles/server";
import { isEligible, notEligibleReason, rankBy, scoreSeason, whyLine, type CreatorBreakdown, type FirstBuy, type PublicReason, type ScoreLaunch, type ScoreSwap, type ScoutBreakdown } from "./score";

/**
 * Season points, the server half: load one season's chain data, score it (score.ts), replace the season's rows.
 * Runs hourly from the sync loop (fire-and-forget, so indexing never waits for it) on ONE machine (session advisory
 * lock on a reserved connection, which also runs the reads one after another so the request pool stays free), and on
 * demand from /admin. Everything is recomputed from scratch, so a rule change or an admin flag applies to the whole
 * season on the next run.
 *
 * Prices: without ETH, GITLAWB or TWIG a run writes nothing (the last board stays). Another quote that normally has a
 * price (MUSEWORLD, a stock) but has none right now only takes its own tokens out of an hourly run, which the next run
 * puts back; a run that would fix the FINAL standings writes nothing instead (for up to a day), so a price blip can
 * never drop tokens from them for good. Tokens quoted in an unlisted pair never count (they have no price to hold
 * anything to).
 *
 * Final standings are fixed only by a compute that read everything through the season's end: the clock passing the
 * end is not enough, every indexer must have read past it too (computed_until is capped at the least of their
 * cursors), the season's swaps must be attributed (at most an hour's wait), and every read stops at the season's last
 * block, so a late final compute sees the season as it ended. Until then an ended season is not recomputed at all.
 */

export type Season = { id: number; slug: string; name: string; starts_at: string; ends_at: string; public: boolean; computed_at: string | null; computed_until: string | null; published_at: string | null };
export type Board = "creator" | "scout";
export type BoardRow = { rank: number; wallet: string; points: number; why: string };
export type WalletPoints = { creator: number; scout: number; total: number; eligible: boolean; rank_creator: number | null; rank_scout: number | null; why_creator: string; why_scout: string; computed_at: string };

/** The current season: the latest one that has started, public or not (the admin's and the compute's season). */
export async function currentSeason(): Promise<Season | null> {
  const db = maybeDb();
  if (!db) return null;
  const [s] = await db<Season[]>`SELECT id, slug, name, starts_at, ends_at, public, computed_at, computed_until, published_at FROM bb_seasons WHERE starts_at <= now() ORDER BY starts_at DESC LIMIT 1`;
  return s ?? null;
}

/** The season everyone sees: the latest public one (an ended one keeps showing its final standings while the next is in its shadow run). */
export async function publicSeason(): Promise<Season | null> {
  const db = maybeDb();
  if (!db) return null;
  const [s] = await db<Season[]>`SELECT id, slug, name, starts_at, ends_at, public, computed_at, computed_until, published_at FROM bb_seasons WHERE public AND starts_at <= now() ORDER BY starts_at DESC LIMIT 1`;
  return s ?? null;
}

/** Whether a season's end has passed. */
export function seasonEnded(s: Pick<Season, "ends_at">, now = Date.now()): boolean {
  return new Date(s.ends_at).getTime() <= now;
}

/**
 * Whether a season's final standings are in: a compute covered its end, the indexers' progress included (the clock
 * passing the end is not enough). After that the hourly and admin recomputes leave the season as it is.
 */
export function seasonFinal(s: Pick<Season, "computed_until" | "ends_at">): boolean {
  return Boolean(s.computed_until && new Date(s.computed_until).getTime() >= new Date(s.ends_at).getTime());
}

// ── compute ──────────────────────────────────────────────────────────────────
type LaunchRowRaw = { chain_id: number; token: string; launcher: string; recipients: { payout: string; bps: number }[]; block_number: bigint; block_time: string; lp_fee: number; quote: string; sqrt_price_x96: string | null };

export type ComputeResult = { wallets: number; eligible: number; ms: number } | { skipped: string };

/** The chains the indexer reads (configured, with a deploy block): the ones a season's data comes from. */
const indexedChains = () => CONFIGURED_CHAINS.filter((c) => launchDeployBlock(c) > 0n);

/**
 * The time every indexer has read through: the least of their cursor blocks' timestamps (ms), or null when one cannot
 * be told (no cursor yet, a node that does not answer). Final standings wait for it to pass the season's end.
 */
async function indexedThrough(read: Db): Promise<number | null> {
  const rows = await read<{ chain_id: number; cursor_block: bigint }[]>`SELECT chain_id, cursor_block FROM bb_launch_sync_cursor`;
  let least = Infinity;
  for (const c of indexedChains()) {
    const row = rows.find((r) => r.chain_id === chainIdOf(c));
    if (!row || BigInt(row.cursor_block) <= 0n) return null;
    try {
      const b = await publicClient(c).getBlock({ blockNumber: BigInt(row.cursor_block) });
      least = Math.min(least, Number(b.timestamp) * 1000);
    } catch {
      return null;
    }
  }
  return Number.isFinite(least) ? least : null;
}

const lastBlockCache = new Map<string, bigint>();
/**
 * The last block on a chain whose time is before `ms` (transfers carry blocks, not times). Bracketed by the indexed
 * swaps on either side of `ms` (checked against the node), then searched on block timestamps (lastBlockBetween: a
 * few reads, not one per halving). Cached, as the past does not move. Throws when the node does not answer (the run
 * is skipped and tried again).
 */
async function lastBlockBefore(read: Db, chain: ChainKey, ms: number): Promise<bigint> {
  const k = `${chain}:${ms}`;
  const hit = lastBlockCache.get(k);
  if (hit !== undefined) return hit;
  const at = new Date(ms).toISOString();
  const cid = chainIdOf(chain);
  const client = publicClient(chain);
  const timeOf = async (b: bigint) => Number((await client.getBlock({ blockNumber: b })).timestamp) * 1000;
  const keep = (b: bigint) => {
    if (lastBlockCache.size > 2_000) lastBlockCache.clear();
    lastBlockCache.set(k, b);
    return b;
  };
  const [r] = await read<{ lo: bigint | null; hi: bigint | null }[]>`
    SELECT (SELECT max(block_number) FROM bb_launch_swaps WHERE chain_id = ${cid} AND block_time < ${at}) AS lo,
           (SELECT min(block_number) FROM bb_launch_swaps WHERE chain_id = ${cid} AND block_time >= ${at}) AS hi`;
  // lo: a block before `ms` (the launchpad's deploy block when no swap says better)
  const deploy = launchDeployBlock(chain);
  let lo = r?.lo != null ? BigInt(r.lo) : deploy;
  let tLo = await timeOf(lo);
  if (tLo >= ms && lo !== deploy) [lo, tLo] = [deploy, await timeOf(deploy)];
  if (tLo >= ms) return keep(deploy > 0n ? deploy - 1n : 0n); // nothing of the launchpad is before `ms`
  // hi: a block at or after `ms` (the head when no swap says better)
  let hi = r?.hi != null ? BigInt(r.hi) : await client.getBlockNumber();
  let tHi = await timeOf(hi);
  if (tHi < ms) {
    const head = await client.getBlockNumber();
    if (head !== hi) [hi, tHi] = [head, await timeOf(head)];
    if (tHi < ms) return hi; // the chain has not reached `ms` yet: its head, not cached (it moves)
  }
  return keep(await lastBlockBetween(lo, tLo, hi, tHi, ms, timeOf));
}

/** How long past its end a season's final count waits for swaps still being attributed. */
const SETTLE_WAIT_MS = 60 * 60_000;
/** How long past its end it waits for a normally-priced quote's price (a feed gone for good then drops its tokens). */
const PRICE_WAIT_MS = 24 * 60 * 60_000;
/** Whether any swap in [from, to) is still being attributed (unchecked, or its EntryPoint receipt not read yet). */
async function unattributedIn(read: Db, from: string, to: string): Promise<boolean> {
  const [r] = await read<{ open: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM bb_launch_swaps WHERE (trader_via IS NULL OR trader_via = 'receipt_pending') AND block_time >= ${from} AND block_time < ${to}) AS open`;
  return Boolean(r?.open);
}

/** `read` runs the season's reads one after another (a reserved connection); `write` (the pool) runs the replace. */
export async function computeSeason(read: Db, write: Db, season: Season): Promise<ComputeResult> {
  const t0 = Date.now();
  const start = new Date(season.starts_at).getTime();
  const end = new Date(season.ends_at).getTime();
  const now = Date.now();
  const dataUntil = Math.min(now, end);
  const until = new Date(dataUntil).toISOString();
  // how far this run can vouch for the data: the clock, and every indexer's progress. Only a run covering the end
  // makes the final standings (the hourly and admin recomputes stop after that)
  const indexed = await indexedThrough(read);
  const covered = indexed === null ? Math.min(dataUntil, end - 1) : Math.min(dataUntil, indexed);
  // a smart-wallet buy is credited to the bundler until its receipt is read (then it is no real buy): the final count
  // waits for the season's swaps still being attributed, at most an hour past the end (a receipt that never comes is
  // settled on its sender by then anyway)
  const unsettled = covered >= end && now < end + SETTLE_WAIT_MS && (await unattributedIn(read, season.starts_at, season.ends_at));
  const finalRun = covered >= end && !unsettled;
  // once the season is over, a run that cannot be final would only redo the whole compute for the same board: wait
  if (now >= end && !finalRun) return { skipped: unsettled ? "waiting for the season's last swaps to be attributed" : "waiting for every indexer to read past the season's end" };

  // per chain: the season's first block (a creator's in-season outflows), and once it has ended its last one, so
  // transfers after the end (blocks, not times) are never read as the season's
  const chains = indexedChains();
  const seasonStartBlocks = new Map<string, number>();
  const endBlock = new Map<number, bigint>();
  for (const c of chains) {
    try {
      seasonStartBlocks.set(c, Number((await lastBlockBefore(read, c, start)) + 1n));
      endBlock.set(chainIdOf(c), dataUntil < now ? await lastBlockBefore(read, c, end) : 2n ** 62n);
    } catch (err) {
      console.warn(`[points] ${c} block range:`, err instanceof Error ? err.message.split("\n")[0] : err);
      return { skipped: `the ${c} node did not answer for the season's block range` };
    }
  }
  const boundCids = [...endBlock.keys()];
  const boundBlocks = boundCids.map((c) => endBlock.get(c)!.toString());

  // prices first: without ETH nothing is priced (the last board stays). One snapshot for the whole run: a page
  // refresh changing a price in the middle of the reads must not change the run
  const usd = await ethUsd();
  if (usd === null) return { skipped: "no ETH price" };
  const price = await quotePricer(usd);

  // the season's swaps decide which tokens are in scope
  const swapRows = await read<{ chain_id: number; token: string; trader: string; is_buy: boolean; amount0: string; amount1: string; block_number: bigint; log_index: number; tx_hash: string; t: string }[]>`
    SELECT chain_id, token, trader, is_buy, amount0, amount1, block_number, log_index, tx_hash, block_time AS t
      FROM bb_launch_swaps WHERE block_time >= ${season.starts_at} AND block_time < ${until} AND trader IS NOT NULL`;
  const keyOf = (cid: number, token: string) => `${chainKeyOf(cid) ?? cid}:${token}`;
  const scope = new Map<string, { cid: number; token: string }>();
  for (const s of swapRows) scope.set(keyOf(s.chain_id, s.token), { cid: s.chain_id, token: s.token });
  const cids = [...scope.values()].map((x) => x.cid);
  const toks = [...scope.values()].map((x) => x.token);

  // ETH, GITLAWB and TWIG price most of the board: without them the run would be wrong everywhere, so it writes
  // nothing. Another quote that normally has a price but has none now (MUSEWORLD, a stock) takes its own tokens out
  // of an hourly run (the next run puts them back); the final run waits for it instead (up to a day: a feed gone for
  // good then drops its tokens, logged).
  // An unlisted pair has no price to begin with: never scored.
  const MAIN_QUOTES = new Set(["eth", "gitlawb", "twig"]);
  let dropped = 0;
  const launchRows = await read<LaunchRowRaw[]>`
    SELECT l.chain_id, l.token, l.launcher, l.recipients, l.block_number, l.block_time, l.lp_fee, l.quote, l.sqrt_price_x96
      FROM bb_launches l JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON l.chain_id = u.cid AND l.token = u.tok`;
  const launches: ScoreLaunch[] = [];
  for (const l of launchRows) {
    const chain = chainKeyOf(l.chain_id) as ChainKey;
    const q = price(chain, l.quote);
    if (q.usd === null && MAIN_QUOTES.has(q.key)) return { skipped: `no price for ${q.key}` };
    if (q.usd === null && q.key !== "other" && finalRun && now < end + PRICE_WAIT_MS) return { skipped: `no price for ${q.key} right now; the final standings wait for it` };
    if (q.usd === null) {
      dropped++;
      continue;
    }
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

  const firstRows = await read<{ chain_id: number; token: string; trader: string; block_number: bigint; log_index: number; tx_hash: string; t: string; amount0: string; amount1: string }[]>`
    SELECT DISTINCT ON (s.chain_id, s.token, s.trader) s.chain_id, s.token, s.trader, s.block_number, s.log_index, s.tx_hash, s.block_time AS t, s.amount0, s.amount1
      FROM bb_launch_swaps s JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON s.chain_id = u.cid AND s.token = u.tok
     WHERE s.is_buy AND s.trader IS NOT NULL AND s.block_time < ${until} ORDER BY s.chain_id, s.token, s.trader, s.block_number, s.log_index`; // buys after the end are not the season's
  // every balance change of every buyer (and launcher) of the tokens in scope: holding is judged on the lowest balance
  // since a buy, so tokens topped up later by transfer, or $5 passed from wallet to wallet, never count
  const pairs = new Map<string, { cid: number; tok: string; w: string }>();
  for (const f of firstRows) pairs.set(`${f.chain_id}|${f.token}|${f.trader}`, { cid: f.chain_id, tok: f.token, w: f.trader });
  for (const l of launchRows) pairs.set(`${l.chain_id}|${l.token}|${l.launcher}`, { cid: l.chain_id, tok: l.token, w: l.launcher });
  const pv = [...pairs.values()];
  const moveRows = await read<{ chain_id: number; token: string; wallet: string; block_number: bigint; log_index: number; tx_hash: string; delta: string; burn: boolean }[]>`
    WITH p AS (SELECT * FROM unnest(${pv.map((x) => x.cid)}::int[], ${pv.map((x) => x.tok)}::text[], ${pv.map((x) => x.w)}::text[]) AS p(cid, tok, w)),
         e AS (SELECT * FROM unnest(${boundCids}::int[], ${boundBlocks}::bigint[]) AS e(cid, eb))
    SELECT t.chain_id, t.token, p.w AS wallet, t.block_number, t.log_index, t.tx_hash, t.value::text AS delta, false AS burn
      FROM bb_token_transfers t JOIN p ON t.chain_id = p.cid AND t.token = p.tok AND t.to_addr = p.w JOIN e ON e.cid = t.chain_id AND t.block_number <= e.eb
    UNION ALL
    SELECT t.chain_id, t.token, p.w AS wallet, t.block_number, t.log_index, t.tx_hash, (-t.value)::text AS delta, t.to_addr IN (${ZERO_ADDR}, ${DEAD_ADDR}) AS burn
      FROM bb_token_transfers t JOIN p ON t.chain_id = p.cid AND t.token = p.tok AND t.from_addr = p.w JOIN e ON e.cid = t.chain_id AND t.block_number <= e.eb`; // holdings as the season ended
  const launcherBuyRows = await read<{ chain_id: number; token: string; tx_hash: string; amount1: string }[]>`
    SELECT s.chain_id, s.token, s.tx_hash, s.amount1
      FROM bb_launch_swaps s JOIN bb_launches l ON l.chain_id = s.chain_id AND l.token = s.token
      JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON s.chain_id = u.cid AND s.token = u.tok
     WHERE s.is_buy AND s.trader = l.launcher AND s.block_time < ${until}`;
  const linkedRows = await read<{ chain_id: number; token: string; to_addr: string }[]>`
    SELECT DISTINCT t.chain_id, t.token, t.to_addr
      FROM bb_token_transfers t JOIN bb_launches l ON l.chain_id = t.chain_id AND l.token = t.token
      JOIN unnest(${cids}::int[], ${toks}::text[]) AS u(cid, tok) ON t.chain_id = u.cid AND t.token = u.tok
      JOIN unnest(${boundCids}::int[], ${boundBlocks}::bigint[]) AS e(cid, eb) ON e.cid = t.chain_id AND t.block_number <= e.eb
     WHERE t.from_addr = l.launcher OR t.from_addr IN (SELECT lower(r->>'payout') FROM jsonb_array_elements(l.recipients) r)`;
  // every profile, deleted ones too: a flag must survive deleting the profile
  const profileRows = await read<{ wallet: string; x_status: string; x_account_created: string | null; x_followers: number | null; points_flag: string | null; hidden: boolean; deleted_at: string | null }[]>`
    SELECT wallet, x_status, x_account_created, x_followers, points_flag, hidden, deleted_at FROM bb_profiles`;

  const abs = (v: string) => (v.startsWith("-") ? BigInt(v.slice(1)) : BigInt(v));
  const int = (v: string) => abs(v.split(".")[0]);
  const swaps: ScoreSwap[] = swapRows.map((s) => ({ key: keyOf(s.chain_id, s.token), trader: s.trader, isBuy: s.is_buy, quoteRaw: abs(s.amount0), tokenRaw: abs(s.amount1), block: Number(s.block_number), logIndex: Number(s.log_index), time: new Date(s.t).getTime(), tx: s.tx_hash }));
  const firstBuys: FirstBuy[] = firstRows.map((f) => ({ key: keyOf(f.chain_id, f.token), wallet: f.trader, block: Number(f.block_number), logIndex: Number(f.log_index), time: new Date(f.t).getTime(), quoteRaw: abs(f.amount0), tokenRaw: abs(f.amount1), tx: f.tx_hash }));
  const launcherBuys = new Map<string, { tx: string; tokenRaw: bigint }[]>();
  for (const b of launcherBuyRows) {
    const k = keyOf(b.chain_id, b.token);
    launcherBuys.set(k, [...(launcherBuys.get(k) ?? []), { tx: b.tx_hash, tokenRaw: abs(b.amount1) }]);
  }
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
    moves: moveRows.map((m) => ({ key: keyOf(m.chain_id, m.token), wallet: m.wallet, block: Number(m.block_number), logIndex: Number(m.log_index), tx: m.tx_hash, delta: m.delta.startsWith("-") ? -int(m.delta) : int(m.delta), burn: m.burn })),
    launcherBuys,
    linked,
    system,
    eligible,
    flagged,
    seasonStartBlocks,
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

  const wrote = await write.begin(async (tx) => {
    const t = tx as unknown as Db;
    // the season as it is now, locked: a publish (which restarts the clock and drops the shadow rows), an end or a
    // restart that landed while this run was reading means its rows describe a window that no longer exists
    const [cur] = await t<{ starts_at: Date | string; ends_at: Date | string; published_at: Date | string | null }[]>`
      SELECT starts_at, ends_at, published_at FROM bb_seasons WHERE id = ${season.id} FOR UPDATE`;
    const same = (a: Date | string | null | undefined, b: Date | string | null | undefined) => (a == null || b == null ? a == b : new Date(a).getTime() === new Date(b).getTime());
    if (!cur || !same(cur.starts_at, season.starts_at) || !same(cur.ends_at, season.ends_at) || !same(cur.published_at, season.published_at)) return false;
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
    // how far this run vouches for: final only once every indexer has read past the end
    await t`UPDATE bb_seasons SET computed_at = now(), computed_until = ${new Date(covered).toISOString()} WHERE id = ${season.id}`;
    return true;
  });
  if (!wrote) return { skipped: "the season changed while it was being computed (the next run uses the new window)" };
  if (dropped) console.log(`[points] ${season.slug}: ${dropped} token(s) without a price left out of this run`);
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
 * An ended season is checked every few minutes until a run can cover its end (every indexer past it, every price in,
 * its last swaps attributed or an hour gone); only that run computes, its standings are final, and nothing recomputes
 * the season after it.
 */
export async function computePointsIfDue(): Promise<ComputeResult | null> {
  if (running || Date.now() - lastCheck < 5 * 60_000) return null;
  lastCheck = Date.now();
  running = true;
  try {
    const season = await currentSeason();
    if (!season || seasonFinal(season)) return null;
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
  if (seasonFinal(season)) return { error: `${season.name} has ended; its final standings stay as they are` };
  return computeLocked(season);
}

// ── read ─────────────────────────────────────────────────────────────────────
type PointsRaw = { wallet: string; creator: number; scout: number; total: number; eligible: boolean; rank_creator: number | null; rank_scout: number | null; breakdown: { creator: CreatorBreakdown; scout: ScoutBreakdown }; computed_at: string };

/** One board of a season (eligible wallets, by rank) with the names to show. */
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

/** One wallet's points and ranks in a season, or null. */
export async function walletPoints(seasonId: number, wallet: string): Promise<WalletPoints | null> {
  const db = maybeDb();
  if (!db || !isAddress(wallet)) return null;
  const [r] = await db<PointsRaw[]>`SELECT wallet, creator, scout, total, eligible, rank_creator, rank_scout, breakdown, computed_at FROM bb_points WHERE season_id = ${seasonId} AND wallet = ${wallet.toLowerCase()}`;
  if (!r) return null;
  const why = { creatorWhy: r.breakdown.creator, scoutWhy: r.breakdown.scout };
  return { creator: r.creator, scout: r.scout, total: r.total, eligible: r.eligible, rank_creator: r.rank_creator, rank_scout: r.rank_scout, why_creator: whyLine("creator", why), why_scout: whyLine("scout", why), computed_at: r.computed_at };
}

/**
 * What stands between a wallet and the board right now (null = nothing it can do: it is eligible, as far as anyone
 * may be told). Being kept off points is a moderator's call that is never told: the reason is worked out as if it
 * were not there, so a kept-off wallet looks exactly like any other wallet in the same state. (A hidden profile is
 * public already, so "hidden" is told.)
 */
export async function walletReason(wallet: string): Promise<PublicReason | null> {
  const db = maybeDb();
  if (!db || !isAddress(wallet)) return "no_profile";
  const [p] = await db<{ x_status: string; x_account_created: string | null; x_followers: number | null; points_flag: string | null; hidden: boolean; deleted_at: string | null }[]>`
    SELECT x_status, x_account_created, x_followers, points_flag, hidden, deleted_at FROM bb_profiles WHERE wallet = ${wallet.toLowerCase()}`;
  // (a kept-off wallet that is otherwise eligible reads null, as an eligible one does until the next hourly run)
  return notEligibleReason(p ? { ...p, points_flag: null } : null, Date.now()) as PublicReason | null;
}

// ── admin ────────────────────────────────────────────────────────────────────
/**
 * Start a season (hidden: a shadow run until it is published), or null when one is already running. Under a lock,
 * so two starts at once make one season; the slug comes from the row's own id and the number follows the highest
 * season name, so a deleted season never makes the next start collide with a slug or repeat a name.
 */
export async function startSeason(days = 28): Promise<Season | null> {
  const db = maybeDb()!;
  return db.begin(async (tx) => {
    const t = tx as unknown as Db;
    await t`SELECT pg_advisory_xact_lock(hashtext('points-season-start'))`;
    // any season not over blocks (now() is this transaction's start, from before the lock: a start that went
    // through meanwhile can begin a moment after it, so its start time is not compared)
    const [running] = await t`SELECT 1 FROM bb_seasons WHERE ends_at > now() LIMIT 1`;
    if (running) return null;
    const [row] = await t<{ id: number }[]>`
      INSERT INTO bb_seasons (slug, name, starts_at, ends_at, public) VALUES (${`pending-${Date.now()}-${Math.random().toString(36).slice(2)}`}, '', now(), now() + make_interval(days => ${days}), false) RETURNING id`;
    const [s] = await t<Season[]>`
      UPDATE bb_seasons SET slug = 's' || id,
             name = 'Season ' || (1 + COALESCE((SELECT max((regexp_match(name, '^Season ([0-9]+)$'))[1]::int) FROM bb_seasons WHERE id <> ${row.id}), 0))
       WHERE id = ${row.id}
      RETURNING id, slug, name, starts_at, ends_at, public, computed_at, computed_until, published_at`;
    return s;
  }) as Promise<Season | null>;
}

/**
/**
 * Make a season public. The first publish starts its clock now and drops the shadow run's rows ("started"); showing a
 * season again after a hide changes neither ("shown"). A season that never went public and has ended is "refused":
 * its shadow boards were never told to anyone, and they never become public. (The first publish restarts the clock
 * with the same length: the shadow run was for tuning.)
 */
export async function publishSeason(id: number): Promise<"started" | "shown" | "refused"> {
  const db = maybeDb()!;
  return db.begin(async (tx) => {
    const t = tx as unknown as Db;
    const first = await t`
      UPDATE bb_seasons SET public = true, published_at = now(), ends_at = now() + (ends_at - starts_at), starts_at = now(), computed_at = NULL, computed_until = NULL
       WHERE id = ${id} AND published_at IS NULL AND ends_at > now() RETURNING id`;
    if (first.length) {
      await t`DELETE FROM bb_points WHERE season_id = ${id}`;
      return "started" as const;
    }
    const shown = await t`UPDATE bb_seasons SET public = true WHERE id = ${id} AND published_at IS NOT NULL RETURNING id`;
    return shown.length ? ("shown" as const) : ("refused" as const);
  }) as Promise<"started" | "shown" | "refused">;
}

/** Take a season's boards out of public view (its clock and points stay). */
export async function hideSeason(id: number): Promise<void> {
  const db = maybeDb()!;
  await db`UPDATE bb_seasons SET public = false WHERE id = ${id}`;
}

/** End a season now (or keep an earlier end): the final compute follows. */
export async function endSeasonNow(id: number): Promise<void> {
  const db = maybeDb()!;
  await db`UPDATE bb_seasons SET ends_at = LEAST(ends_at, now()) WHERE id = ${id}`;
}

/** The final standings of an ended season, before another one starts (so starting never skips them). True = final. */
export async function finalizeIfEnded(season: Season): Promise<boolean> {
  if (!seasonEnded(season)) return false;
  if (seasonFinal(season)) return true;
  await computeLocked(season);
  const db = maybeDb()!;
  const [s] = await db<Season[]>`SELECT id, slug, name, starts_at, ends_at, public, computed_at, computed_until, published_at FROM bb_seasons WHERE id = ${season.id}`;
  return Boolean(s && seasonFinal(s));
}

/** One season by id, or null. */
export async function seasonById(id: number): Promise<Season | null> {
  const db = maybeDb();
  if (!db) return null;
  const [s] = await db<Season[]>`SELECT id, slug, name, starts_at, ends_at, public, computed_at, computed_until, published_at FROM bb_seasons WHERE id = ${id}`;
  return s ?? null;
}

/** The latest season that went public other than `exceptId` (a public Season 1 while Season 2 runs hidden), or null. */
export async function previousPublishedSeason(exceptId: number): Promise<Season | null> {
  const db = maybeDb();
  if (!db) return null;
  const [s] = await db<Season[]>`
    SELECT id, slug, name, starts_at, ends_at, public, computed_at, computed_until, published_at FROM bb_seasons
     WHERE published_at IS NOT NULL AND id <> ${exceptId} ORDER BY starts_at DESC LIMIT 1`;
  return s ?? null;
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
