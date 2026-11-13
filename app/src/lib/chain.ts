import "server-only";
import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { CHAINS, RPC_ENV_NAME, type ChainKey } from "./chainPublic";
import { keylessHttp } from "./rpc-transport";

export * from "./chainPublic";

/** SERVER chain access. BASE_RPC_URL / ROBINHOOD_RPC_URL / ARC_RPC_URL (Alchemy etc.) override the chains' public RPCs. */
const cached = new Map<ChainKey, PublicClient>();

export function rpcUrl(key: ChainKey): string | undefined {
  return process.env[RPC_ENV_NAME[key]]?.trim() || undefined;
}

/**
 * A Base node that can execute B20 precompiles (Coinbase tokenized stocks). Alchemy's Base nodes
 * answer "EVM error OpcodeNotFound" for any call touching one; the public nodes execute them.
 * Used as a fallback by the server client and the browser RPC proxy. Override with BASE_B20_RPC_URL.
 */
export function b20RpcUrl(): string {
  return process.env.BASE_B20_RPC_URL?.trim() || "https://base-rpc.publicnode.com";
}

/** An HTTP transport whose errors never quote the URL's path or query (where a keyed provider puts its API key). */
function keyless(url: string | undefined, options: { batch: true; retryCount: number; timeout?: number }) {
  const k = keylessHttp(url);
  return http(k.url, k.fetchFn ? { ...options, fetchFn: k.fetchFn } : options);
}

let b20: PublicClient | null = null;
/**
 * A Base client on the B20-capable node alone, for reads that must not be answered by a node that cannot
 * execute B20: inside a multicall such a node may report each call as a plain failure, not as an RPC
 * error the fallback in publicClient would retry.
 */
export function b20Client(): PublicClient {
  b20 ??= createPublicClient({ chain: CHAINS.base, transport: keyless(b20RpcUrl(), { batch: true, retryCount: 1, timeout: 5_000 }) });
  return b20;
}

export function publicClient(key: ChainKey): PublicClient {
  const hit = cached.get(key);
  if (hit) return hit;
  const primary = keyless(rpcUrl(key), { batch: true, retryCount: 3 });
  const transport = key === "base" ? fallback([primary, keyless(b20RpcUrl(), { batch: true, retryCount: 2 })], { rank: false }) : primary;
  const c = createPublicClient({ chain: CHAINS[key], transport });
  cached.set(key, c);
  return c;
}
