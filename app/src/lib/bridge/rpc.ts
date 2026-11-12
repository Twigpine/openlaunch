import "server-only";
import { CHAINS, isChainKey, rpcUrl } from "@/lib/chain";
import { BRIDGE_CHAINS, BRIDGE_FUNDING_IDS, type BridgeChainId } from "./types";

/**
 * Upstreams for the bridge's funding networks behind the same-origin RPC proxy (api/rpc). A keyed URL from the
 * environment wins (Alchemy serves all three with the key the launch chains use); unset, a public node answers.
 * The proxy's read-only method allowlist and per-IP budget apply to these exactly as to the launch chains.
 */
const FUNDING_RPC = {
  1: { env: "ETHEREUM_RPC_URL", fallback: "https://ethereum-rpc.publicnode.com" },
  42161: { env: "ARBITRUM_RPC_URL", fallback: "https://arb1.arbitrum.io/rpc" },
  10: { env: "OPTIMISM_RPC_URL", fallback: "https://mainnet.optimism.io" },
} as const satisfies Record<(typeof BRIDGE_FUNDING_IDS)[number], { env: string; fallback: string }>;

/** The upstream for a proxy `?chain=` key naming a funding network (ethereum, arbitrum, optimism), else null. */
export function bridgeFundingUpstream(key: string): string | null {
  const id = BRIDGE_FUNDING_IDS.find((candidate) => BRIDGE_CHAINS[candidate].key === key);
  if (id === undefined) return null;
  return process.env[FUNDING_RPC[id].env]?.trim() || FUNDING_RPC[id].fallback;
}

/** The server's own upstream for any bridge network: the launch chains' keyed RPC or public node, else a funding upstream. */
export function bridgeRpcUpstream(chainId: BridgeChainId): string | null {
  const key = BRIDGE_CHAINS[chainId].key;
  if (isChainKey(key)) return rpcUrl(key) ?? CHAINS[key].rpcUrls.default.http[0] ?? null;
  return bridgeFundingUpstream(key);
}
