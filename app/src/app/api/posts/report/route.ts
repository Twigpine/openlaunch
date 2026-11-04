import { NextResponse } from "next/server";
import { clientIp, readJson } from "@/lib/http";
import { rateLimited } from "@/lib/launchpad/editServer";
import { reportPost } from "@/lib/launchpad/postsServer";

export const dynamic = "force-dynamic";

/** POST {postId, wallet, reason, nonce, ts, signature} */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(`report:ip:${ip}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req, 2_048);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  if (typeof b.wallet !== "string") return NextResponse.json({ error: "bad params" }, { status: 400 });
  if (rateLimited(`report:wallet:${b.wallet.toLowerCase()}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const r = await reportPost({ postId: b.postId, wallet: b.wallet, reason: b.reason, nonce: b.nonce, ts: b.ts, signature: b.signature });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
