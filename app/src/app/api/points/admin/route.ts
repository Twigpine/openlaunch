import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { admitAdmin } from "@/lib/profiles/server";
import { SEASON_ACTIONS, buildPointsAdminMessage, isPointsAdminAction, normalizeSeasonDays, normalizeSeasonId } from "@/lib/points/auth";
import { currentSeason, endSeasonNow, finalizeIfEnded, hideSeason, previewBoards, previousPublishedSeason, publishSeason, recomputeNow, seasonById, seasonEnded, seasonFinal, startSeason, type Season } from "@/lib/points/server";

export const dynamic = "force-dynamic";

/** What an admin sees of a season (and whether its final standings are in). */
const view = (s: Season) => ({ id: s.id, name: s.name, starts_at: s.starts_at, ends_at: s.ends_at, public: s.public, published_at: s.published_at, final: seasonFinal(s) });

/**
 * The admin view: the current season with its shadow boards, and the previous season that went public (so a public
 * Season 1 can be hidden or shown again while Season 2 runs hidden). Every action answers with it too, so an action
 * is one signature (the boards come back with it, no second signed read).
 */
async function adminView() {
  const season = await currentSeason();
  if (!season) return { season: null, previous: null };
  const previous = await previousPublishedSeason(season.id);
  return { season: view(season), previous: previous ? view(previous) : null, ...(await previewBoards(season.id)) };
}

/**
 * POST {action, days?, seasonId?, chain, wallet, nonce, ts, signature} → one admin-signed points action:
 * preview (the admin view), start (a new season as a shadow run; a previous season that went public gets its final
 * standings first), publish / unpublish (show or hide one named season; the first publish of the current one starts
 * its clock), end (the named current season, now), recompute (now; not after the final). The length of a start and
 * the season of publish / unpublish / end are part of the signed message.
 */
export async function POST(req: Request) {
  if (rateLimited(`points-admin:ip:${clientIp(req)}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const action = b.action;
  if (!isPointsAdminAction(action)) return NextResponse.json({ error: "bad action" }, { status: 400 });
  const days = normalizeSeasonDays(b.days); // signed for "start": the season is exactly as long as the admin signed
  const seasonId = normalizeSeasonId(b.seasonId); // signed for publish / unpublish / end: the season they act on
  if (SEASON_ACTIONS.includes(action) && !seasonId) return NextResponse.json({ error: "which season? reload the admin page" }, { status: 400 });
  const a = await admitAdmin({ chain: b.chain, wallet: b.wallet, nonce: b.nonce, ts: b.ts, signature: b.signature }, (wallet, nonce, ts) => buildPointsAdminMessage({ action, wallet, nonce, ts, days, seasonId }));
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  const done = async (extra: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...extra, view: await adminView() }, { headers: { "cache-control": "no-store" } });
  try {
    const season = await currentSeason();
    switch (action) {
      case "preview":
        return NextResponse.json(await adminView(), { headers: { "cache-control": "no-store" } });
      case "start": {
        if (season && !seasonEnded(season)) return NextResponse.json({ error: `${season.name} is still running` }, { status: 409 });
        // a season that went public keeps its final standings, so they are computed first; a hidden run that was
        // discarded has none to keep, and never blocks the next season (not even when a price is missing)
        if (season && season.published_at && !(await finalizeIfEnded(season))) return NextResponse.json({ error: `${season.name}'s final standings are not in yet: they wait for every indexer and the season's last swaps (at most about an hour past the end) and for a missing price (up to a day); try again in a few minutes` }, { status: 409 });
        const s = await startSeason(days);
        if (!s) return NextResponse.json({ error: "a season is already running" }, { status: 409 });
        void recomputeNow().catch(() => {});
        return done({ season: s });
      }
      case "publish": {
        const s = await seasonById(seasonId);
        if (!s) return NextResponse.json({ error: "no such season" }, { status: 404 });
        // a season's first publish starts it for everyone: only the current one, and only while it runs
        if (!s.published_at && (s.id !== season?.id || seasonEnded(s))) return NextResponse.json({ error: `${s.name} ended without being published; start a new season` }, { status: 409 });
        const r = await publishSeason(s.id);
        // it ended in the moment between the check above and the publish
        if (r === "refused") return NextResponse.json({ error: `${s.name} ended without being published; start a new season` }, { status: 409 });
        if (r === "started") void recomputeNow().catch(() => {});
        return done({ result: r });
      }
      case "unpublish": {
        const s = await seasonById(seasonId);
        if (!s) return NextResponse.json({ error: "no such season" }, { status: 404 });
        await hideSeason(s.id);
        return done();
      }
      case "end": {
        if (!season || season.id !== seasonId || seasonEnded(season)) return NextResponse.json({ error: "only the running season can be ended; reload the admin page" }, { status: 409 });
        await endSeasonNow(season.id);
        return done();
      }
      case "recompute": {
        const r = await recomputeNow();
        if (r && "error" in r) return NextResponse.json({ error: r.error }, { status: 409 });
        return done({ result: r });
      }
    }
  } catch (err) {
    console.error("[points] admin failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not apply" }, { status: 502 });
  }
}
