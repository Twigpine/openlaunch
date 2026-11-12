import { formatUnits, type Address } from "viem";
import { FUND_MIN_ETH, FUND_MIN_USD, readHoldingsOn, type BridgeHolding, type HoldingReader } from "./fund";
import { BRIDGE_SEND_ASSETS, bridgeCurrency, isDollarAsset, type BridgeAsset, type BridgeChainId } from "./types";

/**
 * From an exchange: the bridge panel's guide for funds that start in an exchange account. The exchange withdraws to the
 * connected wallet on a network the bridge already sends from, the guide watches that wallet's balances there, and once
 * the funds land it opens the bridge on that route. Every route it can open is one the bridge already checks; nothing
 * here signs or sends.
 *
 * Relay's deposit addresses (send to an address, the transfer starts by itself) were looked at for this and are not
 * used: the address cannot be tied to the order it claims to serve. See docs/bridge.md, "From an exchange".
 */

/**
 * Where a withdrawal can land: the networks the bridge sends ETH and USDC from. Base comes first because it is also a
 * launch chain, so funds that land there need no bridge when Base is where they are wanted.
 */
export const EXCHANGE_NETWORKS = [8453, 1, 42161, 10] as const satisfies readonly BridgeChainId[];
export type ExchangeNetworkId = (typeof EXCHANGE_NETWORKS)[number];
/** How often the balances are read while the guide is open. */
export const EXCHANGE_POLL_MS = 15_000;
/** How long a watch is kept in this tab: long enough to close the panel and come back. */
export const EXCHANGE_WATCH_MS = 2 * 60 * 60_000;
export const EXCHANGE_OPEN_KEY = "openlaunch.bridge.exchange.open";
export const EXCHANGE_WATCH_KEY = "openlaunch.bridge.exchange.watch";

export const isExchangeNetwork = (chainId: unknown): chainId is ExchangeNetworkId => (EXCHANGE_NETWORKS as readonly unknown[]).includes(chainId);
const isNative = (chainId: BridgeChainId, asset: BridgeAsset) => /^0x0{40}$/.test(bridgeCurrency(chainId, asset, "input").address);
const holdingKey = (holding: { chainId: BridgeChainId; asset: BridgeAsset }) => `${holding.chainId}:${holding.asset}`;

/** What the wallet holds of each sendable asset on the exchange networks. A network that does not answer is left out. */
export function readExchangeHoldings(read: HoldingReader, wallet: Address): Promise<BridgeHolding[]> {
  return readHoldingsOn(read, wallet, EXCHANGE_NETWORKS);
}

/**
 * The lowest balance seen per network and asset since the watch began. Arrivals are measured from it: a balance first
 * read now starts at what it holds now, so funds already there never count as arriving, and a balance that drops (spent
 * on gas, or bridged away) lowers it, so the next withdrawal is measured from where the wallet really stands.
 */
export type ExchangeBaseline = Readonly<Record<string, bigint>>;
export function nextExchangeBaseline(baseline: ExchangeBaseline, holdings: readonly BridgeHolding[]): ExchangeBaseline {
  const next: Record<string, bigint> = { ...baseline };
  for (const holding of holdings) {
    const key = holdingKey(holding);
    const seen = next[key];
    next[key] = seen !== undefined && seen < holding.amount ? seen : holding.amount;
  }
  return next;
}

/**
 * Funds that landed since the watch began. `gas` is the ETH on that network beside a token arrival, since a token can
 * be sent on only with some; null for ETH itself, or when that read failed.
 */
export type ExchangeArrival = { chainId: ExchangeNetworkId; asset: BridgeAsset; amount: bigint; decimals: 6 | 18; gas: bigint | null };

/**
 * Each rise above the baseline worth a bridge fee (the trade panel's dust floors), in network order, a token before the
 * ETH that landed beside it: that ETH is most likely its gas.
 */
