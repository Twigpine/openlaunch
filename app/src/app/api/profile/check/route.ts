import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { rateLimited } from "@/lib/launchpad/editServer";
import { maybeDb } from "@/lib/db";
import { clientIp } from "@/lib/profiles/http";
import { checkUsername } from "@/lib/profiles/validate";

export const dynamic = "force-dynamic";

/** GET /api/profile/check?username=name[&wallet=0x…] → {available, error?} for the form (the save re-checks everything). */
export async function GET(req: Request) {
  if (rateLimited(`ucheck:ip:${clientIp(req)}`, 120)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  const u = new URL(req.url);
  const c = checkUsername(u.searchParams.get("username"));
  if (!c.ok) return NextResponse.json({ available: false, error: c.error });
  const wallet = (u.searchParams.get("wallet") ?? "").toLowerCase();
  const db = maybeDb();
  // a check that could not run says so (the form then shows nothing); the save checks for real either way
  if (!db) return NextResponse.json({ error: "could not check right now" }, { status: 503 });
  try {
    const [owner] = await db<{ wallet: string }[]>`SELECT wallet FROM bb_profiles WHERE username = ${c.username}`;
    const [held] = await db<{ wallet: string }[]>`SELECT wallet FROM bb_username_holds WHERE username = ${c.username} AND released_at > now() - interval '30 days'`;
    // a retired name is held by a marker that is no wallet, so it is never "mine"
    const mine = (w: string | undefined) => Boolean(w && isAddress(wallet) && w === wallet);
    const available = (!owner || mine(owner.wallet)) && (!held || mine(held.wallet));
    return NextResponse.json(available ? { available: true } : { available: false, error: "that username is taken" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "could not check right now" }, { status: 503 });
  }
}
