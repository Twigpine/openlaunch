import "server-only";
import { maybeDb } from "@/lib/db";
import { publicClient } from "@/lib/chain";
import { CHAIN_KEYS, chainKeyOf, type ChainKey } from "@/lib/chainPublic";
import { STOCK_PRICE_URL, STOCK_REGISTRY_URL, parseRegistry, stockUsd, type StockQuote } from "./stocks";
import { BASE_STOCKS, baseStockByAddress, feedUsd, stockTileSvg } from "./baseStocks";

/**
 * Stock quote assets, server-side only. Two registries, one shape:
 *   - robinhood: Robinhood Stock Tokens from Robinhood's registry (fetched, parsed defensively,
 *     cached 10 min); prices from Robinhood's quote API, cached 30s, only for quotes in use.
 *   - base: Coinbase tokenized stocks (B20) from the static list in baseStocks.ts (docs.base.org);
 *     prices from Chainlink's on-chain feeds via one multicall, cached 60s.
 * An address is a stock ONLY if it is in a registry (never trust on-chain names).
 * Everything fails soft: on error the last good copy stays; with none, stocks are simply not
 * offered and existing stock-quoted launches show no USD.
 */
export type Stock = { chain: ChainKey; address: string; symbol: string; name: string; decimals: number; logo: string | null };

type Cache = { at: number; list: StockQuote[]; byAddress: Map<string, StockQuote> };
let registry: Cache | null = null;
let registryInflight: Promise<Cache | null> | null = null;
const REGISTRY_TTL = 10 * 60_000;
const prices = new Map<string, { at: number; usd: number | null }>(); // key: `${chain}:${address}`
const PRICE_TTL: Record<ChainKey, number> = { robinhood: 30_000, base: 60_000, arc: 60_000 /* no stocks there; never consulted */ };

