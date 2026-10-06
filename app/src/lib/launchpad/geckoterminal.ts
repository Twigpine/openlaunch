import { isChartPool, isRecord, type ChartPool } from "./chart-pool.ts";

export type GeckoStatus = "ready" | "unlisted" | "inverted" | "unpriced";
export const GECKO_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type GeckoInterval = typeof GECKO_INTERVALS[number];
export type GeckoMetric = "price" | "market_cap";

/** Never chart a different pool, token, quote or denomination as this launch. */
export function classifyGeckoPool(payload: unknown, pool: ChartPool): GeckoStatus {
  if (!isChartPool(pool)) throw new Error("Invalid chart pool.");
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error("Unexpected GeckoTerminal response.");
  const { data } = payload;
  const lower = (value: unknown) => typeof value === "string" ? value.toLowerCase() : "";
  if (data.type !== "pool" || lower(data.id) !== `${pool.chain}_${pool.poolId.toLowerCase()}`
    || !isRecord(data.attributes) || lower(data.attributes.address) !== pool.poolId.toLowerCase()
    || !isRecord(data.relationships)) throw new Error("Unexpected pool identity.");
  function tokenId(value: unknown) {
    return isRecord(value) && isRecord(value.data) && value.data.type === "token" ? lower(value.data.id) : "";
  }
  const base = tokenId(data.relationships.base_token);
  const quote = tokenId(data.relationships.quote_token);
  const expectedBase = `${pool.chain}_${pool.token.toLowerCase()}`;
  const expectedQuote = `${pool.chain}_${pool.quote.toLowerCase()}`;
  if (base === expectedQuote && quote === expectedBase) return "inverted";
  if (base !== expectedBase || quote !== expectedQuote) throw new Error("Unexpected token identity.");
  const raw = data.attributes.base_token_price_usd;
  const price = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(price) && price > 0 ? "ready" : "unpriced";
}

export class GeckoRateLimitError extends Error {}

export async function lookupGeckoPool(pool: ChartPool, request: typeof fetch = fetch): Promise<GeckoStatus> {
  if (!isChartPool(pool)) throw new Error("Invalid chart pool.");
  const response = await request(`https://api.geckoterminal.com/api/v2/networks/${pool.chain}/pools/${pool.poolId.toLowerCase()}`, {
    headers: { accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return "unlisted";
  if (response.status === 429) throw new GeckoRateLimitError("GeckoTerminal rate limit.");
  if (!response.ok) throw new Error("GeckoTerminal lookup unavailable.");
  return classifyGeckoPool(await response.json(), pool);
}

/** Options emitted by Gecko's own embed builder. Branding remains visible. */
export function geckoChartUrl(pool: ChartPool, theme: "light" | "dark", options?: { interval: GeckoInterval; metric: GeckoMetric }): string {
  if (!isChartPool(pool)) throw new Error("Invalid chart pool.");
  const url = new URL(`https://www.geckoterminal.com/${pool.chain}/pools/${pool.poolId.toLowerCase()}`);
  if (options) url.search = new URLSearchParams({
    embed: "1", info: "0", swaps: "0", grayscale: "1", light_chart: theme === "dark" ? "0" : "1",
    chart_type: options.metric, resolution: options.interval, bg_color: theme === "dark" ? "000000" : "fafaf8",
  }).toString();
  return url.toString();
}
