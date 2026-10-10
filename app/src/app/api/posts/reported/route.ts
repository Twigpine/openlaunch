import { NextResponse } from "next/server";
import { adminWallets, listReported } from "@/lib/launchpad/postsServer";

export const dynamic = "force-dynamic";

/** GET /api/posts/reported?wallet= — the moderation queue. Reads are public data anyway; listed only for admin wallets to keep it out of casual view. */
export async function GET(req: Request) {
  const w = (new URL(req.url).searchParams.get("wallet") ?? "").toLowerCase();
  if (!adminWallets().has(w)) return NextResponse.json({ error: "admin only" }, { status: 403 });
  try {
    return NextResponse.json({ posts: await listReported() }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[posts] reported failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load reported posts" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
