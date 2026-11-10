import type { Chain } from "viem";
import { arbitrum, mainnet, optimism } from "viem/chains";
import { CHAINS, SITE_URL } from "../chainPublic";
import { BRIDGE_CHAINS, BRIDGE_FUNDING_IDS, type BridgeChainId } from "./types";

/** Wallet chains by Relay's numeric id. Arc is a launch chain like the others (chainPublic.ts); one definition for both. */
export const BRIDGE_WALLET_CHAINS: Record<BridgeChainId, Chain> = {
  8453: CHAINS.base,
  4663: CHAINS.robinhood,
  5042: CHAINS.arc,
  1: mainnet,
  42161: arbitrum,
  10: optimism,
};

/** The funding networks the wallet config adds next to the launch chains, so a wallet can switch to them and send. */
export const BRIDGE_FUNDING_WALLET_CHAINS: readonly Chain[] = BRIDGE_FUNDING_IDS.map((id) => BRIDGE_WALLET_CHAINS[id]);

/** Browser reads on a funding network go through the same-origin RPC proxy, like the launch chains (api/rpc). */
export function bridgeFundingRpc(id: (typeof BRIDGE_FUNDING_IDS)[number]): string {
  return `${SITE_URL}/api/rpc?chain=${BRIDGE_CHAINS[id].key}`;
}
