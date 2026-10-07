import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { getProfile, saveProfile } from "@/lib/profiles/server";
import { normalizeUsername } from "@/lib/profiles/validate";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" };

/** GET /api/profile?wallet=0x… | ?username=name → the public profile (404 when there is none). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const wallet = (u.searchParams.get("wallet") ?? "").toLowerCase();
  const username = normalizeUsername(u.searchParams.get("username"));
  if (!isAddress(wallet) && !/^[a-z0-9_]{1,20}$/.test(username)) return NextResponse.json({ error: "bad params" }, { status: 400 });
  try {
    const profile = await getProfile(isAddress(wallet) ? { wallet } : { username });
    if (!profile) return NextResponse.json({ error: "not found" }, { status: 404, headers: noStore });
    return NextResponse.json({ profile }, { headers: noStore });
  } catch (err) {
    console.error("[profile] read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load profile" }, { status: 502 });
  }
}

/** POST {chain, wallet, nonce, ts, signature, fields} → saves the signed profile; returns it and, with an X handle, a code to post. */
export async function POST(req: Request) {
  if (rateLimited(`profile:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  try {
    const r = await saveProfile({ chain: b.chain, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature, fields: (b.fields && typeof b.fields === "object" ? b.fields : {}) as Record<string, unknown> });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json(r, { headers: noStore });
  } catch (err) {
    console.error("[profile] save failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not save, try again" }, { status: 502 });
  }
}
