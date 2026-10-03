import { NextResponse } from "next/server";
import { visibleChainOr } from "@/lib/launchpad/config";
import { isFilter } from "@/lib/launchpad/search";
import { clampLimit } from "@/lib/launchpad/paging";
import { VOLUME_WINDOWS, getLaunchFeed, getLaunchTotals, getTrending, isTrendingSource, listLaunchesPage, parseSort, trendingFrom, type VolumeWindow } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { memo } from "@/lib/launchpad/memo";
import { listFeed } from "@/lib/launchpad/postsServer";
import { FEED_POSTS_LIMIT, feedPostsKey } from "@/lib/launchpad/posts-paging";

export const dynamic = "force-dynamic";

/** One request for everything live on a page (feed, totals, optional list). Polled every ~5s by LiveProvider. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sort = parseSort(u.searchParams.get("sort"), null);
  const winRaw = u.searchParams.get("window");
  const window = winRaw && VOLUME_WINDOWS.includes(winRaw as VolumeWindow) ? (winRaw as VolumeWindow) : "all";
  const c = u.searchParams.get("chain");
  const chain = visibleChainOr(c);
  const f = u.searchParams.get("filter");
  const filter = isFilter(f) ? f : null;
  const limit = clampLimit(u.searchParams.get("limit"), 40);
  try {
    const usd = await ethUsd();
    const listOpts = sort ? { sort, window, chain, filter, limit, offset: 0, ethUsd: usd } : null;
    // the home list's first page is the strip's candidate set: rank it instead of running the live query a second time;
    // any other view fetches the strip in the same batch as everything else
    const deriveTrending = listOpts !== null && isTrendingSource(listOpts);
    const [feed, totals, page, posts, fetchedTrending] = await Promise.all([
      memo("feed", 2_000, () => getLaunchFeed(24, usd)),
      memo("totals", 2_000, () => getLaunchTotals(usd)),
      listOpts ? memo(`list:${chain ?? "all"}:${sort}:${window}:${filter ?? "-"}:${limit}`, 2_000, () => listLaunchesPage(listOpts)) : Promise.resolve(null),
      memo(feedPostsKey(0), 2_000, () => listFeed(FEED_POSTS_LIMIT, 0)), // the same entry /api/posts?feed=1 serves
      deriveTrending ? Promise.resolve(null) : memo("trending", 2_000, () => getTrending(usd)),
    ]);
    const trending = fetchedTrending ?? trendingFrom(page?.items ?? []);
    return NextResponse.json({ at: Date.now(), feed, totals, ethUsd: usd, sort, window, chain, filter, limit, has_more: page?.hasMore ?? null, launches: page?.items ?? null, posts, trending }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[launch] live failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load live snapshot" }, { status: 502 });
  }
}
