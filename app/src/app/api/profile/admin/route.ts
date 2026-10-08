import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { listProfilesForReview, moderateProfile } from "@/lib/profiles/server";

export const dynamic = "force-dynamic";

/**
 * POST {action, …signed} → one admin-signed request: action "list" returns the review queue (X posts waiting for a
 * person, with the code that was issued for each, and the newest profiles); any other action moderates one profile.
 * Approve / reject also carry `claim`: the code of the post the admin reviewed, signed with the action.
 */
export async function POST(req: Request) {
  if (rateLimited(`pmod:ip:${clientIp(req)}`, 60)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  try {
    if (b.action === "list") {
      const r = await listProfilesForReview({ chain: b.chain, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ pending: r.pending, recent: r.recent }, { headers: { "cache-control": "no-store" } });
    }
    const r = await moderateProfile({ action: b.action, target: b.target, reason: b.reason, claim: b.claim, chain: b.chain, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, row: r.row }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[profile] moderation failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not apply" }, { status: 502 });
  }
}
