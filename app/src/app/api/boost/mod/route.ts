import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { requireAdminAction } from "@/lib/admin/session";
import { getBoostLane, moderateBoost } from "@/lib/launchpad/boostServer";
import { ethUsd } from "@/lib/launchpad/ethPrice";

export const dynamic = "force-dynamic";

/**
 * POST {action: hide|unhide, token, wallet, nonce, ts, signature}: an admin wallet keeps a Base token out of the Boosted
 * lane, or lets it back. A signed, single-use request, so its answer may carry the lane read fresh (both few-second
 * caches skipped): the panel shows the result at once, whichever machine its next read reaches. `lane` is null when
 * that read fails; the write itself has succeeded.
 */
export async function POST(req: Request) {
  if (rateLimited(`boost-mod:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const a = await requireAdminAction(req, b.wallet);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  const r = await moderateBoost({ action: b.action, token: b.token, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  const lane = await getBoostLane(await ethUsd(), { fresh: true }).catch((err) => {
    console.warn("[boost] fresh lane after moderation failed:", err instanceof Error ? err.message : err);
    return null;
  });
  return NextResponse.json({ ...r, lane });
}
