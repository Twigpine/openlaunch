import { notFound } from "next/navigation";
import { isAddress } from "viem";
import { isChainKey } from "@/lib/chainPublic";
import { isKnownLaunchRoute } from "@/lib/launchpad/launch-recovery";

export const dynamic = "force-dynamic";

/**
 * Existence gate for the token route. The page sits under a loading boundary, so by the time it
 * calls notFound() the streamed shell has already gone out with a 200. A layout renders before that
 * boundary, so a miss here is a real HTTP 404 (search engines drop the URL; the site 404 page shows).
 */
export default async function TokenLayout({ params, children }: { params: Promise<{ chain: string; token: string }>; children: React.ReactNode }) {
  const { chain, token } = await params;
  if (!isChainKey(chain) || !isAddress(token)) notFound();
  // Do not cache a miss: receipt ingestion/reinclusion can make this route ready immediately.
  if (!await isKnownLaunchRoute(chain, token)) notFound();
  return children;
}
