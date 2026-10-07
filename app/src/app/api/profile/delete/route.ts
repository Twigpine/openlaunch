import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { deleteProfile } from "@/lib/profiles/server";

export const dynamic = "force-dynamic";

/** POST {chain, wallet, nonce, ts, signature} → deletes the signer's profile (the username is held for them 30 days). */
export async function POST(req: Request) {
  if (rateLimited(`profile:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  try {
    const r = await deleteProfile({ chain: b.chain, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[profile] delete failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not delete, try again" }, { status: 502 });
  }
}
