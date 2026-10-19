import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { looksLikeBot, visitorHash } from "@/lib/launchpad/presence";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { boostBeaconSameOrigin, parseBoostSeen } from "@/lib/launchpad/boost";
import { boostClickAddress } from "@/lib/launchpad/boostAddress";
import { recordBoostSeen } from "@/lib/launchpad/boostServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST {kind: "view" | "click", source: "home" | "base", token?}: the Boosted lane's beacon (sendBeacon, so the body
 * comes as text/plain). A view adds 1 to every token in the lane now; a click counts once per visitor, token and 30
 * minutes, and only while the token is in the lane. Only the site's own pages may send it: the counts are public on
 * the cards, and another site could otherwise send them from its visitors' browsers. Nothing is stored that names a
 * person: see presence.ts and boostServer.ts. 204 whether it counted or not; the page never waits on it.
 */
export async function POST(req: Request) {
  const ua = req.headers.get("user-agent") ?? "";
  if (looksLikeBot(ua)) return new NextResponse(null, { status: 204 });
  if (!boostBeaconSameOrigin(req.headers.get("sec-fetch-site"), req.headers.get("origin"), req.headers.get("host"))) {
    return NextResponse.json({ error: "cross-site" }, { status: 403 });
  }
  // the address, an IPv6 one by its /64 (boostClickAddress): rotating within one's own block buys no fresh bucket
  const ip = boostClickAddress(clientIp(req));
  // a person sends one view per page and a click per card opened; 60 a minute leaves room for a shared address
  if (rateLimited(`boost-seen:ip:${ip}`, 60)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const seen = parseBoostSeen(await readJson(req, 512));
  if (!seen) return NextResponse.json({ error: "bad beacon" }, { status: 400 });
  try {
    // the address alone, no user agent: the caller picks that, and a click must not count again for a new one
    await recordBoostSeen(seen, visitorHash(ip, ""), await ethUsd());
  } catch (err) {
    console.warn("[boost] beacon failed:", err instanceof Error ? err.message : err);
  }
  return new NextResponse(null, { status: 204 });
}
