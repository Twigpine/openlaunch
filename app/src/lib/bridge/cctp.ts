import { decodeEventLog, decodeFunctionData, encodeFunctionData, pad, type Address, type Hex } from "viem";
import { bridgeCurrency, defaultBridgeAsset, type BridgeAsset, type BridgeChainId, type BridgeQuoteRequest } from "./types";

/**
 * Circle's CCTP v2 as the bridge's second route, for USDC to USDC only. The wallet burns USDC on the source network
 * through Circle's TokenMessengerV2 with a Fast finality threshold and Circle's Forwarding Service hook, and Circle
 * mints the same USDC (less one fixed fee) to the same wallet on the destination. There is no second wallet step and
 * no gas is needed on the destination.
 *
 * Everything here is pinned and pure, shared by the server (which builds the quote) and the browser (which rebuilds
 * the exact calldata before the wallet is asked): no response from Circle ever chooses a contract, a recipient or a
 * hook. Facts checked on-chain on 2026-11-10: the two contracts below are deployed at these addresses on all five
 * networks, `localDomain()` returns the domains listed, and live forwarded burns carry exactly `CCTP_FORWARD_HOOK`
 * with a zero destination caller.
 * https://developers.circle.com/cctp/references/contract-addresses
 */
export const CCTP_TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as const;
export const CCTP_MESSAGE_TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as const;
/** Circle's domain for each network the bridge can burn on. Robinhood Chain has a domain (35) but no live USDC route. */
export const CCTP_DOMAINS = { 1: 0, 10: 2, 42161: 3, 8453: 6, 5042: 26 } as const;
export type CctpChainId = keyof typeof CCTP_DOMAINS;
/** Launch chains Circle can mint to. */
export const CCTP_DESTINATIONS = [8453, 5042] as const;
/** Fast Transfer: attested at soft finality (about 8 seconds on the rollups, 20 on Ethereum) for a small fee in basis points. */
export const CCTP_FAST_FINALITY = 1000;
/** Standard Transfer. Arc has no Fast Transfer as a source: its blocks are final in about half a second anyway. */
export const CCTP_STANDARD_FINALITY = 2000;
/** The finality a burn from this network asks for. */
export const cctpFinality = (originChainId: BridgeChainId) => originChainId === 5042 ? CCTP_STANDARD_FINALITY : CCTP_FAST_FINALITY;
/** "cctp-forward" right-padded to 32 bytes: version 0, no payload. Circle relays the mint to the recipient. */
export const CCTP_FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000" as const;
const ZERO_WORD = `0x${"0".repeat(64)}` as const;
/** Burns above this share of the amount are never offered: the same 5% ceiling as Relay's fee. */
export const CCTP_MAX_FEE_PERCENT = 5n;

