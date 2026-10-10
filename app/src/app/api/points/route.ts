import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { rateLimited } from "@/lib/launchpad/editServer";
import { memo } from "@/lib/launchpad/memo";
import { clientIp } from "@/lib/profiles/http";
import { publicSeason, seasonEnded, seasonFinal, walletPoints, walletReason } from "@/lib/points/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/points[?wallet=0x…] → the public season (null while it is not public) and, with a wallet, its points and
 * what stands between it and the board (reason null = it is eligible, or nothing it can do). `ended` is the clock;
 * `final` says the final standings are in (a compute covered the end), which can come later than the clock. A wallet
 * lookup is two indexed reads, rate limited per IP and kept out of the shared memo, so asking about many addresses
 * can neither evict the hot entries nor run up the database.
 */
export async function GET(req: Request) {
  const w = (new URL(req.url).searchParams.get("wallet") ?? "").toLowerCase();
  if (w && rateLimited(`points:ip:${clientIp(req)}`, 120)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  try {
    const season = await memo("points:public-season", 10_000, publicSeason);
    if (!season) return NextResponse.json({ season: null, me: null, reason: null }, { headers: { "cache-control": "no-store" } });
    // anyone can ask about any wallet: the reason never says whether a moderator kept it off the boards (walletReason
    // works it out as if that flag were not there); a hidden profile is public already
    const [me, reason] = isAddress(w) ? await Promise.all([walletPoints(season.id, w), walletReason(w)]) : [null, null];
    return NextResponse.json({ season: { name: season.name, starts_at: season.starts_at, ends_at: season.ends_at, ended: seasonEnded(season), final: seasonFinal(season) }, me, reason }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[points] read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load points" }, { status: 502 });
  }
}
