import { notFound, permanentRedirect, redirect } from "next/navigation";
import { isAddress } from "viem";
import { DEFAULT_CHAIN, isChainKey } from "@/lib/chainPublic";
import { findLaunchChain } from "@/lib/launchpad/queries";
import { hasChainPage } from "@/lib/launchpad/config";
import { chainLandingPath } from "@/lib/chainLanding";

export const dynamic = "force-dynamic";

/**
 * /t/<chain>            → /<chain>, the chain's landing page (308: search engines move any signal there);
 *                          404 while the chain has no contracts here, so no client caches a redirect to a 404
 * /t/<token> (legacy)   → /t/<chain>/<token> (looked up; Base by default)
 */
export default async function TokenOrChainPage({ params }: { params: Promise<{ chain: string }> }) {
  const { chain } = await params;
  if (isChainKey(chain)) {
    if (!hasChainPage(chain)) notFound();
    permanentRedirect(chainLandingPath(chain));
  }
  if (!isAddress(chain)) notFound();
  const found = (await findLaunchChain(chain)) ?? DEFAULT_CHAIN;
  redirect(`/t/${found}/${chain.toLowerCase()}`);
}
