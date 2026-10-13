import "server-only";
import { maybeDb } from "@/lib/db";
import { chainIdOf, isChainKey, type ChainKey } from "@/lib/chainPublic";
import { getLaunchesByRefs, type LaunchRow } from "./queries";

export const WATCHLIST_MAX_ITEMS = 50;
export const WATCHLIST_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const WATCHLIST_BODY_MAX_BYTES = 16_384;
const WATCHLIST_CLOCK_SKEW_MS = 5 * 60 * 1_000;

/** All timestamps crossing this API boundary are integer Unix milliseconds. */
export type WatchlistRequestItem = { chain: ChainKey; token: string; since: number | null };
export type WatchlistDataItem = WatchlistRequestItem & {
  launch: LaunchRow | null;
  /** Null until transfer backfill is complete, or when this launch is unavailable. */
  holders: number | null;
  /** Indexed swaps and visible top-level creator posts in (since, at]. Null on a first visit. */
  trades: number | null;
  creatorPosts: number | null;
  /** The returned `since` is the effective 30-day cutoff when this is true. */
  windowClamped: boolean;
};
export type WatchlistData = { at: number; indexed: boolean; items: WatchlistDataItem[] };

export class WatchlistInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Reject malformed lists before reads. Clamp small device-clock skew; never query a future baseline. */
export function parseWatchlistRequest(value: unknown, at: number): WatchlistRequestItem[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) {
    throw new WatchlistInputError("expected a watchlist items array");
  }
  const items = (value as { items: unknown[] }).items;
  if (items.length > WATCHLIST_MAX_ITEMS) throw new WatchlistInputError(`watch up to ${WATCHLIST_MAX_ITEMS} tokens`);
  const seen = new Set<string>();
  return items.map((value): WatchlistRequestItem => {
    if (!value || typeof value !== "object") throw new WatchlistInputError("invalid watchlist item");
    const { chain, token, since } = value as Record<string, unknown>;
    if (!isChainKey(chain) || typeof token !== "string" || !/^0x[0-9a-f]{40}$/i.test(token)) {
      throw new WatchlistInputError("invalid token reference");
    }
    if (since !== null && since !== undefined && (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0 || since > at + WATCHLIST_CLOCK_SKEW_MS)) {
      throw new WatchlistInputError("since must be a timestamp in milliseconds within the allowed clock skew");
    }
    return { chain, token: token.toLowerCase(), since: since == null ? null : Math.min(since as number, at) };
  }).filter((item) => {
    const key = `${item.chain}:${item.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Enforce the byte limit even on chunked bodies or an inaccurate Content-Length. */
export async function readWatchlistBody(req: Request): Promise<unknown> {
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new WatchlistInputError("send application/json", 415);
  }
  if (Number(req.headers.get("content-length")) > WATCHLIST_BODY_MAX_BYTES) {
    throw new WatchlistInputError("watchlist request is too large", 413);
  }
  const reader = req.body?.getReader();
  if (!reader) throw new WatchlistInputError("empty request");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > WATCHLIST_BODY_MAX_BYTES) {
        await reader.cancel();
        throw new WatchlistInputError("watchlist request is too large", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof WatchlistInputError) throw error;
    throw new WatchlistInputError("invalid JSON body");
  } finally {
    reader.releaseLock();
  }
}

/** Two bounded batch reads, no wallet identity or off-chain write. Counts reflect indexed history only. */
export async function getWatchlistData(items: readonly WatchlistRequestItem[], at: number, ethUsd: number | null): Promise<WatchlistData> {
  // Keep this server helper safe if a future caller bypasses the route parser.
  const refs = parseWatchlistRequest({ items }, at);
  const bounded = refs.map((item) => ({
    ...item,
    since: item.since === null ? null : Math.max(item.since, at - WATCHLIST_WINDOW_MS),
    windowClamped: item.since !== null && item.since < at - WATCHLIST_WINDOW_MS,
  }));
  const blank = (): WatchlistDataItem[] => bounded.map((item) => ({ ...item, launch: null, holders: null, trades: null, creatorPosts: null }));
  const db = maybeDb();
  if (!db) return { at, indexed: false, items: blank() };
  if (!refs.length) return { at, indexed: true, items: [] };
  const windows = bounded.filter((item) => item.since !== null).map((item) => ({ chain_id: chainIdOf(item.chain), token: item.token, since: new Date(item.since!).toISOString() }));
  type Counts = { chain_id: number; token: string; trades: string; creator_posts: string };
  const [launches, counts] = await Promise.all([
    getLaunchesByRefs(refs, ethUsd),
    windows.length ? db<Counts[]>`
      WITH watched AS (
        SELECT * FROM jsonb_to_recordset(${db.json(windows)}) AS r(chain_id integer, token text, since timestamptz)
      )
      SELECT w.chain_id, w.token, s.trades, p.creator_posts
        FROM watched w JOIN bb_launches l ON l.chain_id = w.chain_id AND l.token = w.token
        LEFT JOIN LATERAL (
          SELECT count(*)::text AS trades FROM bb_launch_swaps s
           WHERE s.chain_id = w.chain_id AND s.token = w.token
             AND s.block_time > w.since AND s.block_time <= to_timestamp(${at / 1_000})
        ) s ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::text AS creator_posts FROM bb_posts p
           WHERE p.chain_id = w.chain_id AND p.token = w.token AND p.wallet = l.launcher
             AND NOT p.hidden AND p.parent_id IS NULL
             AND p.created_at > w.since AND p.created_at <= to_timestamp(${at / 1_000})
        ) p ON true` : Promise.resolve([] as Counts[]),
  ]);
  const launchByKey = new Map(launches.map((item) => [`${item.launch.chain}:${item.launch.token}`, item]));
  const countByKey = new Map(counts.map((item) => [`${item.chain_id}:${item.token}`, item]));
  return {
    at,
    indexed: true,
    items: bounded.map((item) => {
      const found = launchByKey.get(`${item.chain}:${item.token}`);
      const activity = countByKey.get(`${chainIdOf(item.chain)}:${item.token}`);
      return {
        ...item,
        launch: found?.launch ?? null,
        holders: found?.holders ?? null,
        trades: found && item.since !== null && activity ? Number(activity.trades) : null,
        creatorPosts: found && item.since !== null && activity ? Number(activity.creator_posts) : null,
      };
    }),
  };
}
