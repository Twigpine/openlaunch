import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { memo } from "@/lib/launchpad/memo";
import { currentSeason, walletPoints } from "@/lib/points/server";

export const dynamic = "force-dynamic";

/** GET /api/points[?wallet=0x…] → the public season (null while it is not public) and, with a wallet, its points. */
export async function GET(req: Request) {
  const w = (new URL(req.url).searchParams.get("wallet") ?? "").toLowerCase();
  try {
    const season = await memo("points:season", 10_000, currentSeason);
    if (!season?.public) return NextResponse.json({ season: null, me: null }, { headers: { "cache-control": "no-store" } });
    const me = isAddress(w) ? await memo(`points:me:${season.id}:${w}`, 10_000, () => walletPoints(season.id, w)) : null;
    return NextResponse.json({ season: { name: season.name, starts_at: season.starts_at, ends_at: season.ends_at }, me }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[points] read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load points" }, { status: 502 });
  }
}
