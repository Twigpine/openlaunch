import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp } from "@/lib/profiles/http";
import { earnEnabled, earnInfo } from "@/lib/earn/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * GET /api/earn → `{ enabled: false }` while the EARN switch is off. On: the lending vault(s) the /me dashboard offers,
 * each with figures read from the chain (rate over the last 30 days, fees, size, and whether its live terms still match
 * the reviewed ones), or `snapshot: null` when the chain could not be read. Never a wallet's balances: the browser reads
 * those itself through /api/rpc. Rate limited per IP; the figures are memoised for 10 minutes.
 */
export async function GET(req: Request) {
  if (rateLimited(`earn:ip:${clientIp(req)}`, 60)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  if (!earnEnabled()) return NextResponse.json({ enabled: false }, { headers: NO_STORE });
  return NextResponse.json(await earnInfo(), { headers: NO_STORE });
}
