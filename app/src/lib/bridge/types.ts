import type { Address, Hex } from "viem";

/**
 * Bridge networks do not extend the launch registry. Base, Robinhood Chain, Arc and Elysium are where tokens launch, so
 * funds move between them both ways. Ethereum, Arbitrum and Optimism are funding sources only: money arrives from them
 * and never leaves to them. `key` is Relay's protocol.v2 name for the chain, checked against GET /chains on every quote.
 * `symbol` is the chain's native gas currency, which is not always an asset the bridge carries (Elysium's HYPE).
 */
export type BridgeChainId = 8453 | 4663 | 5042 | 99901 | 1 | 42161 | 10;
export const BRIDGE_CHAINS = {
  8453: { name: "Base", key: "base", explorer: "https://basescan.org", symbol: "ETH", decimals: 18 },
  4663: { name: "Robinhood", key: "robinhood", explorer: "https://robinhoodchain.blockscout.com", symbol: "ETH", decimals: 18 },
  5042: { name: "Arc", key: "arc", explorer: "https://explorer.arc.io", symbol: "USDC", decimals: 18 },
  99901: { name: "Elysium", key: "elysium", explorer: "https://elysium.kinetiq.xyz/explorer", symbol: "HYPE", decimals: 18 },
  1: { name: "Ethereum", key: "ethereum", explorer: "https://etherscan.io", symbol: "ETH", decimals: 18 },
  42161: { name: "Arbitrum", key: "arbitrum", explorer: "https://arbiscan.io", symbol: "ETH", decimals: 18 },
  10: { name: "Optimism", key: "optimism", explorer: "https://optimistic.etherscan.io", symbol: "ETH", decimals: 18 },
} as const;
/** Networks a transfer can arrive on: the launch chains. */
export const BRIDGE_DESTINATION_IDS = [8453, 4663, 5042, 99901] as const;
/** Networks that only fund the launch chains. */
export const BRIDGE_FUNDING_IDS = [1, 42161, 10] as const;
/** Every network a transfer can leave from, in picker order. */
export const BRIDGE_CHAIN_IDS = [...BRIDGE_DESTINATION_IDS, ...BRIDGE_FUNDING_IDS] as const;
export type BridgeDestinationId = (typeof BRIDGE_DESTINATION_IDS)[number];
// Arc's ERC-20 USDC interface shares the native balance, but has its own
// transfer semantics and SIX decimals. Never alias it to native zero-address USDC.
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
// Global Dollar (USDG) on Robinhood Chain: issued by Paxos, six decimals, the chain's main stablecoin and the launch
// form's default quote there (lib/launchpad/config.ts names the same contract). Robinhood USDC is still not offered.
// https://docs.paxos.com/guides/stablecoin/usdg/mainnet
export const ROBINHOOD_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
// Circle's native USDC on the funding networks (symbol USDC, name "USD Coin", six decimals, checked on-chain).
// Never the bridged USDC.e that Arbitrum and Optimism also carry.
export const ETHEREUM_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
export const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
export const OPTIMISM_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as const;
// USDC on Elysium: the contract the launch form quotes there (lib/launchpad/config.ts), symbol and name USDC, six
// decimals, checked on-chain, and the one ERC-20 Relay lists as bridgeable on Elysium. Elysium has no Circle CCTP domain,
// so this USDC moves through Relay alone.
export const ELYSIUM_USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65" as const;
export type BridgeAsset = "ETH" | "USDC" | "USDG" | "HYPE";
export type BridgeSide = "input" | "output";
export type BridgeCurrency = { address: Address; symbol: BridgeAsset; decimals: 6 | 18 };
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const native = (symbol: BridgeAsset): BridgeCurrency => ({ address: NATIVE_ADDRESS, symbol, decimals: 18 });
const token = (address: Address, symbol: BridgeAsset): BridgeCurrency => ({ address, symbol, decimals: 6 });
const bothWays = (currency: BridgeCurrency) => ({ input: currency, output: currency });
/**
 * How an asset is sent (`input`) and how it arrives (`output`). An asset without an input can be received but never
 * sent. `refund` is the one currency a failed fill may refund in on the destination, when that is not the output itself.
 */
