import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { admitAdmin } from "@/lib/profiles/server";
import { buildPointsAdminMessage, isPointsAdminAction } from "@/lib/points/auth";
import { computePointsIfDue, currentSeason, endSeasonNow, previewBoards, setSeasonPublic, startSeason } from "@/lib/points/server";

export const dynamic = "force-dynamic";

/**
 * POST {action, days?, chain, wallet, nonce, ts, signature} → one admin-signed points action:
 * preview (the shadow boards), start (a new season, not public), publish / unpublish, end (now), recompute (now).
 */
export async function POST(req: Request) {
  if (rateLimited(`points-admin:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const action = b.action;
  if (!isPointsAdminAction(action)) return NextResponse.json({ error: "bad action" }, { status: 400 });
  const a = await admitAdmin({ chain: b.chain, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature }, (wallet, nonce, ts) => buildPointsAdminMessage({ action, wallet, nonce, ts }));
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  try {
    const season = await currentSeason();
    switch (action) {
      case "start": {
        if (season && new Date(season.ends_at).getTime() > Date.now()) return NextResponse.json({ error: `${season.name} is still running` }, { status: 409 });
        const days = Math.min(90, Math.max(1, Math.trunc(Number(b.days) || 28)));
        const s = await startSeason(days);
        void computePointsIfDue(true).catch(() => {});
        return NextResponse.json({ ok: true, season: s });
      }
      case "publish":
      case "unpublish":
        if (!season) return NextResponse.json({ error: "no season" }, { status: 404 });
        await setSeasonPublic(season.id, action === "publish");
        return NextResponse.json({ ok: true });
      case "end":
        if (!season) return NextResponse.json({ error: "no season" }, { status: 404 });
        await endSeasonNow(season.id);
        return NextResponse.json({ ok: true });
      case "recompute": {
        const r = await computePointsIfDue(true);
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
