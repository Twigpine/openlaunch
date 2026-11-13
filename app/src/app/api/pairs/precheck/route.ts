import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { rateLimited } from "@/lib/launchpad/editServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { applicationsOpen, precheckToken } from "@/lib/launchpad/pairApplyServer";
import { PAIR_CHAINS, PAIR_CHAINS_TEXT } from "@/lib/launchpad/pairs";

export const dynamic = "force-dynamic";

/**
 * POST {chain, address}: the free automatic check of a token that wants to be a community pair (pairCheck.ts). Each
 * answer is kept 10 minutes per token; 6 a minute per address, since every fresh one reads the chain and two services.
 */
export async function POST(req: Request) {
  if (!applicationsOpen()) return NextResponse.json({ error: "applications are not open yet" }, { status: 503 });
  if (rateLimited(`pairs-precheck:ip:${clientIp(req)}`, 6)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req);
  const chain = PAIR_CHAINS.find((c) => c === b?.chain);
  if (!chain || typeof b?.address !== "string" || !isAddress(b.address)) return NextResponse.json({ error: `a token address on ${PAIR_CHAINS_TEXT}` }, { status: 400 });
  try {
    return NextResponse.json(await precheckToken(chain, b.address), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.warn("[pairs] precheck failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "the check could not run: try again in a minute" }, { status: 502 });
  }
}
