import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { visibleChainOr } from "@/lib/launchpad/config";
import { isFilter } from "@/lib/launchpad/search";
import { clampLimit, clampOffset } from "@/lib/launchpad/paging";
import { VOLUME_WINDOWS, listLaunchesPage, parseSort, type VolumeWindow } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { MCAP_POLICY_VERSION, parseMcapMode } from "@/lib/launchpad/mcap-policy";

export const dynamic = "force-dynamic";

/**
 * GET /api/launch/list?chain=base|robinhood|arc&sort=live|new|mcap|volume|gainers|holders&window=1h|24h|all&limit=50
 * [&launcher=0x…] — agent-friendly JSON ("trending" still accepted as an alias of live). `launcher` keeps one wallet's
 * launches (the Boost picker's "Your launches"); anything that is not an address is ignored.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sort = parseSort(u.searchParams.get("sort"), "new");
  const mcap = parseMcapMode(u.searchParams.get("mcap"));
  const window = (VOLUME_WINDOWS.includes((u.searchParams.get("window") ?? "") as VolumeWindow) ? u.searchParams.get("window") : "all") as VolumeWindow;
  const c = u.searchParams.get("chain");
  const chain = visibleChainOr(c);
  const f = u.searchParams.get("filter");
  const filter = isFilter(f) ? f : null;
  const limit = clampLimit(u.searchParams.get("limit"), 50);
  const offset = clampOffset(u.searchParams.get("offset"));
  const l = u.searchParams.get("launcher");
  const launcher = l && isAddress(l) ? l.toLowerCase() : undefined;
  try {
    const usd = await ethUsd();
    const page = await listLaunchesPage({ sort, window, chain, filter, mcap, limit, offset, launcher, ethUsd: usd });
    return NextResponse.json({ sort, window, chain, filter, mcap, mcap_policy: MCAP_POLICY_VERSION, limit, offset, has_more: page.hasMore, ethUsd: usd, launches: page.items }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[launch] list failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load list" }, { status: 502 });
  }
}
