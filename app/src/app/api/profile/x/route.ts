import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { verifyXPost } from "@/lib/profiles/server";

export const dynamic = "force-dynamic";

/**
 * POST {wallet, postUrl} → checks the post against the wallet's open code. No signature: the code was only ever
 * returned to the signer and is bound to the handle they signed, so a stranger submitting a link can at most finish
 * someone's own verification for them.
 */
export async function POST(req: Request) {
  if (rateLimited(`xverify:ip:${clientIp(req)}`, 30, 60 * 60_000)) return NextResponse.json({ error: "too many tries, wait a bit" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  try {
    const r = await verifyXPost({ wallet: b.wallet, postUrl: b.postUrl });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[profile] x verify failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not check the post, try again" }, { status: 502 });
  }
}
