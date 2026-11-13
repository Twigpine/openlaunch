import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp } from "@/lib/profiles/http";
import { requireAdmin } from "@/lib/admin/session";
import { isBoostStatsDays } from "@/lib/launchpad/boost";
import { getBoostStats } from "@/lib/launchpad/boostServer";

export const dynamic = "force-dynamic";

/**
 * GET /api/boost/stats?days=1|7|30 → the Boosted lane's views and clicks per token, with the TWIG burned for each in
 * the same period. Counts, nothing that names a person; an admin session only, like the reported posts queue.
 */
export async function GET(req: Request) {
  if (rateLimited(`boost-stats:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const a = await requireAdmin(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  const u = new URL(req.url);
  const days = Number(u.searchParams.get("days") ?? "7");
  if (!isBoostStatsDays(days)) return NextResponse.json({ error: "bad days" }, { status: 400 });
  try {
    return NextResponse.json({ days, ...(await getBoostStats(days)) }, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    console.error("[boost] stats read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load stats" }, { status: 502 });
  }
}
