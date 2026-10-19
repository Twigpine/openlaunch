import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { requireAdminAction } from "@/lib/admin/session";
import { moderatePair } from "@/lib/launchpad/pairsServer";

export const dynamic = "force-dynamic";

/**
 * POST {action: list|update|suspend|delist|reinstate, chain, address, wallet, nonce, ts, signature, …listing | reason}:
 * an admin wallet lists a community pair, changes its listing, or moves its status. A signed, single-use request; the
 * answer carries the pair as it is now (null after a delisting that left no listed row to show).
 */
export async function POST(req: Request) {
  if (rateLimited(`pairs-mod:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const a = await requireAdminAction(req, b.wallet);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  const r = await moderatePair(b);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}
