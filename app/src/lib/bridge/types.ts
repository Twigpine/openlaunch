import type { Address, Hex } from "viem";

/** Bridge networks do not extend the launch registry. */
export type BridgeChainId = 8453 | 4663 | 5042;
export const BRIDGE_CHAINS = {
  8453: { name: "Base", key: "base", explorer: "https://basescan.org", symbol: "ETH", decimals: 18 },
  4663: { name: "Robinhood", key: "robinhood", explorer: "https://robinhoodchain.blockscout.com", symbol: "ETH", decimals: 18 },
  5042: { name: "Arc", key: "arc", explorer: "https://explorer.arc.io", symbol: "USDC", decimals: 18 },
} as const;
export const BRIDGE_CHAIN_IDS = [8453, 4663, 5042] as const;
// Arc's ERC-20 USDC interface shares the native balance, but has its own
// transfer semantics and SIX decimals. Never alias it to native zero-address USDC.
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
// Global Dollar (USDG) on Robinhood Chain: issued by Paxos, six decimals, the chain's main stablecoin and the launch
// form's default quote there (lib/launchpad/config.ts names the same contract). Robinhood USDC is still not offered.
// https://docs.paxos.com/guides/stablecoin/usdg/mainnet
export const ROBINHOOD_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export type BridgeAsset = "ETH" | "USDC" | "USDG";
export type BridgeCurrency = { address: Address; symbol: BridgeAsset; decimals: 6 | 18 };
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const native = (symbol: BridgeAsset): BridgeCurrency => ({ address: NATIVE_ADDRESS, symbol, decimals: 18 });
const token = (address: Address, symbol: BridgeAsset): BridgeCurrency => ({ address, symbol, decimals: 6 });
const bothWays = (currency: BridgeCurrency) => ({ input: currency, output: currency });
/**
 * Every asset the bridge moves, per chain, as the wallet sends it (input) and as it arrives (output). Only assets
 * whose identity has been independently verified belong here; a chain's first entry is listed first in its picker.
 * The two sides differ on Arc alone, where USDC is sent through its ERC-20 interface and arrives as the native balance.
 * A chain has at most one ERC-20 here: approvals are journaled per chain (approval.ts), so a second one needs that
 * journal to carry the token first.
 */
const CURRENCIES: Record<BridgeChainId, Partial<Record<BridgeAsset, { input: BridgeCurrency; output: BridgeCurrency }>>> = {
  8453: { ETH: bothWays(native("ETH")), USDC: bothWays(token(BASE_USDC, "USDC")) },
  4663: { ETH: bothWays(native("ETH")), USDG: bothWays(token(ROBINHOOD_USDG, "USDG")) },
  5042: { USDC: { input: token(ARC_USDC, "USDC"), output: native("USDC") } },
};
export const BRIDGE_ASSETS: Record<BridgeChainId, readonly BridgeAsset[]> = {
  8453: Object.keys(CURRENCIES[8453]) as BridgeAsset[],
  4663: Object.keys(CURRENCIES[4663]) as BridgeAsset[],
  5042: Object.keys(CURRENCIES[5042]) as BridgeAsset[],
};
/** What each asset is called in full, for pickers and screen readers. */
export const BRIDGE_ASSET_NAMES: Record<BridgeAsset, string> = { ETH: "Ether", USDC: "USD Coin", USDG: "Global Dollar" };
export function defaultBridgeAsset(chainId: BridgeChainId): BridgeAsset {
  return BRIDGE_CHAINS[chainId].symbol;
}
export function isBridgeAssetSupported(chainId: BridgeChainId, asset: unknown): asset is BridgeAsset {
  return typeof asset === "string" && BRIDGE_ASSETS[chainId].includes(asset as BridgeAsset);
}
export function bridgeCurrency(chainId: BridgeChainId, asset: BridgeAsset | undefined, side: "input" | "output"): BridgeCurrency {
  const symbol = asset ?? defaultBridgeAsset(chainId);
  const entry = isBridgeAssetSupported(chainId, symbol) ? CURRENCIES[chainId][symbol] : undefined;
  if (!entry) throw new Error("This token is not supported on this bridge network.");
  return { ...entry[side] };
}
/** The ERC-20 a chain's bridge can send (it needs an exact approval first), or null where every asset is native. */
export function bridgeTokenAsset(chainId: BridgeChainId): BridgeAsset | null {
  return BRIDGE_ASSETS[chainId].find((asset) => CURRENCIES[chainId][asset]!.input.address !== NATIVE_ADDRESS) ?? null;
}
/** USDC and USDG are both dollars: one unit of either is compared with one unit of the other. */
export function isDollarAsset(asset: BridgeAsset): boolean {
  return asset === "USDC" || asset === "USDG";
}

/** The original Arc journal recorded native (18-decimal) deposits, not ERC-20 units. */
export function bridgeTransferInputCurrency(transfer: { originChainId: BridgeChainId; originAsset?: BridgeAsset; depositKind?: "erc20" }): BridgeCurrency {
  if (transfer.originChainId === 5042 && transfer.originAsset === undefined && transfer.depositKind === undefined) {
    return { address: NATIVE_ADDRESS, symbol: "USDC", decimals: 18 };
  }
  return bridgeCurrency(transfer.originChainId, transfer.originAsset, "input");
}
export const BRIDGE_INPUT_CURRENCIES = {
  8453: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  4663: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  5042: { address: ARC_USDC, symbol: "USDC", decimals: 6 },
} as const;
export type BridgeApproval = { token: Address; spender: Address; amount: string };

export type BridgeQuoteRequest = {
  address: Address;
  originChainId: BridgeChainId;
  destinationChainId: BridgeChainId;
  originAsset?: BridgeAsset; // omitted only for legacy native/default requests
  destinationAsset?: BridgeAsset;
  amount: string; // input currency base units, never native-gas units for ERC-20s
};

export type BridgeQuote = BridgeQuoteRequest & {
  requestId: Hex;
  amountOut: string;
  minimumAmountOut: string;
  relayFee: string; // formatted in the source input currency
  sourceGas: string; // formatted in the source chain's native currency
  totalImpactPercent: string;
  approval?: BridgeApproval; // allowlisted USDC -> pinned Relay depository, exact amount only
  timeEstimate: number;
  expiresAt: number; // milliseconds, shortened from the provider's order deadline
  ttlMs: number; // remaining validity when issued; the browser anchors this on its own clock
  transaction: { to: Address; data: Hex; value: string; chainId: BridgeChainId };
};

/** Display-only costs from a verified quote that fails the unchanged 5% limit. */
export type BridgeQuoteRejection = BridgeQuoteRequest & {
  reason: "relay-fee" | "total-impact";
  relayFee: string; // source input currency, not native-gas units
  relayFeePercent: string; // percentage rounded up to six decimal places
  sourceGas: string; // source native currency, always 18 decimals
  totalImpactPercent: string;
};

/** Round upward so an actual fee just above 5% is never displayed as 5%. */
export function bridgeFeePercent(fee: bigint, amount: bigint): string {
  if (fee < 0n || amount <= 0n) throw new Error("Invalid bridge fee amounts.");
  const scaled = (fee * 100_000_000n + amount - 1n) / amount;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${scaled / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export type BridgeStatus = "waiting" | "depositing" | "pending" | "submitted" | "delayed" | "success" | "refund" | "failure";
export type BridgeStatusResponse = {
  status: BridgeStatus;
  inTxHashes: Hex[];
  txHashes: Hex[];
};

export function isBridgeChainId(value: unknown): value is BridgeChainId {
  return value === 8453 || value === 4663 || value === 5042;
}

