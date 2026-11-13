/**
 * In-process rate-limit buckets. Two shapes:
 *   - fixed window (`rateLimited`): one hit count per key until its window ends;
 *   - token bucket (`takeToken`): a burst cap with a steady refill, for the JSON-RPC proxy (one token per upstream call).
 *
 * The maps are bounded. Expired entries go first; if everything is still live, the least recently used entries go.
 * They are never cleared wholesale: a burst of new keys must not reset every active limit (the old clear-on-overflow
 * did exactly that).
 */
export const MAX_RATE_BUCKETS = 20_000;
export const MAX_TOKEN_BUCKETS = 10_000;

type Bucket = { n: number; at: number; windowMs: number };
type TokenBucket = { tokens: number; at: number; cap: number; refillPerSecond: number };

const buckets = new Map<string, Bucket>();
const tokenBuckets = new Map<string, TokenBucket>();

/** Expired first, then oldest (Map insertion order) until the map fits. Exported for tests. */
export function pruneRateBuckets(map: Map<string, Bucket>, now: number, max: number): void {
  for (const [key, b] of map) if (now - b.at > b.windowMs) map.delete(key);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Fixed-window limit: `max` hits per `windowMs` per key. */
export function rateLimited(key: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.at > windowMs || b.windowMs !== windowMs) {
    // A reset bucket must not keep its old insertion position, or the next prune evicts it as the oldest live entry.
    // Only a brand-new key grows the map, so only it can need room made.
    if (b) buckets.delete(key);
    else if (buckets.size >= MAX_RATE_BUCKETS) pruneRateBuckets(buckets, now, MAX_RATE_BUCKETS - 1);
    buckets.set(key, { n: 1, at: now, windowMs });
    return false;
  }
  b.n += 1;
  // Keep a hot key away from the eviction edge: a burst of one-shot keys must not reset it first.
  buckets.delete(key);
  buckets.set(key, b);
  return b.n > max;
}

/**
 * Token bucket: `cap` burst, `refillPerSecond` steady state. Takes `cost` tokens, all or none: a refused take spends
 * nothing. `now` is injectable for tests.
 */
export function takeToken(key: string, cap: number, refillPerSecond: number, now = Date.now(), cost = 1): boolean {
  const b = tokenBuckets.get(key) ?? { tokens: cap, at: now, cap, refillPerSecond };
  b.cap = cap;
  b.refillPerSecond = refillPerSecond;
  // a clock that steps back (an NTP correction) refills nothing rather than draining the bucket
  b.tokens = Math.min(cap, b.tokens + (Math.max(0, now - b.at) / 1000) * refillPerSecond);
  b.at = Math.max(now, b.at);
  // Keep a throttled key away from the eviction edge too: a flood of one-shot keys must not reset it.
  tokenBuckets.delete(key);
  tokenBuckets.set(key, b);
  const ok = b.tokens >= cost;
  if (ok) b.tokens -= cost;
  // after the take, so a bucket just drawn from is not full and stays; on every path, so refused takes on new keys
  // cannot grow the map past its bound either (a refused new bucket is full, carries no state, and may go)
  if (tokenBuckets.size > MAX_TOKEN_BUCKETS) pruneTokenBuckets(tokenBuckets, now, MAX_TOKEN_BUCKETS - 1);
  return ok;
}

/** Fully refilled buckets carry no state and go first; then oldest. Exported for tests. */
export function pruneTokenBuckets(map: Map<string, TokenBucket>, now: number, max: number): void {
  for (const [key, b] of map) {
    // full once the tokens it is short of have refilled (a bucket one token down is full after one token's time)
    const fullAfter = b.refillPerSecond > 0 ? (Math.max(0, b.cap - b.tokens) / b.refillPerSecond) * 1000 : Infinity;
    if (now - b.at >= fullAfter) map.delete(key);
  }
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Test-only: drop every bucket so cases start isolated. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
  tokenBuckets.clear();
}

/** Test-only: current bucket counts. */
export function rateLimitSizesForTests(): { fixed: number; tokens: number } {
  return { fixed: buckets.size, tokens: tokenBuckets.size };
}

/** Test-only: fixed-window keys in eviction order (oldest first). */
export function rateLimitedKeysForTests(): string[] {
  return [...buckets.keys()];
}
