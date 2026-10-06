import { isChainKey, type ChainKey } from "../chainPublic.ts";

export type ChartPool = { chain: ChainKey; token: string; poolId: string; quote: string };
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const address = /^0x[0-9a-f]{40}$/i;
const poolId = /^0x[0-9a-f]{64}$/i;

export function isChartPool(value: unknown): value is ChartPool {
  return isRecord(value) && isChainKey(value.chain)
    && typeof value.token === "string" && address.test(value.token)
    && typeof value.quote === "string" && address.test(value.quote)
    && value.token.toLowerCase() !== value.quote.toLowerCase()
    && typeof value.poolId === "string" && poolId.test(value.poolId);
}
