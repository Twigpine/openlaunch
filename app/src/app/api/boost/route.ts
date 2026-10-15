import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp } from "@/lib/profiles/http";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { BOOST_CHAIN } from "@/lib/launchpad/boost";
import { boostEnabled, getBoostLane, getTokenBoost } from "@/lib/launchpad/boostServer";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * GET /api/boost?chain=base → the Boosted lane (`{ enabled, window_h, floor_twig, items }`), or `{ enabled: false }`
 * while the BOOST switch is off. GET /api/boost?chain=base&token=0x… → one token's boost state (TWIG in the last 24
 * hours, its place in the lane, whether it is hidden). Boosts exist on Base only. Rate limited per IP.
 */
export async function GET(req: Request) {
  if (rateLimited(`boost:ip:${clientIp(req)}`, 60)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain") ?? BOOST_CHAIN;
  if (chain !== BOOST_CHAIN) return NextResponse.json({ error: "boosts are on Base only" }, { status: 400 });
  if (!boostEnabled()) return NextResponse.json({ enabled: false }, { headers: NO_STORE });
  const token = u.searchParams.get("token");
  try {
    if (token !== null) {
      if (!isAddress(token)) return NextResponse.json({ error: "bad token" }, { status: 400 });
      return NextResponse.json(await getTokenBoost(token), { headers: NO_STORE });
    }
    return NextResponse.json(await getBoostLane(await ethUsd()), { headers: NO_STORE });
  } catch (err) {
    console.error("[boost] read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load boosts" }, { status: 502 });
  }
}
