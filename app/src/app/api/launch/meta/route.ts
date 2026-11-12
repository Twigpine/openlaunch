import { clientIp, readBody } from "@/lib/profiles/http";
import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { MetaConflict, saveMeta, validateMeta } from "@/lib/launchpad/meta";
import { LAUNCHPAD_CONFIGURED } from "@/lib/launchpad/config";

export const dynamic = "force-dynamic";

/** POST — store off-chain metadata for a launch about to be sent; returns the metadataURI + predicted token. */
export async function POST(req: Request) {
  if (!LAUNCHPAD_CONFIGURED) return NextResponse.json({ error: "launchpad unconfigured" }, { status: 503 });
  // Unsigned by design (salt secrecy decides conflicts), so the IP bucket is
  // the only thing stopping junk-row sprays and predictToken RPC burn.
  const ip = clientIp(req);
  if (rateLimited(`meta:ip:${ip}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const raw = await readBody(req, 64 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.reason === "too_large" ? "body too large" : "bad json" }, { status: raw.reason === "too_large" ? 413 : 400 });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw.bytes));
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const v = validateMeta((body ?? {}) as Partial<Parameters<typeof validateMeta>[0]>);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  try {
    return NextResponse.json(await saveMeta(v.value));
  } catch (err) {
    if (err instanceof MetaConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    // RPC/DB diagnostics can contain credentials, including keyed provider URLs.
    return NextResponse.json({ error: "metadata save failed" }, { status: 502 });
  }
}
