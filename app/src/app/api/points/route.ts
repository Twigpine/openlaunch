import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { memo } from "@/lib/launchpad/memo";
import { publicSeason, seasonEnded, seasonFinal, walletPoints, walletReason } from "@/lib/points/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/points[?wallet=0x…] → the public season (null while it is not public) and, with a wallet, its points and
 * what stands between it and the board (reason null = it is eligible, or nothing it can do). `ended` is the clock;
 * `final` says the final standings are in (a compute covered the end), which can come later than the clock.
 */
export async function GET(req: Request) {
  const w = (new URL(req.url).searchParams.get("wallet") ?? "").toLowerCase();
  try {
    const season = await memo("points:public-season", 10_000, publicSeason);
    if (!season) return NextResponse.json({ season: null, me: null, reason: null }, { headers: { "cache-control": "no-store" } });
    const [me, raw] = isAddress(w) ? await Promise.all([memo(`points:me:${season.id}:${w}`, 10_000, () => walletPoints(season.id, w)), memo(`points:why:${w}`, 10_000, () => walletReason(w))]) : [null, null];
    // anyone can ask about any wallet: never say whether a moderator hid it or kept it off the boards
    const reason = raw === "kept_off" || raw === "hidden" ? null : raw;
    return NextResponse.json({ season: { name: season.name, starts_at: season.starts_at, ends_at: season.ends_at, ended: seasonEnded(season), final: seasonFinal(season) }, me, reason }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[points] read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load points" }, { status: 502 });
  }
}