type BridgeEntry = { input?: BridgeCurrency; output: BridgeCurrency; refund?: BridgeCurrency };
/**
 * Every asset the bridge moves, per chain, as the wallet sends it (input) and as it arrives (output). Only assets
 * whose identity has been independently verified belong here; a chain's first entry is listed first in its picker.
 * The two sides differ on Arc, where USDC is sent through its ERC-20 interface and arrives as the native balance, and on
 * Elysium, where HYPE can only be received. Relay's solvers hold USDC there, not HYPE: they deliver HYPE by swapping
 * from Elysium USDC, so a failed fill refunds that USDC on Elysium (pinned here, and checked on every quote). Sending HYPE
 * goes through Relay's router with a swap call, not the depository deposit this bridge verifies, so it is never an input.
 * A chain has at most one ERC-20 to send: approvals are journaled per chain (approval.ts), so a second one needs that
 * journal to carry the token first.
 */
const CURRENCIES: Record<BridgeChainId, Partial<Record<BridgeAsset, BridgeEntry>>> = {
  8453: { ETH: bothWays(native("ETH")), USDC: bothWays(token(BASE_USDC, "USDC")) },
  4663: { ETH: bothWays(native("ETH")), USDG: bothWays(token(ROBINHOOD_USDG, "USDG")) },
  5042: { USDC: { input: token(ARC_USDC, "USDC"), output: native("USDC") } },
  99901: { USDC: bothWays(token(ELYSIUM_USDC, "USDC")), HYPE: { output: native("HYPE"), refund: token(ELYSIUM_USDC, "USDC") } },
  // funding networks: only the input side is ever used, since nothing is sent to them
  1: { ETH: bothWays(native("ETH")), USDC: bothWays(token(ETHEREUM_USDC, "USDC")) },
  42161: { ETH: bothWays(native("ETH")), USDC: bothWays(token(ARBITRUM_USDC, "USDC")) },
  10: { ETH: bothWays(native("ETH")), USDC: bothWays(token(OPTIMISM_USDC, "USDC")) },
};
const entries = (chainId: BridgeChainId) => Object.entries(CURRENCIES[chainId]) as [BridgeAsset, BridgeEntry][];
const assetsWith = (side: BridgeSide) => Object.fromEntries(BRIDGE_CHAIN_IDS.map((id) => [id, entries(id).filter(([, entry]) => entry[side]).map(([asset]) => asset)])) as unknown as Record<BridgeChainId, readonly BridgeAsset[]>;
/** What a wallet can send from each chain, in picker order. */
export const BRIDGE_SEND_ASSETS = assetsWith("input");
/** What can arrive on each chain, in picker order. Only the launch chains ever receive. */
export const BRIDGE_RECEIVE_ASSETS = assetsWith("output");
export const bridgeAssets = (chainId: BridgeChainId, side: BridgeSide) => (side === "input" ? BRIDGE_SEND_ASSETS : BRIDGE_RECEIVE_ASSETS)[chainId];
/** What each asset is called in full, for pickers and screen readers. */
export const BRIDGE_ASSET_NAMES: Record<BridgeAsset, string> = { ETH: "Ether", USDC: "USD Coin", USDG: "Global Dollar", HYPE: "Hyperliquid" };
/** A chain's first bridge asset, which it both sends and receives: its native currency where it sends it, otherwise its one token. */
export function defaultBridgeAsset(chainId: BridgeChainId): BridgeAsset {
  return BRIDGE_SEND_ASSETS[chainId][0];
}
/**
 * Whether Relay must bridge this chain's native currency itself: true wherever the bridge sends or receives it directly.
 * False on Elysium, where HYPE is only received, delivered through a swap from USDC (its refund), so Relay's listing of
 * that USDC is what the route depends on.
 */
