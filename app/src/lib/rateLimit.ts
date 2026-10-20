/**
 * In-process rate-limit buckets. Two shapes:
 *   - fixed window (`rateLimited`): one hit count per key until its window ends;
 *   - token bucket (`takeToken`): a burst cap with a steady refill, for the JSON-RPC proxy.
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
    if (buckets.size >= MAX_RATE_BUCKETS) pruneRateBuckets(buckets, now, MAX_RATE_BUCKETS - 1);
    buckets.set(key, { n: 1, at: now, windowMs });
    return false;
  }
  b.n += 1;
  // Keep a hot key away from the eviction edge: a burst of one-shot keys must not reset it first.
  buckets.delete(key);
  buckets.set(key, b);
  return b.n > max;
}

/** Token bucket: `cap` burst, `refillPerSecond` steady state. `now` is injectable for tests. */
export function takeToken(key: string, cap: number, refillPerSecond: number, now = Date.now()): boolean {
  const b = tokenBuckets.get(key) ?? { tokens: cap, at: now, cap, refillPerSecond };
  b.cap = cap;
  b.refillPerSecond = refillPerSecond;
  b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * refillPerSecond);
  b.at = now;
  // Keep a throttled key away from the eviction edge too: a flood of one-shot keys must not reset it.
  tokenBuckets.delete(key);
  tokenBuckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  if (tokenBuckets.size > MAX_TOKEN_BUCKETS) pruneTokenBuckets(tokenBuckets, now, MAX_TOKEN_BUCKETS - 1);
  return true;
}

/** Fully refilled buckets carry no state and go first; then oldest. Exported for tests. */
export function pruneTokenBuckets(map: Map<string, TokenBucket>, now: number, max: number): void {
  for (const [key, b] of map) {
    const fullAfter = b.refillPerSecond > 0 ? (b.cap / b.refillPerSecond) * 1000 : Infinity;
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
