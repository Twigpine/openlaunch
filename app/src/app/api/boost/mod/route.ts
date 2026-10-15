import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { moderateBoost } from "@/lib/launchpad/boostServer";

export const dynamic = "force-dynamic";

/** POST {action: hide|unhide, token, wallet, nonce, ts, signature}: an admin wallet keeps a Base token out of the Boosted lane, or lets it back. */
export async function POST(req: Request) {
  if (rateLimited(`boost-mod:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const r = await moderateBoost({ action: b.action, token: b.token, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
