import { NextResponse } from "next/server";
import { getApplication } from "@/lib/launchpad/pairApplyServer";

export const dynamic = "force-dynamic";

/** GET: one application, its burns and its live fee quote (if one is locked). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const a = await getApplication(Number(id));
  if (!a) return NextResponse.json({ error: "no such application" }, { status: 404 });
  return NextResponse.json(a, { headers: { "cache-control": "no-store" } });
}
