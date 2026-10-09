import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { admitAdmin } from "@/lib/profiles/server";
import { buildPointsAdminMessage, isPointsAdminAction, normalizeSeasonDays } from "@/lib/points/auth";
import { currentSeason, endSeasonNow, finalizeIfEnded, hideSeason, previewBoards, publishSeason, recomputeNow, seasonEnded, startSeason } from "@/lib/points/server";

export const dynamic = "force-dynamic";

/**
 * POST {action, days?, chain, wallet, nonce, ts, signature} → one admin-signed points action:
 * preview (the shadow boards), start (a new season as a shadow run; the previous one's final standings are computed
 * first), publish (the season starts now for everyone) / unpublish, end (now), recompute (now; not after the final).
 */
export async function POST(req: Request) {
  if (rateLimited(`points-admin:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const action = b.action;
  if (!isPointsAdminAction(action)) return NextResponse.json({ error: "bad action" }, { status: 400 });
  const days = normalizeSeasonDays(b.days); // signed for "start": the season is exactly as long as the admin signed
  const a = await admitAdmin({ chain: b.chain, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature }, (wallet, nonce, ts) => buildPointsAdminMessage({ action, wallet, nonce, ts, days }));
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  try {
    const season = await currentSeason();
    switch (action) {
      case "start": {
        if (season && !seasonEnded(season)) return NextResponse.json({ error: `${season.name} is still running` }, { status: 409 });
        // a season that went public keeps its final standings, so they are computed first; a hidden run that was
        // discarded has none to keep, and never blocks the next season (not even when a price is missing)
        if (season && season.published_at && !(await finalizeIfEnded(season))) return NextResponse.json({ error: `${season.name}'s final standings could not be computed yet; try again in a minute` }, { status: 409 });
        const s = await startSeason(days);
        void recomputeNow().catch(() => {});
        return NextResponse.json({ ok: true, season: s });
      }
      case "publish": {
        if (!season) return NextResponse.json({ error: "no season" }, { status: 404 });
        // a shadow run that ended without ever going public has no standings anyone was told about
        if (!season.published_at && seasonEnded(season)) return NextResponse.json({ error: `${season.name} ended without being published; start a new season` }, { status: 409 });
        const r = await publishSeason(season.id);
        // it ended in the moment between the check above and the publish
        if (r === "refused") return NextResponse.json({ error: `${season.name} ended without being published; start a new season` }, { status: 409 });
        if (r === "started") void recomputeNow().catch(() => {});
        return NextResponse.json({ ok: true, result: r });
      }
      case "unpublish":
        if (!season) return NextResponse.json({ error: "no season" }, { status: 404 });
        await hideSeason(season.id);
        return NextResponse.json({ ok: true });
      case "end":
        if (!season) return NextResponse.json({ error: "no season" }, { status: 404 });
        await endSeasonNow(season.id);
        return NextResponse.json({ ok: true });
      case "recompute": {
        const r = await recomputeNow();
        if (r && "error" in r) return NextResponse.json({ error: r.error }, { status: 409 });
        return NextResponse.json({ ok: true, result: r });
      }
      case "preview":
        if (!season) return NextResponse.json({ season: null });
        return NextResponse.json({ season, ...(await previewBoards(season.id)) }, { headers: { "cache-control": "no-store" } });
    }
  } catch (err) {
    console.error("[points] admin failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not apply" }, { status: 502 });
  }
}
