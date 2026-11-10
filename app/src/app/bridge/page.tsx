import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import BridgePageSlot from "@/components/bridge/BridgePageSlot";
import BridgeHistory from "@/components/bridge/BridgeHistory";
import { parseBridgeLink } from "@/lib/bridge/link";
import BridgePageLayout from "./BridgePageLayout";

/**
 * The bridge as a page: the same panel the header opens, with room for the facts beside it. The panel is rendered by
 * the header's one bridge controller into the slot below (components/bridge/bridge-slot.ts), so this page starts no
 * second copy. `?from=…&to=…&asset=…&toAsset=…` preselects a route (lib/bridge/link.ts) and nothing more.
 */
export const metadata: Metadata = pageMetadata({
  path: "/bridge",
  title: "Bridge",
  description: "Move ETH and dollars between Base, Robinhood Chain, Arc and Elysium, or fund them from Ethereum, Arbitrum and Optimism. Same wallet, no openlaunch fee.",
});

export default async function BridgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const link = parseBridgeLink(await searchParams);
  return (
    <BridgePageLayout
      panel={<BridgePageSlot link={link} />}
      history={<BridgeHistory />}
    />
  );
}
