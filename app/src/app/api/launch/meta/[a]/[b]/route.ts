import { NextResponse } from "next/server";
import { readMeta } from "@/lib/launchpad/meta";
import { isMetaKeyParam, isMetaTokenParam } from "@/lib/launchpad/metaShared";

export const dynamic = "force-dynamic";

/** GET /api/launch/meta/<launcher>/<meta_key> — the on-chain metadataURI form (stable while the salt search runs). */
export async function GET(_req: Request, ctx: { params: Promise<{ a: string; b: string }> }) {
  const { a, b } = await ctx.params;
  if (!isMetaTokenParam(a)) return NextResponse.json({ error: "bad launcher" }, { status: 400 });
  if (!isMetaKeyParam(b)) return NextResponse.json({ error: "bad key" }, { status: 400 });
  try {
    const m = await readMeta({ launcher: a, key: b });
    if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(m, { headers: { "cache-control": "public, max-age=300" } });
  } catch (err) {
    console.error("[launch] meta failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load metadata" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
