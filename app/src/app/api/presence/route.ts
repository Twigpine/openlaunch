import { NextResponse } from "next/server";
import { clientIp } from "@/lib/http";
import { rateLimited } from "@/lib/launchpad/editServer";
import { looksLikeBot, prunePresence, readPulse, recordBeacon, visitorHash } from "@/lib/launchpad/presence";
import { memo } from "@/lib/launchpad/memo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET → {visits, online}. POST (browser beacon) → records presence, returns the same. No cookies, no PII stored. */
export async function GET() {
  return NextResponse.json(await memo("pulse", 2_000, () => readPulse()), { headers: { "cache-control": "no-store" } });
}

let lastPrune = 0;

export async function POST(req: Request) {
  const ua = req.headers.get("user-agent") ?? "";
  if (looksLikeBot(ua)) return NextResponse.json(await readPulse(), { headers: { "cache-control": "no-store" } });
  const ip = clientIp(req);
  // The visitor hash mixes in the UA, which the caller fully controls: without
  // a bucket, rotating UAs mints a fresh bb_presence row per request and
  // inflates visits. 30/min leaves normal beaconing (~every few seconds) alone.
  if (rateLimited(`presence:ip:${ip}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const pulse = await recordBeacon(visitorHash(ip, ua));
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    void prunePresence().catch(() => {});
  }
  return NextResponse.json(pulse, { headers: { "cache-control": "no-store" } });
}
