import { NextResponse } from "next/server";
import { chainKeyOr, isChainKey } from "@/lib/chainPublic";
import { readMeta } from "@/lib/launchpad/meta";
import { isMetaTokenParam } from "@/lib/launchpad/metaShared";

export const dynamic = "force-dynamic";

/** GET /api/launch/meta/<token> — token metadata JSON (image, description, links). */
export async function GET(_req: Request, ctx: { params: Promise<{ a: string }> }) {
  const { a } = await ctx.params;
  if (!isMetaTokenParam(a)) return NextResponse.json({ error: "bad token" }, { status: 400 });
  const c = new URL(_req.url).searchParams.get("chain");
  if (c !== null && !isChainKey(c)) return NextResponse.json({ error: "bad chain" }, { status: 400 });
  try {
    const m = await readMeta({ token: a, chain: chainKeyOr(c, null) ?? undefined });
    if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(m, { headers: { "cache-control": "public, max-age=300" } });
  } catch (err) {
    console.error("[launch] meta failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load metadata" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
