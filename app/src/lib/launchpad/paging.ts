/** Pure paging helpers (node --test loads this directly). */
export const PAGE_SIZE = 40;
export const MAX_LIMIT = 200;
/** Rows in the home page's Just launched rail. */
export const JUST_LAUNCHED_SIZE = 8;

export function clampLimit(v: unknown, fallback = PAGE_SIZE): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_LIMIT, Math.trunc(n));
}
export function clampOffset(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100_000, Math.trunc(n));
}
/** Fetch one extra row to learn whether a next page exists without a COUNT(*). */
export function splitPage<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}
/** Cross-chain "newest first": by block time, then chain id, then block number — never raw block numbers across chains. */
export function newestFirst<T extends { block_time: string; chain_id: number; block_number: number }>(a: T, b: T): number {
  const dt = new Date(b.block_time).getTime() - new Date(a.block_time).getTime();
  return dt || b.chain_id - a.chain_id || b.block_number - a.block_number;
}
