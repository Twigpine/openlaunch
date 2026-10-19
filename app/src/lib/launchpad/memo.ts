import "server-only";

/**
 * Tiny in-process memo for hot read endpoints. With N browsers polling every
 * 5s, a 2s TTL turns N queries into ~1 per key without anyone noticing.
 * In-flight requests for the same key share one promise (no thundering herd).
 *
 * The cache is bounded: at most MEMO_MAX_KEYS entries. Expiry uses each
 * entry's own TTL; when everything is still fresh, the oldest entries go
 * first (a fresh hit refreshes recency, so hot keys survive bursts of cold
 * ones). Without the bound, request-controlled keys (per-bucket candle pages,
 * per-limit list keys) grow the map without limit inside one TTL window.
 */
export const MEMO_MAX_KEYS = 200;

const store = new Map<string, { at: number; ttlMs: number; value: Promise<unknown> }>();

/** Test-only: drop every entry so cases start isolated. */
export function clearMemo(): void {
  store.clear();
}

/** Drop one key, so the next read is fresh (after a write that changes what it holds). Other keys are untouched. */
export function forgetMemo(key: string): void {
  store.delete(key);
}

/** Test-only: current entry count. */
export function memoSizeForTests(): number {
  return store.size;
}

export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const t = now();
  const hit = store.get(key);
  if (hit && t - hit.at < hit.ttlMs) {
    // Refresh recency: a hot key must not be evicted by a burst of cold keys.
    store.delete(key);
    store.set(key, hit);
    return hit.value as Promise<T>;
  }
  const value = fn().catch((err) => {
    if (store.get(key)?.value === value) store.delete(key);
    throw err;
  });
  if (hit) store.delete(key);
  store.set(key, { at: t, ttlMs, value });
  if (store.size > MEMO_MAX_KEYS) {
    // Expired entries first (each judged by its own TTL)…
    for (const [k, v] of store) {
      if (store.size <= MEMO_MAX_KEYS) break;
      if (t - v.at >= v.ttlMs) store.delete(k);
    }
    // …then oldest first. Map preserves insertion order and the key just
    // written is newest, so this never evicts the caller's own entry.
    for (const k of store.keys()) {
      if (store.size <= MEMO_MAX_KEYS) break;
      store.delete(k);
    }
  }
  return value;
}