async function fetchRegistry(): Promise<Cache | null> {
  try {
    const res = await fetch(STOCK_REGISTRY_URL, { headers: { accept: "application/json", "user-agent": "openlaunch.lol" }, signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const list = parseRegistry(await res.json());
    if (list.length === 0) throw new Error("registry empty");
    return { at: Date.now(), list, byAddress: new Map(list.map((s) => [s.address, s])) };
  } catch (err) {
    console.warn("[stocks] registry fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Ensure the Robinhood registry copy exists (refreshing in the background when stale). Cheap when warm. */
export async function ensureRegistry(): Promise<Cache | null> {
  const stale = !registry || Date.now() - registry.at > REGISTRY_TTL;
  if (!registry) {
    registryInflight ??= fetchRegistry().finally(() => (registryInflight = null));
    registry = (await registryInflight) ?? registry;
  } else if (stale && !registryInflight) {
    registryInflight = fetchRegistry()
      .then((c) => {
        if (c) registry = c;
        return c;
      })
      .finally(() => (registryInflight = null));
  }
  return registry;
}

/** Where a chain's tokenized stocks come from (client-safe, in config.ts so the form can hide the Stock quote where there are none). */
import { STOCK_SOURCE } from "./config";
export { STOCK_SOURCE, type StockSource } from "./config";

/** Synchronous registry lookup for any chain (call ensureRegistry() first in the request for robinhood). */
export function stockByAddress(chain: ChainKey, address: string): Stock | null {
  const a = address.toLowerCase();
  if (STOCK_SOURCE[chain] === "coinbase-b20") {
    const s = baseStockByAddress(a);
    return s ? { chain, address: s.address, symbol: s.symbol, name: s.name, decimals: s.decimals, logo: stockTileSvg(s.symbol) } : null;
  }
  if (STOCK_SOURCE[chain] !== "robinhood-registry") return null;
  const s = registry?.byAddress.get(a);
  return s ? { chain, address: s.address, symbol: s.symbol, name: s.name, decimals: s.decimals, logo: s.logo } : null;
}

export function stockList(chain: ChainKey): Stock[] {
  if (STOCK_SOURCE[chain] === "coinbase-b20") return BASE_STOCKS.map((s) => ({ chain, address: s.address, symbol: s.symbol, name: s.name, decimals: s.decimals, logo: stockTileSvg(s.symbol) }));
  if (STOCK_SOURCE[chain] !== "robinhood-registry") return [];
  return (registry?.list ?? []).map((s) => ({ chain, address: s.address, symbol: s.symbol, name: s.name, decimals: s.decimals, logo: s.logo }));
}

async function fetchRobinhoodPrice(s: StockQuote): Promise<number | null> {
  try {
    const res = await fetch(STOCK_PRICE_URL(s.symbol), { headers: { accept: "application/json", "user-agent": "openlaunch.lol" }, signal: AbortSignal.timeout(6_000), cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { quotes?: { tokenSymbol?: string; bid?: string; ask?: string; isTradingHalt?: boolean }[] };
    const q = j.quotes?.find((x) => x.tokenSymbol === s.symbol) ?? j.quotes?.[0];
    return stockUsd(q, s.multiplier);
  } catch {
    return null;
  }
}

const AGGREGATOR_ABI = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
] as const;

/** Chainlink feeds for a set of Base stock addresses in one multicall (feeds are ordinary contracts: any RPC works). */
async function fetchBasePrices(addresses: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const stocks = addresses.map((a) => baseStockByAddress(a)).filter((s): s is NonNullable<typeof s> => s !== null);
  if (stocks.length === 0) return out;
  try {
    const res = await publicClient("base").multicall({
      contracts: stocks.map((s) => ({ address: s.feed as `0x${string}`, abi: AGGREGATOR_ABI, functionName: "latestRoundData" as const })),
      allowFailure: true,
    });
    const nowS = Math.floor(Date.now() / 1000);
    stocks.forEach((s, i) => {
      const r = res[i];
      out.set(s.address, r.status === "success" ? feedUsd({ answer: r.result[1], updatedAt: Number(r.result[3]) }, nowS) : null);
    });
  } catch (err) {
    console.warn("[stocks] chainlink multicall failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

/** USD per token for stock addresses on a chain (cached per chain TTL). */
export async function stockPrices(chain: ChainKey, addresses: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => stockByAddress(chain, a));
  if (wanted.length === 0) return out;
  const now = Date.now();
  const miss: string[] = [];
  for (const a of wanted) {
    const hit = prices.get(`${chain}:${a}`);
    if (hit && now - hit.at < PRICE_TTL[chain]) out.set(a, hit.usd);
    else miss.push(a);
  }
  if (miss.length === 0) return out;
  const fresh = new Map<string, number | null>();
  if (STOCK_SOURCE[chain] === "coinbase-b20") for (const [a, v] of await fetchBasePrices(miss)) fresh.set(a, v);
  else if (STOCK_SOURCE[chain] === "robinhood-registry") {
    const reg = await ensureRegistry();
    await Promise.all(
      miss.map(async (a) => {
        const s = reg?.byAddress.get(a);
        fresh.set(a, s ? await fetchRobinhoodPrice(s) : null);
      }),
    );
  }
  for (const a of miss) {
    const prev = prices.get(`${chain}:${a}`);
    const usd = fresh.get(a) ?? prev?.usd ?? null; // keep the last good price through a transient failure
    prices.set(`${chain}:${a}`, { at: now, usd });
    out.set(a, usd);
  }
  return out;
}

/** Stock addresses currently used as quotes by launches, per chain (so pricing stays bounded). */
export async function stockQuotesInUse(): Promise<Record<ChainKey, string[]>> {
  const out = Object.fromEntries(CHAIN_KEYS.map((k) => [k, [] as string[]])) as Record<ChainKey, string[]>;
  const db = maybeDb();
  if (!db) return out;
  const rows = await db<{ chain_id: number; quote: string }[]>`SELECT DISTINCT chain_id, quote FROM bb_launches`;
  await ensureRegistry();
  for (const r of rows) {
    const chain = chainKeyOf(r.chain_id);
    if (chain && stockByAddress(chain, r.quote)) out[chain].push(r.quote);
  }
  return out;
}

/** Warm stock prices in use, retaining their chain: the same address can represent different assets elsewhere. */
export async function stockUsdInUse(): Promise<Map<ChainKey, Map<string, number | null>>> {
  const inUse = await stockQuotesInUse();
  return new Map(await Promise.all(CHAIN_KEYS.map(async (chain) => [chain, await stockPrices(chain, inUse[chain])] as const)));
}
