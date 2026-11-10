import { BRIDGE_CHAINS, BRIDGE_CHAIN_IDS, isBridgeAssetSupported, isBridgeDestination, type BridgeAsset, type BridgeChainId } from "./types";

/**
 * Shareable bridge links: /bridge?from=arbitrum&to=base&asset=USDC&toAsset=USDC. A link only preselects a route. It
 * carries no amount and no address, and opening one never requests a quote signature or a wallet action.
 */
export type BridgeLink = { originChainId: BridgeChainId; destinationChainId: BridgeChainId; originAsset?: BridgeAsset; destinationAsset?: BridgeAsset };

const chainByKey = (key: string): BridgeChainId | null => BRIDGE_CHAIN_IDS.find((id) => BRIDGE_CHAINS[id].key === key) ?? null;

/**
 * Reads a link from the page's query. `to` is required and must be a launch chain; `from` defaults to Base (Ethereum
 * when Base is the destination). A link with any unknown, repeated or unsupported value is ignored whole, never
 * applied in part.
 */
export function parseBridgeLink(query: Record<string, string | string[] | undefined>): BridgeLink | null {
  const one = (name: string): string | null | undefined => {
    const value = query[name];
    return value === undefined ? undefined : typeof value === "string" ? value : null;
  };
  const [from, to, asset, toAsset] = [one("from"), one("to"), one("asset"), one("toAsset")];
  if (from === null || to === null || asset === null || toAsset === null || to === undefined) return null;
  const destinationChainId = chainByKey(to);
  if (destinationChainId === null || !isBridgeDestination(destinationChainId)) return null;
  const originChainId = from === undefined ? (destinationChainId === 8453 ? 1 : 8453) : chainByKey(from);
  if (originChainId === null || originChainId === destinationChainId) return null;
  if (asset !== undefined && !isBridgeAssetSupported(originChainId, asset)) return null;
  if (toAsset !== undefined && !isBridgeAssetSupported(destinationChainId, toAsset)) return null;
  return { originChainId, destinationChainId, ...(asset === undefined ? {} : { originAsset: asset }), ...(toAsset === undefined ? {} : { destinationAsset: toAsset }) };
}

/** The link for a route, for other pages to point at the bridge. */
export function bridgeLinkPath(link: BridgeLink): string {
  const query = new URLSearchParams({ from: BRIDGE_CHAINS[link.originChainId].key, to: BRIDGE_CHAINS[link.destinationChainId].key });
  if (link.originAsset) query.set("asset", link.originAsset);
  if (link.destinationAsset) query.set("toAsset", link.destinationAsset);
  return `/bridge?${query}`;
}

/** Stable identity of a link, so a page applies each one once. */
export function bridgeLinkKey(link: BridgeLink | null): string {
  return link ? `${link.originChainId}:${link.destinationChainId}:${link.originAsset ?? ""}:${link.destinationAsset ?? ""}` : "";
}
