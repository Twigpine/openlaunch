import { NextResponse } from "next/server";
import { clientIp, readJson } from "@/lib/http";
import { rateLimited } from "@/lib/launchpad/editServer";
import { moderate } from "@/lib/launchpad/postsServer";
import { adminFromRequest, fromAdminOrigin } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

/**
 * POST {action: hide|unhide|mute|unmute, target: post:<id> | token:<chain>:<addr>, wallet, nonce, ts, signature}. A token's
 * creator mutes their own token's thread with the signature alone; anything done as an admin also needs the admin
 * session of the same wallet (moderate checks it), sent from the site's own pages.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(`mod:ip:${ip}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req, 2_048);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  if (typeof b.wallet !== "string") return NextResponse.json({ error: "bad params" }, { status: 400 });
  let session: string | null;
  try {
    session = fromAdminOrigin(req) ? ((await adminFromRequest(req))?.wallet ?? null) : null;
  } catch {
    return NextResponse.json({ error: "admin check unavailable, try again" }, { status: 503 });
  }
  const r = await moderate({ action: b.action, target: b.target, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature }, session);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
