import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isChainKey } from "@/lib/chainPublic";
import { getHolderPanel } from "@/lib/launchpad/holdersServer";
import { memo } from "@/lib/launchpad/memo";

export const dynamic = "force-dynamic";

/** GET /api/launch/holders?chain=base&token=0x… → holder distribution + creator / sniper facts (5s memo). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain");
  const token = u.searchParams.get("token");
  if (!isChainKey(chain) || !token || !isAddress(token)) return NextResponse.json({ error: "bad params" }, { status: 400 });
  try {
    const panel = await memo(`holders:${chain}:${token.toLowerCase()}`, 5_000, () => getHolderPanel(chain, token));
    if (!panel) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(panel, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[launch] holders failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load holders" }, { status: 502 });
  }
}
