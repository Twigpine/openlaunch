/**
 * Cursor pagination for token comments (pure; unit-tested).
 *
 * GET /api/posts?chain=&token= previously returned the newest 100 posts with
 * no cursor (server ceiling 300, route never passed a limit). A viral token
 * pays the full scan on every poll. This owns the query parsing so the route
 * and postsServer share one definition: `limit` (1–100, default 100 to match
 * the previous response) and `before` (exclusive id cursor, newest page first).
 * Callers without params get the same first page as before, plus nextCursor;
 * clients can now fetch older pages instead of re-scanning everything.
 */

export const TOKEN_POSTS_DEFAULT_LIMIT = 100;
export const TOKEN_POSTS_MAX_LIMIT = 100;

export function parseTokenPostsPaging(query: { limit?: unknown; before?: unknown }): { limit: number; beforeId: number | null } {
  // NB: URLSearchParams.get() returns null when absent, and Number(null) /
  // Number("") is 0 — both must fall through to the default, not clamp to 1.
  const rawLimit = query.limit === null || query.limit === undefined || (typeof query.limit === "string" && query.limit.trim() === "") ? NaN : Number(query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(TOKEN_POSTS_MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : TOKEN_POSTS_DEFAULT_LIMIT;
  const rawBefore = query.before === null || query.before === undefined || query.before === "" ? NaN : Number(query.before);
  const beforeId = Number.isInteger(rawBefore) && rawBefore > 0 ? rawBefore : null;
  return { limit, beforeId };
}

export function postsCursorKey(chain: string, token: string, limit: number, beforeId: number | null): string {
  return `posts:${chain}:${token.toLowerCase()}:${limit}:${beforeId ?? "head"}`;
}

/** Global human feed page: fixed 30 rows, offset clamped so one bad query cannot thrash the memo or force a huge OFFSET scan. */
export const FEED_POSTS_LIMIT = 30;
export const FEED_POSTS_MAX_OFFSET = 100_000;

/** A whole offset in [0, FEED_POSTS_MAX_OFFSET]; anything non-finite is 0. The one clamp the parser, memo key and query share. */
export function clampFeedOffset(n: number): number {
  return Number.isFinite(n) ? Math.min(FEED_POSTS_MAX_OFFSET, Math.max(0, Math.trunc(n))) : 0;
}

export function parseFeedPaging(query: { offset?: unknown }): { offset: number } {
  const blank = query.offset === null || query.offset === undefined || (typeof query.offset === "string" && query.offset.trim() === "");
  return { offset: clampFeedOffset(blank ? NaN : Number(query.offset)) };
}

/** Memo key for a feed page. The offset is clamped first so `-5`, `1.9` and `9999999999` cannot each mint a distinct hot key. */
export function feedPostsKey(offset: number): string {
  return `feed-posts:${clampFeedOffset(offset)}`;
}

/** Cursor for the next page: oldest id on a full page, else null (no more). */
export function nextPostsCursor(ids: number[], limit: number): number | null {
  if (ids.length < limit) return null;
  const oldest = ids[ids.length - 1];
  return Number.isInteger(oldest) && oldest > 0 ? oldest : null;
}
