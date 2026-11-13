import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { requireAdminAction } from "@/lib/admin/session";
import { reviewApplication } from "@/lib/launchpad/pairApplyServer";

export const dynamic = "force-dynamic";

/** POST {decision: approve|changes|reject, id, reason, wallet, nonce, ts, signature}: an admin decides a paid application. */
export async function POST(req: Request) {
  if (rateLimited(`pairs-review:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const a = await requireAdminAction(req, b.wallet);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  const r = await reviewApplication(b);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
