import { NextResponse } from "next/server";
import { visibleChainOr } from "@/lib/launchpad/config";
import { isFilter } from "@/lib/launchpad/search";
import { clampLimit, clampOffset } from "@/lib/launchpad/paging";
import { VOLUME_WINDOWS, listLaunchesPage, parseSort, type VolumeWindow } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";

export const dynamic = "force-dynamic";

/** GET /api/launch/list?chain=base|robinhood|arc&sort=live|new|mcap|volume|gainers|holders&window=1h|24h|all&limit=50 — agent-friendly JSON ("trending" still accepted as an alias of live). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sort = parseSort(u.searchParams.get("sort"), "new");
  const window = (VOLUME_WINDOWS.includes((u.searchParams.get("window") ?? "") as VolumeWindow) ? u.searchParams.get("window") : "all") as VolumeWindow;
  const c = u.searchParams.get("chain");
  const chain = visibleChainOr(c);
  const f = u.searchParams.get("filter");
  const filter = isFilter(f) ? f : null;
  const limit = clampLimit(u.searchParams.get("limit"), 50);
  const offset = clampOffset(u.searchParams.get("offset"));
  try {
    const usd = await ethUsd();
    const page = await listLaunchesPage({ sort, window, chain, filter, limit, offset, ethUsd: usd });
    return NextResponse.json({ sort, window, chain, filter, limit, offset, has_more: page.hasMore, ethUsd: usd, launches: page.items }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[launch] list failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load list" }, { status: 502 });
  }
}
