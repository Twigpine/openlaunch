import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { rateLimited } from "@/lib/launchpad/editServer";
import { adminWallets } from "@/lib/launchpad/postsServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { listProfilesForReview, moderateProfile } from "@/lib/profiles/server";

export const dynamic = "force-dynamic";

/** GET ?wallet=<admin> → X posts waiting for a person + the newest profiles. Everything listed is public anyway. */
export async function GET(req: Request) {
  const w = (new URL(req.url).searchParams.get("wallet") ?? "").toLowerCase();
  if (!isAddress(w) || !adminWallets().has(w)) return NextResponse.json({ error: "not an admin" }, { status: 403 });
  try {
    return NextResponse.json(await listProfilesForReview(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[profile] review list failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load" }, { status: 502 });
  }
}

/** POST {action, target, reason?, chain, wallet, nonce, ts, signature} → one admin-signed moderation action. */
export async function POST(req: Request) {
  if (rateLimited(`pmod:ip:${clientIp(req)}`, 60)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  try {
    const r = await moderateProfile({ action: b.action, target: b.target, reason: b.reason, chain: b.chain, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[profile] moderation failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not apply" }, { status: 502 });
  }
}
