import { formatUnits, type Address } from "viem";
import type { BridgeHistoryEntry } from "./history";
import { BRIDGE_ASSETS, BRIDGE_CHAIN_IDS, bridgeCurrency, bridgeCurrencyAsset, bridgesNativeCurrency, isDollarAsset, type BridgeAsset, type BridgeChainId, type BridgeDestinationId } from "./types";

/**
 * Bridge, then buy: the token page's way to fund a purchase from another network. Two separate steps by design (a
 * Relay destination call runs from Relay's contract, not the buyer's wallet, so an atomic bridge-and-buy would need its
 * own review). This file is the pure part: which bridge asset a buy pays with, where the wallet already holds funds,
 * which of those to suggest, and which recent transfer the trade panel should follow.
 */

/**
 * The bridge asset a buy pays with on `chainId`, or null when the bridge cannot deliver it (TWIG, GITLAWB, pairs, stocks,
 * and Elysium's HYPE).
 */
export function bridgeAssetForPay(chainId: BridgeDestinationId, pay: { address: Address; native: boolean }): BridgeAsset | null {
  // the native asset is whichever bridge asset arrives as the native balance: ETH on Base and Robinhood, USDC on Arc,
  // and nothing on Elysium, where HYPE is not bridged
  if (pay.native) return BRIDGE_ASSETS[chainId].find((asset) => /^0x0{40}$/.test(bridgeCurrency(chainId, asset, "output").address)) ?? null;
  return bridgeCurrencyAsset(chainId, pay.address)?.asset ?? null;
}

/**
 * `gas` is the chain's native balance, read only where the bridge does not carry the native currency (Elysium's HYPE),
 * since a token there can be sent only with some of it. Left out when that read fails.
 */
export type BridgeHolding = { chainId: BridgeChainId; asset: BridgeAsset; amount: bigint; decimals: 6 | 18; gas?: bigint };
export type HoldingReader = {
  native: (chainId: BridgeChainId, wallet: Address) => Promise<bigint>;
  token: (chainId: BridgeChainId, token: Address, wallet: Address) => Promise<bigint>;
};

/**
 * What the wallet holds of every bridge asset on every network but `destination`. Each read stands alone: a network
 * that does not answer is left out, never counted as empty and never allowed to fail the others.
 */
export async function readBridgeHoldings(read: HoldingReader, wallet: Address, destination: BridgeDestinationId): Promise<BridgeHolding[]> {
  const jobs: Promise<BridgeHolding | null>[] = [];
  for (const chainId of BRIDGE_CHAIN_IDS) {
    if (chainId === destination) continue;
    const gas = bridgesNativeCurrency(chainId) ? null : read.native(chainId, wallet).then((amount) => typeof amount === "bigint" && amount >= 0n ? amount : null, () => null);
    for (const asset of BRIDGE_ASSETS[chainId]) {
      const currency = bridgeCurrency(chainId, asset, "input");
      const native = /^0x0{40}$/.test(currency.address);
      jobs.push(Promise.all([native ? read.native(chainId, wallet) : read.token(chainId, currency.address, wallet), gas]).then(
        ([amount, gasAmount]) => typeof amount === "bigint" && amount >= 0n ? { chainId, asset, amount, decimals: currency.decimals, ...(typeof gasAmount === "bigint" ? { gas: gasAmount } : {}) } : null,
        () => null,
      ));
    }
  }
  return (await Promise.all(jobs)).filter((holding): holding is BridgeHolding => holding !== null);
}

/** Below this, a holding is dust: not worth a bridge fee, so never suggested. */
export const FUND_MIN_USD = 1;
/** The same floor for ETH when no ETH price is known. */
export const FUND_MIN_ETH = 0.0005;
const units = (holding: BridgeHolding) => Number(formatUnits(holding.amount, holding.decimals));

/**
 * The holding to suggest bridging from: the largest by dollar value, or, with no ETH price, the largest in the same kind
 * of asset as the buy (ETH for ETH, dollars for dollars). A token can only be sent where the wallet also has gas, so a
 * USDC holding counts only beside some ETH on its network, or some HYPE on Elysium; on Arc, USDC is the gas. Null when
 * nothing is worth moving.
 */
export function pickBridgeSource(holdings: readonly BridgeHolding[], destination: { chainId: BridgeDestinationId; asset: BridgeAsset }, ethUsd: number | null): BridgeHolding | null {
  const gas = new Map(holdings.filter((h) => h.asset === "ETH").map((h) => [h.chainId, h.amount]));
  const hasGas = (h: BridgeHolding) => bridgesNativeCurrency(h.chainId) ? h.asset === "ETH" || h.chainId === 5042 || (gas.get(h.chainId) ?? 0n) > 0n : (h.gas ?? 0n) > 0n;
  const sendable = holdings.filter((h) => h.chainId !== destination.chainId && h.amount > 0n && hasGas(h));
  const usd = (h: BridgeHolding) => isDollarAsset(h.asset) ? units(h) : ethUsd !== null && Number.isFinite(ethUsd) && ethUsd > 0 ? units(h) * ethUsd : null;
  const priced = sendable.map((h) => ({ h, usd: usd(h) }));
  if (ethUsd !== null && Number.isFinite(ethUsd) && ethUsd > 0) {
    return priced.filter((p) => p.usd !== null && p.usd >= FUND_MIN_USD).sort((a, b) => b.usd! - a.usd! || a.h.chainId - b.h.chainId)[0]?.h ?? null;
  }
  // no ETH price: compare like with like only, the buy's own kind first
  const worth = sendable.filter((h) => units(h) >= (isDollarAsset(h.asset) ? FUND_MIN_USD : FUND_MIN_ETH));
  const sameKind = worth.filter((h) => isDollarAsset(h.asset) === isDollarAsset(destination.asset));
  return (sameKind.length ? sameKind : worth).sort((a, b) => units(b) - units(a) || a.chainId - b.chainId)[0] ?? null;
}

/** Four decimals at most for a hint; dust reads as "<0.0001", never as 0. */
export function formatFundAmount(amount: bigint, decimals: number): string {
  const [whole, fraction = ""] = formatUnits(amount, decimals).split(".");
  const cut = fraction.slice(0, 4).replace(/0+$/, "");
  return whole === "0" && !cut && amount > 0n ? "<0.0001" : `${Number(whole).toLocaleString("en-US")}${cut ? `.${cut}` : ""}`;
}

/** How long a bridge to this network stays on the token page: long enough to come back to, short enough to stay relevant. */
export const FUND_FOLLOW_MS = 2 * 60 * 60_000;

/** The newest transfer into `destination` from the last two hours that the buyer has not dismissed, or null. */
export function followedBridge(rows: readonly BridgeHistoryEntry[], destination: BridgeDestinationId, now: number, dismissed: readonly string[]): BridgeHistoryEntry | null {
  const skip = new Set(dismissed.map((id) => id.toLowerCase()));
  return rows
    .filter((row) => row.destinationChainId === destination && !row.recipient && !skip.has(row.requestId.toLowerCase()) && row.createdAt <= now + 60_000 && now - row.createdAt <= FUND_FOLLOW_MS)
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export type FundStep = "short" | "moving" | "arrived" | "attention";

/** Where the two steps stand: no bridge yet, one on its way, one delivered (buy next), or one that needs a look. */
export function fundStep(row: Pick<BridgeHistoryEntry, "status"> | null): FundStep {
  if (!row) return "short";
  if (row.status === "success") return "arrived";
  if (row.status === "refund" || row.status === "failure" || row.status === "uncertain") return "attention";
  return "moving";
}
