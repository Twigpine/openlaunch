import { NextResponse } from "next/server";
import { DEFAULT_CHAIN, isChainKey } from "@/lib/chainPublic";
import { rateLimited } from "@/lib/launchpad/editServer";
import { applyLaunchTx, pollAll } from "@/lib/launchpad/indexer";
import { forgetBoostLane } from "@/lib/launchpad/boostServer";

export const dynamic = "force-dynamic";

/** POST /api/launch/sync?chain=base|robinhood|arc&tx=0x…  → apply one receipt now. No tx → poll every configured chain. */
export async function POST(req: Request) {
  // Unauthenticated and the most expensive route in the app (a tx-less call
  // fans out over every configured chain: log ranges, heals and backfills),
  // so it gets the same per-IP bucket as the other write endpoints.
  const ip = (req.headers.get("fly-client-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "0.0.0.0";
  if (rateLimited(`sync:ip:${ip}`, 10)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const u = new URL(req.url);
  const tx = u.searchParams.get("tx");
  const chain = u.searchParams.get("chain") ?? DEFAULT_CHAIN;
  if (tx) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return NextResponse.json({ error: "bad tx" }, { status: 400 });
    if (!isChainKey(chain)) return NextResponse.json({ error: "bad chain" }, { status: 400 });
    try {
      const r = await applyLaunchTx(chain, tx as `0x${string}`);
      // a boost just indexed: this machine's next lane read is fresh, so the booster sees their place at once
      if (r.boosts) forgetBoostLane();
      return NextResponse.json(r);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "sync failed" }, { status: 502 });
    }
  }
  try {
    return NextResponse.json(await pollAll());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "sync failed" }, { status: 502 });
  }
}
