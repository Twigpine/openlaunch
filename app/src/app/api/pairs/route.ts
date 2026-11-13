import { NextResponse } from "next/server";
import { loadPairs } from "@/lib/launchpad/pairsServer";

export const dynamic = "force-dynamic";

/**
 * GET: the community pairs (lib/launchpad/pairs.ts), every status, each listed one with its USD price (null when its
 * price cannot be read or fails its check right now). Public: the same record the /pairs pages show.
 */
export async function GET() {
  const pairs = await loadPairs();
  return NextResponse.json({ pairs }, { headers: { "cache-control": "public, max-age=15" } });
}
