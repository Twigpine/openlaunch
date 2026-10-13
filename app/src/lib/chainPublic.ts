import { base } from "viem/chains";
import { defineChain, type Chain } from "viem";
import { EXPLORERS, type ChainKey } from "./chainKeys.ts";

/**
 * CLIENT-SAFE chain registry. Only NEXT_PUBLIC_* vars are read here so browser components can import it.
 * The key list, ids, labels and explorers live in chainKeys.ts (pure); server bits live in chain.ts.
 */
export * from "./chainKeys.ts";

export const robinhood: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

/**
 * Arc (Circle's L1). Gas is USDC: the native asset is USDC with 18-decimal accounting, and the same balance is also
 * an ERC-20 at 0x3600…0000 with 6 decimals (launchpad/config.ts NATIVE_ERC20). Every block is final (no reorgs).
 * viem ships an `arc` chain without RPC URLs as of 2.55; this definition carries the public endpoint and explorer.
 */
export const arc: Chain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io", apiUrl: "https://explorer.arc.io/api/v2" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11", blockCreated: 0 } },
});

export const CHAINS: Record<ChainKey, Chain> = { base, robinhood, arc };

export function chainIdOf(key: ChainKey): number {
  return CHAINS[key].id;
}
export function explorerTx(key: ChainKey, hash: string): string {
  return `${EXPLORERS[key].url}/tx/${hash}`;
}
export function explorerAddress(key: ChainKey, addr: string): string {
  return `${EXPLORERS[key].url}/address/${addr}`;
}
export function explorerName(key: ChainKey): string {
  return EXPLORERS[key].name;
}

/** Twigpine's (formerly Gitlawb's) Base builder code (ERC-8021). Public — attribution only. */
export const BUILDER_CODE = "bc_ly9ism19";
/** ERC-8021 data suffix for BUILDER_CODE (asserted by src/lib/builderCode.test.ts). Harmless on chains that ignore it. */
export const BUILDER_DATA_SUFFIX = "0x62635f6c793969736d31390b0080218021802180218021802180218021" as const;

import { BRAND_DOMAIN } from "./brand.ts";

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? `https://${BRAND_DOMAIN}`).replace(/\/$/, "");

export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
