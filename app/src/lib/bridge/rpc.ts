import "server-only";
import { BRIDGE_CHAINS, BRIDGE_FUNDING_IDS } from "./types";

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
