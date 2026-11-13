import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { applicantAction } from "@/lib/launchpad/pairApplyServer";

export const dynamic = "force-dynamic";

/** POST {action: apply|proof|again, chain, address, wallet, nonce, ts, signature, …}: the applicant's signed actions (pairApplyServer.ts). */
export async function POST(req: Request) {
  if (rateLimited(`pairs-apply:ip:${clientIp(req)}`, 10)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const r = await applicantAction(b);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