export const CCTP_BURN_ABI = [{
  type: "function", name: "depositForBurnWithHook", stateMutability: "nonpayable",
  inputs: [
    { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" },
    { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" },
    { name: "minFinalityThreshold", type: "uint32" }, { name: "hookData", type: "bytes" },
  ],
  outputs: [],
}] as const;
export const CCTP_BURN_EVENT = [{
  type: "event", name: "DepositForBurn",
  inputs: [
    { name: "burnToken", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false },
    { name: "depositor", type: "address", indexed: true }, { name: "mintRecipient", type: "bytes32", indexed: false },
    { name: "destinationDomain", type: "uint32", indexed: false }, { name: "destinationTokenMessenger", type: "bytes32", indexed: false },
    { name: "destinationCaller", type: "bytes32", indexed: false }, { name: "maxFee", type: "uint256", indexed: false },
    { name: "minFinalityThreshold", type: "uint32", indexed: true }, { name: "hookData", type: "bytes", indexed: false },
  ],
}] as const;

type Route = Pick<BridgeQuoteRequest, "originChainId" | "destinationChainId" | "originAsset" | "destinationAsset">;
export type CctpRoute = { sourceDomain: number; destinationDomain: number; burnToken: Address; outputDecimals: 6 | 18; finality: number };

const isCctpChain = (chainId: BridgeChainId): chainId is CctpChainId => Object.hasOwn(CCTP_DOMAINS, chainId);
const asset = (chainId: BridgeChainId, value: BridgeAsset | undefined) => value ?? defaultBridgeAsset(chainId);

/** The CCTP leg for a USDC to USDC route between Circle networks, or null when Circle cannot carry it. */
export function cctpRoute(route: Route): CctpRoute | null {
  const { originChainId, destinationChainId } = route;
  if (originChainId === destinationChainId || !isCctpChain(originChainId) || !(CCTP_DESTINATIONS as readonly BridgeChainId[]).includes(destinationChainId)) return null;
  if (asset(originChainId, route.originAsset) !== "USDC" || asset(destinationChainId, route.destinationAsset) !== "USDC") return null;
  return {
    sourceDomain: CCTP_DOMAINS[originChainId],
    destinationDomain: CCTP_DOMAINS[destinationChainId as CctpChainId],
    burnToken: bridgeCurrency(originChainId, "USDC", "input").address,
    outputDecimals: bridgeCurrency(destinationChainId, "USDC", "output").decimals,
    finality: cctpFinality(originChainId),
  };
}

/** The one burn this bridge ever asks for: the exact amount, to the same wallet, at the source's finality, forwarded by Circle. */
export function cctpBurnData(request: Route & Pick<BridgeQuoteRequest, "address" | "amount">, maxFee: bigint): Hex {
  const route = cctpRoute(request);
  if (!route) throw new Error("Circle does not carry this route.");
  const amount = BigInt(request.amount);
  if (amount <= 0n || maxFee <= 0n || maxFee >= amount) throw new Error("Invalid Circle burn amounts.");
  return encodeFunctionData({
    abi: CCTP_BURN_ABI, functionName: "depositForBurnWithHook",
    args: [amount, route.destinationDomain, pad(request.address), route.burnToken, ZERO_WORD, maxFee, route.finality, CCTP_FORWARD_HOOK],
  });
}

/**
 * The fee a burn's calldata allows, when and only when that calldata is exactly the burn `cctpBurnData` builds for
 * this request (re-encoding also rejects trailing bytes). Null for anything else, including a fee at or above the
 * 5% ceiling.
 */
export function cctpBurnFee(data: unknown, request: Route & Pick<BridgeQuoteRequest, "address" | "amount">): bigint | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]+$/.test(data) || data.length > 2 + 2 * 420) return null;
  try {
    const { functionName, args } = decodeFunctionData({ abi: CCTP_BURN_ABI, data: data as Hex });
    if (functionName !== "depositForBurnWithHook") return null;
    const maxFee = args[5];
    if (maxFee * 100n > BigInt(request.amount) * CCTP_MAX_FEE_PERCENT) return null;
    return cctpBurnData(request, maxFee).toLowerCase() === data.toLowerCase() ? maxFee : null;
  } catch { return null; }
}

/**
 * What arrives, in the destination's output units (Arc's native balance has 18 decimals): the amount less the whole
 * fee. With forwarding, Circle executes the full maxFee (every live forwarded burn checked showed feeExecuted equal to
 * maxFee), so this is what the wallet receives, not a floor under it.
 */
export function cctpAmountOut(amount: bigint, maxFee: bigint, outputDecimals: 6 | 18): bigint {
  return (amount - maxFee) * 10n ** BigInt(outputDecimals - 6);
}

type Log = { address: Address; data: Hex; topics: readonly Hex[]; transactionHash?: Hex | null };
/**
 * Whether a source-chain log is this transfer's burn: Circle's own event, from the pinned messenger, with every field
 * the saved calldata set. Used to adopt a hash the wallet never returned, and for smart wallets that burn from an
 * inner call.
 */
export function isCctpBurnLog(log: Log, transfer: Route & Pick<BridgeQuoteRequest, "address" | "amount"> & { depositData?: Hex }): boolean {
  if (!transfer.depositData || log.address.toLowerCase() !== CCTP_TOKEN_MESSENGER.toLowerCase() || log.topics.length !== 4) return false;
  const maxFee = cctpBurnFee(transfer.depositData, transfer);
  const route = cctpRoute(transfer);
  if (maxFee === null || !route) return false;
  try {
    const { eventName, args } = decodeEventLog({ abi: CCTP_BURN_EVENT, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    return eventName === "DepositForBurn" && args.burnToken.toLowerCase() === route.burnToken.toLowerCase() && args.depositor.toLowerCase() === transfer.address.toLowerCase()
      && args.amount === BigInt(transfer.amount) && args.mintRecipient.toLowerCase() === pad(transfer.address).toLowerCase() && args.destinationDomain === route.destinationDomain
      && args.destinationCaller === ZERO_WORD && args.maxFee === maxFee && args.minFinalityThreshold === route.finality && args.hookData.toLowerCase() === CCTP_FORWARD_HOOK;
  } catch { return false; }
}
