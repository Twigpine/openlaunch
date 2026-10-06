import type { ChartPool } from "./chart-pool.ts";
import { GeckoRateLimitError, type GeckoStatus } from "./geckoterminal.ts";

/** Bounded, deduplicated metadata cache. Limits are per server process. */
export function createGeckoCache(lookup: (pool: ChartPool) => Promise<GeckoStatus>, now = Date.now) {
  const cache = new Map<string, { status: GeckoStatus; expires: number }>();
  const pending = new Map<string, Promise<GeckoStatus>>();
  let requests: number[] = [];
  let blockedUntil = 0;
  return async function get(pool: ChartPool): Promise<GeckoStatus> {
    const time = now();
    const key = `${pool.chain}:${pool.poolId}:${pool.token}:${pool.quote}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expires > time) return hit.status;
    cache.delete(key);
    const inflight = pending.get(key);
    if (inflight) return inflight;
    requests = requests.filter((at) => time - at < 60_000);
    // Conservative public-API budget. Provider failures use our own chart.
    if (time < blockedUntil || requests.length >= 10 || pending.size >= 2) throw new Error("Chart lookup capacity reached.");
    requests.push(time);
    const work = Promise.resolve().then(() => lookup(pool)).then((status) => {
      for (const [id, entry] of cache) if (entry.expires <= now()) cache.delete(id);
      if (cache.size >= 1_000) cache.delete(cache.keys().next().value!);
      cache.set(key, { status, expires: now() + (status === "ready" || status === "inverted" ? 900_000 : 60_000) });
      return status;
    }).catch((error: unknown) => {
      if (error instanceof GeckoRateLimitError) blockedUntil = now() + 60_000;
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}
