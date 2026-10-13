import { NextResponse } from "next/server";
import { isChainKey } from "@/lib/chainPublic";
import { searchLaunches } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";

export const dynamic = "force-dynamic";

/**
 * GET /api/launch/search?q=&chain=&order= → { q, launches } (name / symbol substring, or exact address).
 * Relevance first; ties go newest-first, or to the most-held token with `order=holders` (the ⌘K search).
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").slice(0, 80);
  const c = u.searchParams.get("chain");
  const order = u.searchParams.get("order") === "holders" ? "holders" : "newest";
  try {
    const usd = await ethUsd();
    const launches = await searchLaunches(q, { chain: isChainKey(c) ? c : null, limit: 20, ethUsd: usd, order });
    return NextResponse.json({ q, launches }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[launch] search failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not search" }, { status: 502 });
  }
}
