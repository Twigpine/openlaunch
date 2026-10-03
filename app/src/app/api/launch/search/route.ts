import { NextResponse } from "next/server";
import { isChainKey } from "@/lib/chainPublic";
import { searchLaunches } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";

export const dynamic = "force-dynamic";

/** GET /api/launch/search?q=&chain= → { q, launches } (name / symbol substring, or exact address). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").slice(0, 80);
  const c = u.searchParams.get("chain");
  try {
    const usd = await ethUsd();
    const launches = await searchLaunches(q, { chain: isChainKey(c) ? c : null, limit: 20, ethUsd: usd });
    return NextResponse.json({ q, launches }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[launch] search failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not search" }, { status: 502 });
  }
}
