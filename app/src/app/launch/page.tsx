import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import LaunchForm from "@/components/launchpad/LaunchForm";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { gitlawbUsd } from "@/lib/launchpad/gitlawbServer";
import { DEFAULT_CHAIN, chainKeyOr, type ChainKey } from "@/lib/chainPublic";
import { CONFIGURED_CHAINS, launchpad } from "@/lib/launchpad/config";

export const metadata: Metadata = pageMetadata({
  path: "/launch",
  title: "Launch a token for free",
  description: "Deploy a token on Base, Robinhood Chain or Arc with 100% of supply locked as Uniswap v4 liquidity. No platform fee. Gas only.",
});

export const dynamic = "force-dynamic";

/** The requested chain, unless it has no contracts here: then the first configured one (the default in development, where none may be). */
function initialChainFor(param: string | undefined): ChainKey {
  const wanted = chainKeyOr(param, DEFAULT_CHAIN);
  return launchpad(wanted).configured ? wanted : (CONFIGURED_CHAINS[0] ?? wanted);
}

export default async function LaunchPage({ searchParams }: { searchParams: Promise<{ chain?: string }> }) {
  const sp = await searchParams;
  const [usd, gitlawb] = await Promise.all([ethUsd(), gitlawbUsd()]);
  return (
    <>
      <main className="relative mx-auto max-w-6xl px-4 pt-6 sm:pt-10 pb-16 space-y-5 sm:space-y-6">
        <header className="max-w-2xl">
          <h1 className="font-display font-bold tracking-[-0.02em] text-ink text-3xl sm:text-4xl">Launch a token</h1>
          <p className="mt-2 text-base text-body">Pick a chain, fill this in, sign once, done. No platform fee. You only pay gas.</p>
        </header>
        <LaunchForm ethUsd={usd} gitlawbUsd={gitlawb} initialChain={initialChainFor(sp.chain)} />
      </main>
    </>
  );
}
