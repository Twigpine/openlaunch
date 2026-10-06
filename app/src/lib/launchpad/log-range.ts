/**
 * Log-range splitting for RPC nodes that cap one eth_getLogs call by result count rather than by block span
 * (Arc: 2000 results, "query exceeds max results 2000, retry with the range …"; Alchemy: "Log response size
 * exceeded"). Pure, so node --test loads it directly.
 */

// deliberately not "query timeout": an overloaded node times out on every range, and bisecting it 2000 → 1 would only multiply the calls
const TOO_LARGE = /range too large|max allowed range|exceeds max results|more than \d+ results|response size exceeded|too many (results|logs)/i;

/** True when the node refused the query for its size (as opposed to failing outright). */
export function isRangeTooLarge(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  // viem wraps the RPC error a few layers deep: check every message along the cause chain
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { message?: unknown; details?: unknown; cause?: unknown };
    for (const text of [e.message, e.details]) if (typeof text === "string" && TOO_LARGE.test(text)) return true;
    cur = e.cause;
  }
  return typeof err === "string" && TOO_LARGE.test(err);
}

/**
 * Fetch logs over [from, to]; when the node says the range is too big, halve it and retry each half, down to a
 * single block. Any other error propagates unchanged. Results keep block order (left half first).
 */
export async function fetchLogsSplit<T>(fetch: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  try {
    return await fetch(from, to);
  } catch (err) {
    if (to <= from || !isRangeTooLarge(err)) throw err;
    const mid = from + (to - from) / 2n;
    const left = await fetchLogsSplit(fetch, from, mid);
    const right = await fetchLogsSplit(fetch, mid + 1n, to);
    return [...left, ...right];
  }
}

/**
 * Selector caps. A node may cap how many address and topic selectors one eth_getLogs filter carries: Robinhood Chain
 * (Arbitrum Nitro) refuses more than 1000 with "1011 address and topic selectors specified in query, but only 1000 are
 * allowed" / "exceed max topics". A list of every launched token or pool id outgrows that as a chain grows, and a refused
 * filter fails every range, so the indexer stops dead (Robinhood, 2026-10-05: the 1001st launch). The fix is to split the
 * LIST, not the block range.
 */
const TOO_MANY_SELECTORS = /selectors specified in query, but only (\d+) are allowed|exceed(?:s|ed)? max (?:topics|addresses)|too many (?:addresses|topics)/i;

/** The node's selector cap when `err` is a selector refusal: the number it states, else 1000 (geth's default); null otherwise. */
export function selectorCapFromError(err: unknown): number | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { message?: unknown; details?: unknown; cause?: unknown };
    for (const text of [e.message, e.details]) {
      if (typeof text !== "string") continue;
      const m = TOO_MANY_SELECTORS.exec(text);
      if (m) return m[1] ? Number(m[1]) : 1000;
    }
    cur = e.cause;
  }
  return null;
}

/** `list` in consecutive slices of at most `size` (size >= 1). */
export function chunkList<T>(list: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** Headroom under a stated cap: the filter's own address and event-signature topics count against it too. */
export const SELECTOR_MARGIN = 10;

/**
 * Run `fetch` over `list` in slices that stay under the chain's selector cap. `caps` remembers each chain's cap: a chain
 * with no known cap is asked once with the whole list (no extra calls where the node allows it, as on Base), and the first
 * refusal records the cap the node states and retries in slices. Any other error propagates unchanged.
 */
export async function fetchBySelectors<T, K>(caps: Map<K, number>, key: K, list: T[], fetch: (slice: T[]) => Promise<unknown[]>): Promise<unknown[]> {
  const cap = caps.get(key);
  if (cap === undefined) {
    try {
      return await fetch(list);
    } catch (err) {
      const stated = selectorCapFromError(err);
      if (stated === null) throw err;
      caps.set(key, stated);
      return fetchBySelectors(caps, key, list, fetch);
    }
  }
  const out: unknown[] = [];
  for (const slice of chunkList(list, cap - SELECTOR_MARGIN)) out.push(...(await fetch(slice)));
  return out;
}

/** Logs from several slices back in chain order (block, then log index). */
export function byChainOrder<L extends { blockNumber?: bigint | null; logIndex?: number | null }>(logs: L[]): L[] {
  return [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1));
}
