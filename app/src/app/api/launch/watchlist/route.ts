import { NextResponse } from "next/server";
import { dbConfigured } from "@/lib/db";
import { rateLimited } from "@/lib/launchpad/editServer";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { WatchlistInputError, getWatchlistData, parseWatchlistRequest, readWatchlistBody } from "@/lib/launchpad/watchlistData";

export const dynamic = "force-dynamic";

/** Read-only POST keeps the user's device-local token list out of URLs. Nothing is persisted. */
export async function POST(req: Request) {
  const headers = { "cache-control": "no-store" };
  const ip = (req.headers.get("fly-client-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "0.0.0.0";
  if (rateLimited(`watchlist:ip:${ip}`, 60)) {
    return NextResponse.json({ error: "Too many refreshes. Try again shortly." }, { status: 429, headers: { ...headers, "retry-after": "60" } });
  }
  try {
    const body = await readWatchlistBody(req);
    const at = Date.now();
    const items = parseWatchlistRequest(body, at);
    if (!dbConfigured()) return NextResponse.json({ error: "Watchlist activity is unavailable.", indexed: false }, { status: 503, headers });
    const data = await getWatchlistData(items, at, items.length ? await ethUsd() : null);
    return NextResponse.json(data, { status: data.indexed ? 200 : 503, headers });
  } catch (error) {
    if (error instanceof WatchlistInputError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    return NextResponse.json({ error: "Watchlist activity could not be refreshed. Your saved tokens are unchanged.", indexed: false }, { status: 503, headers });
  }
}
