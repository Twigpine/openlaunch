import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { MetaConflict, saveMeta, validateMeta } from "@/lib/launchpad/meta";
import { LAUNCHPAD_CONFIGURED } from "@/lib/launchpad/config";
import { publicError } from "@/lib/launchpad/redact";

export const dynamic = "force-dynamic";

/** POST — store off-chain metadata for a launch about to be sent; returns the metadataURI + predicted token. */
export async function POST(req: Request) {
  if (!LAUNCHPAD_CONFIGURED) return NextResponse.json({ error: "launchpad unconfigured" }, { status: 503 });
  // Unsigned by design (salt secrecy decides conflicts), so the IP bucket is
  // the only thing stopping junk-row sprays and predictToken RPC burn.
  const ip = (req.headers.get("fly-client-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "0.0.0.0";
  if (rateLimited(`meta:ip:${ip}`, 20)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const v = validateMeta((body ?? {}) as Partial<Parameters<typeof validateMeta>[0]>);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  try {
    return NextResponse.json(await saveMeta(v.value));
  } catch (err) {
    if (err instanceof MetaConflict) return NextResponse.json({ error: err.message }, { status: 409 });
    // never the raw message: predictToken is an RPC read, and its failure quotes the upstream URL (a keyed one carries its API key)
    return NextResponse.json({ error: publicError(err) }, { status: 502 });
  }
}
