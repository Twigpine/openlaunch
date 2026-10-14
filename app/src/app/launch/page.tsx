import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import LaunchForm from "@/components/launchpad/LaunchForm";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { gitlawbUsd } from "@/lib/launchpad/gitlawbServer";
import { DEFAULT_CHAIN, chainKeyOr, type ChainKey } from "@/lib/chainPublic";
import { CONFIGURED_CHAINS, launchpad } from "@/lib/launchpad/config";
import { getTranslations } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("launch");
  return pageMetadata({
    path: "/launch",
    title: t("page.title"),
    description: t("page.description"),
  });
}

export const dynamic = "force-dynamic";

/** The requested chain, unless it has no contracts here: then the first configured one (the default in development, where none may be). */
function initialChainFor(param: string | undefined): ChainKey {
  const wanted = chainKeyOr(param, DEFAULT_CHAIN);
  return launchpad(wanted).configured ? wanted : (CONFIGURED_CHAINS[0] ?? wanted);
}

export default async function LaunchPage({ searchParams }: { searchParams: Promise<{ chain?: string }> }) {
  const sp = await searchParams;
  const [usd, gitlawb, t] = await Promise.all([ethUsd(), gitlawbUsd(), getTranslations("launch")]);
  return (
    <>
      <main className="relative mx-auto max-w-6xl px-4 pt-6 sm:pt-10 pb-16 space-y-5 sm:space-y-6">
        <header className="max-w-2xl">
          <h1 className="font-display font-bold tracking-[-0.02em] text-ink text-3xl sm:text-4xl">{t("page.heading")}</h1>
          <p className="mt-2 text-base text-body">{t("page.intro")}</p>
        </header>
        <LaunchForm ethUsd={usd} gitlawbUsd={gitlawb} initialChain={initialChainFor(sp.chain)} />
      </main>
    </>
  );
}
