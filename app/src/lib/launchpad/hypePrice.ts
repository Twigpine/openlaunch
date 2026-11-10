import "server-only";

/**
 * HYPE/USD spot (Elysium's native asset), 60s memo, null when unavailable (UI then shows HYPE only). Same shape as
 * ethPrice.ts:
 *   1. Coinbase spot (HYPE-USD), what people compare against on exchanges and screeners;
 *   2. Hyperliquid's own mid price (the public info API, `allMids`), which fails independently of Coinbase;
 *   3. the last good value, for at most HYPE_STALE_MAX_MS after it was confirmed;
 *   4. null.
 * Stale-while-revalidate: once a value exists, a caller never waits on a refresh. Past the TTL it gets the last good value
 * at once (while still inside the stale bound) and one background refresh replaces it; only a cold start, or a value past
 * the stale bound, waits. Every list and page reads this, so a slow upstream must never sit on the request path.
 * Both upstreams are fetched with cache: "no-store": this memo is the only cache, so the fallback and the stale bound see
 * a failing Coinbase as failing (Next's data cache would keep answering with its last good body).
 * Failures still advance the attempt timestamp, so a dead upstream is retried once per TTL, not on every request.
 * Display and sorting only: nothing on-chain reads any of this.
 */
export const HYPE_SPOT_URL = "https://api.coinbase.com/v2/prices/HYPE-USD/spot";
/** POST {"type":"allMids"} → { "HYPE": "74.546", … } (mid prices by coin, as decimal strings). No key needed. */
export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HYPE_PRICE_TTL_MS = 60_000;
export const HYPE_FETCH_TIMEOUT_MS = 5_000;
/** How long the last good value is served once both live sources fail. */
export const HYPE_STALE_MAX_MS = 15 * 60_000;

export type HypePriceSource = "coinbase" | "hyperliquid";
type Cache = { at: number; goodAt: number; usd: number | null; source: HypePriceSource | null };
let cached: Cache = { at: 0, goodAt: 0, usd: null, source: null };
/** One refresh at a time: concurrent callers share it, so a slow earlier attempt can never overwrite a newer result. */
let inflight: Promise<number | null> | null = null;

/** Test-only: drop the memo so each case starts cold. */
export function resetHypePriceCache(): void {
  cached = { at: 0, goodAt: 0, usd: null, source: null };
  inflight = null;
}

/** Test-only: which source the current value came from (null when none). */
export function hypePriceSource(): HypePriceSource | null {
  return cached.source;
}

function positive(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A positive finite USD number out of a Coinbase spot body ({ data: { amount: "74.5" } }); null when unusable. */
export function parseHypeSpot(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  return positive((body as { data?: { amount?: unknown } }).data?.amount);
}

/** HYPE's mid out of a Hyperliquid `allMids` body; null when unusable. */
export function parseHyperliquidMid(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  return positive((body as Record<string, unknown>).HYPE);
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

async function fromCoinbase(fetchFn: FetchFn): Promise<number | null> {
  try {
    const res = await fetchFn(HYPE_SPOT_URL, { cache: "no-store", signal: AbortSignal.timeout(HYPE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return parseHypeSpot(await res.json());
  } catch {
    return null;
  }
}

async function fromHyperliquid(fetchFn: FetchFn): Promise<number | null> {
  try {
    const res = await fetchFn(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      cache: "no-store",
      signal: AbortSignal.timeout(HYPE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseHyperliquidMid(await res.json());
  } catch {
    return null;
  }
}

export async function hypeUsd(opts: { fetchFn?: FetchFn; now?: () => number } = {}): Promise<number | null> {
  const now = opts.now ?? Date.now;
  const t = now();
  // the memo never extends a stale value past its bound: once over it, refresh regardless of the TTL
  const staleExpired = cached.usd !== null && t - cached.goodAt > HYPE_STALE_MAX_MS;
  if (t - cached.at < HYPE_PRICE_TTL_MS && !staleExpired) return cached.usd;
  const fetchFn: FetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init as RequestInit));
  inflight ??= refresh(fetchFn, now).finally(() => {
    inflight = null;
  });
  // a value inside its stale bound is served at once; the refresh above replaces it for the next caller
  if (cached.usd !== null && !staleExpired) return cached.usd;
  return inflight;
}

async function refresh(fetchFn: FetchFn, now: () => number): Promise<number | null> {
  let source: HypePriceSource = "coinbase";
  let usd = await fromCoinbase(fetchFn);
  if (usd === null) {
    source = "hyperliquid";
    usd = await fromHyperliquid(fetchFn);
  }
  const t = now();
  if (usd !== null) {
    if (source !== cached.source && cached.source !== null) console.warn(`[hype-price] serving ${source} (${source === "hyperliquid" ? "Coinbase spot unavailable" : "Coinbase spot back"})`);
    cached = { at: t, goodAt: t, usd, source };
    return usd;
  }
  // both live sources failed: the last good value for a bounded time, then null
  const stale = cached.usd !== null && t - cached.goodAt <= HYPE_STALE_MAX_MS;
  if (!stale && cached.usd !== null) console.warn(`[hype-price] Coinbase and Hyperliquid both unavailable for over ${HYPE_STALE_MAX_MS / 60_000} minutes: HYPE USD figures off until one recovers`);
  cached = { at: t, goodAt: cached.goodAt, usd: stale ? cached.usd : null, source: stale ? cached.source : null };
  return cached.usd;
}
