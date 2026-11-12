import { createConfig, http } from "wagmi";
import { injected, coinbaseWallet } from "wagmi/connectors";
import type { Chain } from "viem";
import { CHAINS, CHAIN_KEYS, DEFAULT_CHAIN } from "./chainPublic";
import { browserRpc } from "./launchpad/config";
import { BRIDGE_FUNDING_WALLET_CHAINS, bridgeFundingRpc } from "./bridge/chains";
import { BRIDGE_FUNDING_IDS } from "./bridge/types";

// Every chain in one config, the default first, then the bridge's funding networks (Ethereum, Arbitrum, Optimism),
// which nothing launches on. Reads/simulations go through our RPC proxy per chain (or a dev override); wallets send
// transactions through their own provider.
const keys = [DEFAULT_CHAIN, ...CHAIN_KEYS.filter((k) => k !== DEFAULT_CHAIN)];
const chains = [...keys.map((k) => CHAINS[k]), ...BRIDGE_FUNDING_WALLET_CHAINS] as [Chain, ...Chain[]];

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected(), coinbaseWallet({ appName: "openlaunch.lol", preference: { options: "all", telemetry: false } })],
  transports: Object.fromEntries([
    ...keys.map((k) => [CHAINS[k].id, http(browserRpc(k), { batch: true })]),
    ...BRIDGE_FUNDING_IDS.map((id) => [id, http(bridgeFundingRpc(id), { batch: true })]),
  ]),
  ssr: true,
});
