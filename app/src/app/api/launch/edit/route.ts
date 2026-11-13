import { NextResponse } from "next/server";
import { isChainKey } from "@/lib/chainPublic";
import { clientIp, readJson } from "@/lib/http";
import { applySignedEdit, rateLimited } from "@/lib/launchpad/editServer";

export const dynamic = "force-dynamic";

/** POST {chain, token, wallet, nonce, expiresAt, signature, fields} → applies a creator-signed metadata edit. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(`edit:ip:${ip}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const b = await readJson(req, 16_384);
  if (!b) return NextResponse.json({ error: "bad json" }, { status: 400 });
  if (!isChainKey(b.chain) || typeof b.token !== "string" || typeof b.wallet !== "string") return NextResponse.json({ error: "bad params" }, { status: 400 });
  const r = await applySignedEdit({ chain: b.chain, token: b.token, wallet: b.wallet, nonce: b.nonce, expiresAt: b.expiresAt, signature: b.signature, fields: (b.fields ?? {}) as Record<string, unknown> });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
