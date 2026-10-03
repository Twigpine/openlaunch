import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getWalletTokens, getWalletTrades, listLaunches } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { memo } from "@/lib/launchpad/memo";

export const dynamic = "force-dynamic";

/** GET /api/me?wallet=0x… → public, on-chain-derived view of one wallet: its launches, tokens traded, recent trades. */
export async function GET(req: Request) {
  const w = (new URL(req.url).searchParams.get("wallet") ?? "").toLowerCase();
  if (!isAddress(w)) return NextResponse.json({ error: "bad wallet" }, { status: 400 });
  try {
    const usd = await ethUsd();
    const data = await memo(`me:${w}`, 3_000, async () => {
      const [launches, tokens, trades] = await Promise.all([listLaunches({ launcher: w, limit: 200, ethUsd: usd }), getWalletTokens(w, usd), getWalletTrades(w, usd, 50)]);
      return { wallet: w, ethUsd: usd, launches, tokens, trades };
    });
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[me] wallet failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load wallet" }, { status: 502 });
  }
}
