import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp } from "@/lib/profiles/http";
import { namesFor } from "@/lib/profiles/server";

export const dynamic = "force-dynamic";
const NAMES_MAX = 100;

/** GET /api/profile/names?w=0x…,0x… (≤100) → {names: {wallet: {u, d, a, v}}} for wallets that have a visible profile. */
export async function GET(req: Request) {
  if (rateLimited(`names:ip:${clientIp(req)}`, 240)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const raw = new URL(req.url).searchParams.get("w") ?? "";
  const wallets = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => isAddress(s)).slice(0, NAMES_MAX);
  if (wallets.length === 0) return NextResponse.json({ names: {} });
  try {
    return NextResponse.json({ names: await namesFor(wallets) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[profile] names failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load names" }, { status: 502 });
  }
}
