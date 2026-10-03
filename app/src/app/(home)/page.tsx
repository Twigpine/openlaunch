import type { Metadata } from "next";
import Link from "next/link";
import LaunchHero from "@/components/launchpad/LaunchHero";
import LaunchList from "@/components/launchpad/LaunchList";
import LaunchTape from "@/components/launchpad/LaunchTape";
import { PostsFeed } from "@/components/launchpad/Posts";
import { listFeed } from "@/lib/launchpad/postsServer";
import { VOLUME_WINDOWS, getLaunchFeed, getTrending, isTrendingSource, listLaunchesPage, parseSort, trendingFrom, type VolumeWindow } from "@/lib/launchpad/queries";
import { PAGE_SIZE } from "@/lib/launchpad/paging";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { LAUNCHPAD_CONFIGURED, visibleChainOr } from "@/lib/launchpad/config";
import { dbConfigured } from "@/lib/db";
import { isFilter } from "@/lib/launchpad/search";
import TrendingStrip from "@/components/launchpad/TrendingStrip";

export const dynamic = "force-dynamic";
// Title and description come from the root layout; ?sort= / ?chain= / ?window= views are all this one page.
export const metadata: Metadata = { alternates: { canonical: "/" } };

export default async function Home({ searchParams }: { searchParams: Promise<{ sort?: string; window?: string; chain?: string; filter?: string }> }) {
  const sp = await searchParams;
  const sort = parseSort(sp.sort, "live");
  const window: VolumeWindow = VOLUME_WINDOWS.includes(sp.window as VolumeWindow) ? (sp.window as VolumeWindow) : "all";
  const chain = visibleChainOr(sp.chain);
  const filter = isFilter(sp.filter) ? sp.filter : null;
  const usd = await ethUsd();
  const listOpts = { sort, window, chain, filter, limit: PAGE_SIZE, ethUsd: usd };
  const [page, feed, posts, fetchedTrending] = await Promise.all([listLaunchesPage(listOpts), getLaunchFeed(24, usd), listFeed(30), isTrendingSource(listOpts) ? null : getTrending(usd)]);
  const trending = fetchedTrending ?? trendingFrom(page.items); // the default view's first page doubles as the strip's candidates

  return (
    <>
      <main className="relative mx-auto max-w-6xl px-4 pb-16 space-y-8">
        <LaunchHero configured={LAUNCHPAD_CONFIGURED} />
        <TrendingStrip initial={trending} />
        <div className="grid xl:grid-cols-[minmax(0,1fr)_17rem] gap-6 items-start">
          <LaunchList initial={page.items} initialHasMore={page.hasMore} initialSort={sort} initialWindow={window} initialChain={chain} initialFilter={filter} hasDb={dbConfigured()} />
          <aside aria-label="Launchpad activity and information" className="grid min-w-0 gap-4 md:grid-cols-2 xl:sticky xl:top-24 xl:grid-cols-1">
            <LaunchTape initial={feed} />
            <div className="min-w-0 space-y-4">
              <PostsFeed initial={posts} compact />
              <section aria-labelledby="free-heading" className="rounded-2xl border border-line bg-paper p-4">
                <h2 id="free-heading" className="text-sm font-semibold text-ink">Why it&apos;s free</h2>
                <p className="mt-2 text-pretty text-xs leading-relaxed text-muted">No fee address in the factory. No platform cut in the locker. On every chain.</p>
                <dl className="mt-4 divide-y divide-line border-y border-line text-xs">
                  <div className="flex items-center justify-between gap-3 py-2.5"><dt className="text-muted">Platform fee</dt><dd className="font-mono font-bold text-up tnum">$0</dd></div>
                  <div className="flex items-center justify-between gap-3 py-2.5"><dt className="text-muted">Trading fee</dt><dd className="font-mono text-ink tnum">0 / 1 / 3%</dd></div>
                </dl>
                <p className="mt-3 text-pretty text-[11px] leading-relaxed text-muted">Creators choose the trading fee. It goes in full to their beneficiaries, or is burned.</p>
                <a href="https://github.com/Gitlawb/openlaunch/tree/main/contracts/src" target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-8 items-center text-xs font-medium text-body underline decoration-line-strong underline-offset-4 hover:text-ink">Read the contracts ↗</a>
                <div className="mt-3 border-t border-line pt-3"><Link href="/agents" className="inline-flex min-h-8 items-center text-xs font-medium text-brand hover:underline underline-offset-4">Agents can launch too →</Link></div>
              </section>
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
