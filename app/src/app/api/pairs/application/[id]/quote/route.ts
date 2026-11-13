import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { quoteFee } from "@/lib/launchpad/pairApplyServer";

export const dynamic = "force-dynamic";

/**
 * POST: the applicant signs to reserve a fee quote. Public application GET
 * exposes the existing quote; anyone may pay it, but only its applicant can renew it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (rateLimited(`pairs-quote:ip:${clientIp(req)}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const { id } = await ctx.params;
  const n = Number(id);
  if (!(Number.isSafeInteger(n) && n > 0)) return NextResponse.json({ error: "bad application" }, { status: 400 });
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const q = await quoteFee(n, body);
  if (q && "ok" in q) return NextResponse.json({ error: q.error }, { status: q.status });
  return NextResponse.json({ quote: q }, { headers: { "cache-control": "no-store" } });
}