export function findExchangeArrivals(baseline: ExchangeBaseline, holdings: readonly BridgeHolding[]): ExchangeArrival[] {
  const gas = new Map(holdings.filter((h) => isNative(h.chainId, h.asset)).map((h) => [h.chainId, h.amount]));
  const order = (h: { chainId: BridgeChainId; asset: BridgeAsset }) => EXCHANGE_NETWORKS.indexOf(h.chainId as ExchangeNetworkId) * 10 + (isNative(h.chainId, h.asset) ? 9 : BRIDGE_SEND_ASSETS[h.chainId].indexOf(h.asset));
  const arrivals: ExchangeArrival[] = [];
  for (const holding of holdings) {
    const { chainId } = holding;
    if (!isExchangeNetwork(chainId)) continue;
    const before = baseline[holdingKey(holding)];
    if (before === undefined || holding.amount <= before) continue;
    const amount = holding.amount - before;
    if (Number(formatUnits(amount, holding.decimals)) < (isDollarAsset(holding.asset) ? FUND_MIN_USD : FUND_MIN_ETH)) continue;
    arrivals.push({ chainId, asset: holding.asset, amount, decimals: holding.decimals, gas: isNative(chainId, holding.asset) ? null : gas.get(chainId) ?? null });
  }
  return arrivals.sort((a, b) => order(a) - order(b));
}

/** A token landed where the wallet has no ETH to pay for sending it on. */
export const exchangeNeedsGas = (arrival: ExchangeArrival) => arrival.gas === 0n;

/**
 * What to do with an arrival: nothing when it landed on the network it is wanted on, else bridge from there. A token
 * arrival fills in its amount; ETH is left for the sender to choose, since some of it pays the gas.
 */
export type ExchangeNext = { kind: "ready" } | { kind: "bridge"; originChainId: ExchangeNetworkId; originAsset: BridgeAsset; amount: string };
export function exchangeNext(arrival: ExchangeArrival, destinationChainId: BridgeChainId): ExchangeNext {
  if (arrival.chainId === destinationChainId) return { kind: "ready" };
  return { kind: "bridge", originChainId: arrival.chainId, originAsset: arrival.asset, amount: isNative(arrival.chainId, arrival.asset) ? "" : formatUnits(arrival.amount, arrival.decimals) };
}

/** A watch as kept in this tab's session storage, so closing the panel does not lose what was already there. */
export type ExchangeWatch = { wallet: string; startedAt: number; baseline: ExchangeBaseline };

export function serializeExchangeWatch(watch: ExchangeWatch): string {
  return JSON.stringify({ wallet: watch.wallet, startedAt: watch.startedAt, baseline: Object.fromEntries(Object.entries(watch.baseline).map(([key, value]) => [key, value.toString()])) });
}

/** The saved watch for `wallet`, or null when there is none, it is someone else's, it is too old, or it does not parse. */
export function parseExchangeWatch(raw: string | null, wallet: string, now: number): ExchangeWatch | null {
  if (!raw || !wallet) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { wallet: owner, startedAt, baseline } = value as Record<string, unknown>;
    if (typeof owner !== "string" || owner !== wallet.toLowerCase()) return null;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt > now + 60_000 || now - startedAt > EXCHANGE_WATCH_MS) return null;
    if (!baseline || typeof baseline !== "object") return null;
    const parsed: Record<string, bigint> = {};
    for (const [key, amount] of Object.entries(baseline)) {
      const [chain, asset] = key.split(":");
      const chainId = Number(chain);
      if (!isExchangeNetwork(chainId) || !(BRIDGE_SEND_ASSETS[chainId] as readonly string[]).includes(asset) || typeof amount !== "string" || !/^\d{1,78}$/.test(amount)) return null;
      parsed[key] = BigInt(amount);
    }
    return { wallet: owner, startedAt, baseline: parsed };
  } catch { return null; }
}

/** Whether the guide was left open in this tab recently enough to reopen on it. */
export function exchangeGuideOpen(raw: string | null, now: number): boolean {
  const openedAt = Number(raw);
  return raw !== null && Number.isFinite(openedAt) && openedAt <= now + 60_000 && now - openedAt <= EXCHANGE_WATCH_MS;
}
