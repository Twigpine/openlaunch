import { clientIp, readBody } from "@/lib/profiles/http";
import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { reportPost } from "@/lib/launchpad/postsServer";

export const dynamic = "force-dynamic";

/** POST {postId, wallet, reason, nonce, ts, signature} */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(`report:ip:${ip}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  // Smart-wallet signatures can include ERC-6492 deployment calldata.
  const raw = await readBody(req, 256 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.reason === "too_large" ? "body too large" : "bad json" }, { status: raw.reason === "too_large" ? 413 : 400 });
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(new TextDecoder().decode(raw.bytes)) as Record<string, unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b)) return NextResponse.json({ error: "bad json" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof b.wallet !== "string") return NextResponse.json({ error: "bad params" }, { status: 400 });
  const r = await reportPost({ postId: b.postId, wallet: b.wallet, reason: b.reason, nonce: b.nonce, ts: b.ts, signature: b.signature });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
