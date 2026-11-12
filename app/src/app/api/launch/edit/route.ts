import { clientIp, readBody } from "@/lib/profiles/http";
import { NextResponse } from "next/server";
import { isChainKey } from "@/lib/chainPublic";
import { applySignedEdit, rateLimited } from "@/lib/launchpad/editServer";

export const dynamic = "force-dynamic";

/** POST {chain, token, wallet, nonce, expiresAt, signature, fields} → applies a creator-signed metadata edit. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(`edit:ip:${ip}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  // Smart-wallet signatures can include ERC-6492 deployment calldata.
  const raw = await readBody(req, 256 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.reason === "too_large" ? "body too large" : "bad json" }, { status: raw.reason === "too_large" ? 413 : 400 });
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(new TextDecoder().decode(raw.bytes)) as Record<string, unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b)) return NextResponse.json({ error: "bad json" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!isChainKey(b.chain) || typeof b.token !== "string" || typeof b.wallet !== "string") return NextResponse.json({ error: "bad params" }, { status: 400 });
  const r = await applySignedEdit({ chain: b.chain, token: b.token, wallet: b.wallet, nonce: b.nonce, expiresAt: b.expiresAt, signature: b.signature, fields: (b.fields ?? {}) as Record<string, unknown> });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
