import { clientIp, readBody } from "@/lib/profiles/http";
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isChainKey } from "@/lib/chainPublic";
import { issueNonce, rateLimited } from "@/lib/launchpad/editServer";

export const dynamic = "force-dynamic";

/** POST {chain, token, wallet} → {nonce, expiresAt}. Only the token's creator gets one. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(`nonce:ip:${ip}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const raw = await readBody(req, 64 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.reason === "too_large" ? "body too large" : "bad json" }, { status: raw.reason === "too_large" ? 413 : 400 });
  let b: { chain?: unknown; token?: unknown; wallet?: unknown };
  try {
    b = JSON.parse(new TextDecoder().decode(raw.bytes)) as typeof b;
    if (!b || typeof b !== "object" || Array.isArray(b)) return NextResponse.json({ error: "bad json" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!isChainKey(b.chain) || typeof b.token !== "string" || !isAddress(b.token) || typeof b.wallet !== "string" || !isAddress(b.wallet)) return NextResponse.json({ error: "bad params" }, { status: 400 });
  const n = await issueNonce(b.chain, b.token, b.wallet);
  if (!n) return NextResponse.json({ error: "not the creator" }, { status: 403 });
  return NextResponse.json(n, { headers: { "cache-control": "no-store" } });
}
