import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp } from "@/lib/profiles/http";
import { fromAdminOrigin, issueAdminNonce } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" };

/**
 * POST → {nonce, issuedAt}: a server nonce for one admin sign-in message (single use, 5 minutes), with the server's
 * time for the message's Issued At (a device clock that is off cannot spoil the sign-in). Only from the site's pages.
 */
export async function POST(req: Request) {
  if (!fromAdminOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403, headers: NO_STORE });
  if (rateLimited(`admin-nonce:ip:${clientIp(req)}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429, headers: NO_STORE });
  try {
    const nonce = await issueAdminNonce();
    if (!nonce) return NextResponse.json({ error: "db unconfigured" }, { status: 503, headers: NO_STORE });
    return NextResponse.json({ nonce, issuedAt: new Date().toISOString() }, { headers: NO_STORE });
  } catch (err) {
    console.error("[admin] nonce failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not start a sign-in, try again" }, { status: 502, headers: NO_STORE });
  }
}
