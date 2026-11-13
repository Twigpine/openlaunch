import { clientIp } from "@/lib/http";
import { NextResponse } from "next/server";
import { DEFAULT_CHAIN, isChainKey } from "@/lib/chainPublic";
import { rateLimited } from "@/lib/launchpad/editServer";
import { applyLaunchTx } from "@/lib/launchpad/indexer";
import { IndexLockBusyError } from "@/lib/launchpad/indexer-lock";
import { forgetBoostLane } from "@/lib/launchpad/boostServer";
import { redactUrls } from "@/lib/launchpad/redact";

export const dynamic = "force-dynamic";

/** POST /api/launch/sync?chain=base|robinhood|arc|elysium&tx=0x… → apply one receipt. Full polling belongs to the server loop. */
export async function POST(req: Request) {
  // A caller may request its receipt, but cannot trigger a full multi-chain scan.
  const ip = clientIp(req);
  if (rateLimited(`sync:ip:${ip}`, 10)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const u = new URL(req.url);
  const tx = u.searchParams.get("tx");
  const chain = u.searchParams.get("chain") ?? DEFAULT_CHAIN;
  if (tx && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
    if (!isChainKey(chain)) return NextResponse.json({ error: "bad chain" }, { status: 400 });
    try {
      const r = await applyLaunchTx(chain, tx as `0x${string}`);
      // a boost just indexed: this machine's next lane read is fresh, so the booster sees their place at once
      if (r.boosts) forgetBoostLane();
      return NextResponse.json(r);
    } catch (error) {
      if (error instanceof IndexLockBusyError) return NextResponse.json({ status: "pending" }, { status: 202, headers: { "Retry-After": "2", "Cache-Control": "no-store" } });
      console.warn("[launch-sync] receipt apply failed:", redactUrls(error instanceof Error ? error.message : String(error)));
      return NextResponse.json({ error: "sync failed" }, { status: 502 });
    }
  }
  return NextResponse.json({ error: "bad tx" }, { status: 400 });
}
