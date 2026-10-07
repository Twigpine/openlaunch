import type { Metadata } from "next";
import { cookies } from "next/headers";
import LaunchHero from "@/components/launchpad/LaunchHero";
import LaunchList from "@/components/launchpad/LaunchList";
import LiveRiver from "@/components/launchpad/LiveRiver";
import JustLaunched from "@/components/launchpad/JustLaunched";
import { PostsFeed } from "@/components/launchpad/Posts";
import { listFeed } from "@/lib/launchpad/postsServer";
import { VOLUME_WINDOWS, getLaunchFeed, getTrending, isTrendingSource, listLaunchesPage, parseSort, trendingFrom, withBoardTape, type VolumeWindow } from "@/lib/launchpad/queries";
import { JUST_LAUNCHED_SIZE, PAGE_SIZE } from "@/lib/launchpad/paging";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { LAUNCHPAD_CONFIGURED, visibleChainOr } from "@/lib/launchpad/config";
import { dbConfigured } from "@/lib/db";
import { isFilter } from "@/lib/launchpad/search";
import { nowMs } from "@/lib/launchpad/time";
import { feedKey, inRiverWindow, riverCoverage } from "@/lib/launchpad/river";
import TrendingStrip from "@/components/launchpad/TrendingStrip";
import LaunchPill from "@/components/launchpad/LaunchPill";
import WhyFree from "@/components/launchpad/WhyFree";
import { MagicCard } from "@/components/vendor/magic-card";
import { LAYOUT_COOKIE, parseLayout } from "@/lib/launchpad/list-layout";

export const dynamic = "force-dynamic";
// Title and description come from the root layout; ?sort= / ?chain= / ?window= / ?view= are all this one page.
export const metadata: Metadata = { alternates: { canonical: "/" } };

/** The river starts from the newest events (getLaunchFeed's ceiling) and keeps the ones from the last 30 minutes. */
const RIVER_SEED = 100;

export default async function Home({ searchParams }: { searchParams: Promise<{ sort?: string; window?: string; chain?: string; filter?: string; view?: string }> }) {
  const sp = await searchParams;
  const sort = parseSort(sp.sort, "live");
  const window: VolumeWindow = VOLUME_WINDOWS.includes(sp.window as VolumeWindow) ? (sp.window as VolumeWindow) : "all";
  const chain = visibleChainOr(sp.chain);
  const filter = isFilter(sp.filter) ? sp.filter : null;
  const usd = await ethUsd();
  const layout = parseLayout((await cookies()).get(LAYOUT_COOKIE)?.value);
  const listOpts = { sort, window, chain, filter, limit: PAGE_SIZE, ethUsd: usd };
  const [page, feed, fresh, posts, fetchedTrending] = await Promise.all([
    listLaunchesPage(listOpts),
    getLaunchFeed(RIVER_SEED, usd),
    listLaunchesPage({ sort: "new", limit: JUST_LAUNCHED_SIZE, ethUsd: usd }),
    listFeed(30),
    isTrendingSource(listOpts) ? null : getTrending(usd),
  ]);
  const trending = await withBoardTape(fetchedTrending ?? trendingFrom(page.items)); // the default view's first page doubles as the strip's candidates; the tapes are the cards' recent trades
  const now = nowMs();

  return (
    <>
      <main className="bb-mid bb-page relative space-y-6 pb-16 sm:space-y-8">
        <LaunchHero configured={LAUNCHPAD_CONFIGURED} />
        {/* what is hot first (names and numbers to act on), then the last half hour as it happens, then every launch */}
        <TrendingStrip initial={trending} serverNow={now} seenKeys={feed.filter((item) => item.kind === "swap").map(feedKey)} />
        <LiveRiver initial={feed.filter((item) => inRiverWindow(item, now))} recent={feed} serverNow={now} coveredSince={riverCoverage(feed, RIVER_SEED, now)} lastActivityAt={feed[0] ? new Date(feed[0].at).getTime() : 0} />
        <div className="grid items-start gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <MagicCard className="min-w-0 rounded-2xl"><LaunchList frame="rounded-[inherit]" initial={page.items} initialHasMore={page.hasMore} initialSort={sort} initialWindow={window} initialChain={chain} initialFilter={filter} initialView={sp.view === "watchlist" ? "watchlist" : "market"} initialLayout={layout} hasDb={dbConfigured()} serverNow={now} /></MagicCard>
          <aside aria-label="New launches and community" className="grid min-w-0 gap-4 md:grid-cols-2 xl:sticky xl:top-24 xl:grid-cols-1">
            <JustLaunched initial={fresh.items} serverNow={now} />
            <div className="min-w-0 space-y-4">
              <PostsFeed initial={posts} compact />
              <WhyFree />
            </div>
          </aside>
        </div>
      </main>
      {/* outside <main>: it is fixed to the screen, and as <main>'s last child it switched the spacing of the grid above it
          (space-y skips only the last child) every time it came or went, moving the page's height and the footer with it */}
      <LaunchPill />
    </>
  );
}
