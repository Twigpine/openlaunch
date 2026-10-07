import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { verifyXPost } from "@/lib/profiles/server";

export const dynamic = "force-dynamic";

/**
 * POST {wallet, code, postUrl} → checks the post against the wallet's open code. No signature: the code was only
 * ever returned to the signer and is bound to the handle they signed; a request without the matching code does
 * nothing (no lookup, no rate-limit bucket, nothing said about the claim).
 */
export async function POST(req: Request) {
  if (rateLimited(`xverify:ip:${clientIp(req)}`, 30, 60 * 60_000)) return NextResponse.json({ error: "too many tries, wait a bit" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  try {
    const r = await verifyXPost({ wallet: b.wallet, postUrl: b.postUrl, code: b.code });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[profile] x verify failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not check the post, try again" }, { status: 502 });
  }
}
