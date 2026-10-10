import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { looksLikeBot, prunePresence, readPulse, recordBeacon, visitorHash } from "@/lib/launchpad/presence";
import { memo } from "@/lib/launchpad/memo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET → {visits, online}. POST (browser beacon) → records presence, returns the same. No cookies, no PII stored. */
export async function GET() {
  try {
    return NextResponse.json(await memo("pulse", 2_000, () => readPulse()), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[presence] pulse failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load presence" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}

let lastPrune = 0;

export async function POST(req: Request) {
  const ua = req.headers.get("user-agent") ?? "";
  try {
    if (looksLikeBot(ua)) return NextResponse.json(await readPulse(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[presence] pulse failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load presence" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
  const ip = (req.headers.get("fly-client-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "0.0.0.0";
  // The visitor hash mixes in the UA, which the caller fully controls: without
  // a bucket, rotating UAs mints a fresh bb_presence row per request and
  // inflates visits. 30/min leaves normal beaconing (~every few seconds) alone.
  if (rateLimited(`presence:ip:${ip}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  try {
    const pulse = await recordBeacon(visitorHash(ip, ua));
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      void prunePresence().catch(() => {});
    }
    return NextResponse.json(pulse, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[presence] beacon failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not record presence" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
