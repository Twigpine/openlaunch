import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp } from "@/lib/profiles/http";
import { quoteFee } from "@/lib/launchpad/pairApplyServer";

export const dynamic = "force-dynamic";

/**
 * POST: lock the fee's TWIG amount for an unpaid application for 30 minutes (a lock still running is returned, never
 * replaced, so nobody can move an applicant's price under them).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (rateLimited(`pairs-quote:ip:${clientIp(req)}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const { id } = await ctx.params;
  const n = Number(id);
  if (!(Number.isSafeInteger(n) && n > 0)) return NextResponse.json({ error: "bad application" }, { status: 400 });
  const q = await quoteFee(n);
  if (q && "ok" in q) return NextResponse.json({ error: q.error }, { status: q.status });
  return NextResponse.json({ quote: q }, { headers: { "cache-control": "no-store" } });
}