export function bridgesNativeCurrency(chainId: BridgeChainId): boolean {
  return entries(chainId).some(([, entry]) => entry.input?.address === NATIVE_ADDRESS || (entry.output.address === NATIVE_ADDRESS && !entry.refund));
}
/** The ERC-20s a chain's routes depend on (sent, received or refunded), for checking Relay's own chain listing. */
export function bridgeTokens(chainId: BridgeChainId): BridgeCurrency[] {
  const seen = new Map<string, BridgeCurrency>();
  for (const [, entry] of entries(chainId)) for (const currency of [entry.input, entry.output, entry.refund]) {
    if (currency && currency.address !== NATIVE_ADDRESS) seen.set(currency.address.toLowerCase(), { ...currency });
  }
  return [...seen.values()];
}
/** Whether `asset` can be sent from (`input`) or received on (`output`) this chain. */
export function isBridgeAssetSupported(chainId: BridgeChainId, asset: unknown, side: BridgeSide): asset is BridgeAsset {
  return typeof asset === "string" && bridgeAssets(chainId, side).includes(asset as BridgeAsset);
}
export function bridgeCurrency(chainId: BridgeChainId, asset: BridgeAsset | undefined, side: BridgeSide): BridgeCurrency {
  const symbol = asset ?? defaultBridgeAsset(chainId);
  const currency = isBridgeAssetSupported(chainId, symbol, side) ? CURRENCIES[chainId][symbol]?.[side] : undefined;
  if (!currency) throw new Error("This token is not supported on this bridge network.");
  return { ...currency };
}
/** The currency a failed fill may refund in on the destination: the output itself, except where the registry pins another. */
export function bridgeDestinationRefund(chainId: BridgeChainId, asset: BridgeAsset | undefined): BridgeCurrency {
  const output = bridgeCurrency(chainId, asset, "output");
  const refund = CURRENCIES[chainId][output.symbol]?.refund;
  return refund ? { ...refund } : output;
}
/**
 * Which bridge asset a currency address is on `chainId`, from either side, with its decimals; null when the bridge
 * does not carry it. Used to read Relay's own records, which name currencies by address.
 */
export function bridgeCurrencyAsset(chainId: BridgeChainId, address: string): { asset: BridgeAsset; decimals: 6 | 18 } | null {
  const wanted = address.toLowerCase();
  for (const [asset, entry] of entries(chainId)) for (const currency of [entry.input, entry.output]) {
    if (currency && currency.address.toLowerCase() === wanted) return { asset, decimals: currency.decimals };
  }
  return null;
}
/** The ERC-20 a chain's bridge can send (it needs an exact approval first), or null where every asset is native. */
export function bridgeTokenAsset(chainId: BridgeChainId): BridgeAsset | null {
  return BRIDGE_SEND_ASSETS[chainId].find((asset) => CURRENCIES[chainId][asset]!.input!.address !== NATIVE_ADDRESS) ?? null;
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

/** Who carries a transfer. Omitted means Relay (every record written before Circle was added). */
export type BridgeProvider = "cctp";
export const BRIDGE_PROVIDER_NAMES = { relay: "Relay", cctp: "Circle" } as const;
export const bridgeProviderName = (provider: BridgeProvider | undefined) => BRIDGE_PROVIDER_NAMES[provider ?? "relay"];

export type BridgeQuote = BridgeQuoteRequest & {
  /** Circle's CCTP (lib/bridge/cctp.ts), or Relay when omitted. */
  provider?: BridgeProvider;
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
  return (BRIDGE_CHAIN_IDS as readonly unknown[]).includes(value);
}

/** Whether a transfer may arrive on this network. Funding networks never receive. */
export function isBridgeDestination(value: unknown): value is BridgeDestinationId {
  return (BRIDGE_DESTINATION_IDS as readonly unknown[]).includes(value);
}

/** Whether this network only funds the launch chains. */
export function isBridgeFundingChain(value: unknown): value is (typeof BRIDGE_FUNDING_IDS)[number] {
  return (BRIDGE_FUNDING_IDS as readonly unknown[]).includes(value);
}

