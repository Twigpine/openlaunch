import { NextResponse } from "next/server";
import { listReported } from "@/lib/launchpad/postsServer";
import { requireAdmin } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

/** GET /api/posts/reported — the moderation queue (hidden posts included): an admin session only. */
export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  return NextResponse.json({ posts: await listReported() }, { headers: { "cache-control": "private, no-store" } });
}
