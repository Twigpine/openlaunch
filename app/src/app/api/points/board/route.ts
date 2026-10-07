import { NextResponse } from "next/server";
import { memo } from "@/lib/launchpad/memo";
import { boardRows, publicSeason } from "@/lib/points/server";

export const dynamic = "force-dynamic";

/** GET /api/points/board?board=creator|scout → the public leaderboard (404 while the season is not public). */
export async function GET(req: Request) {
  const board = new URL(req.url).searchParams.get("board") === "scout" ? "scout" : "creator";
  try {
    const season = await memo("points:public-season", 10_000, publicSeason);
    if (!season) return NextResponse.json({ error: "no public season" }, { status: 404 });
    const data = await memo(`points:board:${season.id}:${board}`, 30_000, () => boardRows(season.id, board));
    return NextResponse.json({ season: { name: season.name, ends_at: season.ends_at }, board, ...data }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[points] board failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load the board" }, { status: 502 });
  }
}
