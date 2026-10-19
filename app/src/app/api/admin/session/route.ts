import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/launchpad/editServer";
import { adminWallets } from "@/lib/launchpad/postsServer";
import { clientIp, readJson } from "@/lib/profiles/http";
import { verifySig } from "@/lib/profiles/server";
import { checkAdminSignIn, deviceLabel } from "@/lib/admin/signIn";
import { ADMIN_COOKIE, adminCookieOptions, adminNonceOpen, adminOrigins, consumeAdminNonce, createAdminSession, fromAdminOrigin, listAdminSessions, requireAdmin, revokeAdminSessions } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/** GET → {admin: null} or {admin: {wallet, expiresAt, id}, sessions}: who is signed in, and that wallet's sessions. */
export async function GET(req: Request) {
  const a = await requireAdmin(req);
  if (!a.ok) return a.status === 401 ? json({ admin: null }) : json({ error: a.error }, a.status);
  return json({ admin: a.session, sessions: await listAdminSessions(a.session.wallet) });
}

/**
 * POST {message, signature} → sign in. The message is a Sign-In with Ethereum text for this site, on Base, carrying a
 * nonce this server issued (checkAdminSignIn); the signer must be in ADMIN_WALLETS. The nonce must be open before the
 * signature is checked (a made-up one costs no RPC) and is spent only after it checks out, so a bad attempt never burns
 * a good nonce. The answer sets the session cookie.
 */
export async function POST(req: Request) {
  if (!fromAdminOrigin(req)) return json({ error: "bad origin" }, 403);
  if (rateLimited(`admin-signin:ip:${clientIp(req)}`, 10)) return json({ error: "slow down" }, 429);
  const b = await readJson(req);
  if (!b) return json({ error: "bad json" }, 400);
  const c = checkAdminSignIn(b.message, { origins: adminOrigins(), now: Date.now() });
  if (!c.ok) return json({ error: c.error }, c.status);
  if (!adminWallets().has(c.wallet)) return json({ error: "this wallet is not an admin" }, 403);
  try {
    if (!(await adminNonceOpen(c.nonce))) return json({ error: "sign-in expired or already used, try again" }, 401);
  } catch (err) {
    console.error("[admin] nonce check failed:", err instanceof Error ? err.message : err);
    return json({ error: "could not sign in, try again" }, 502);
  }
  const v = await verifySig(c.wallet, [b.message as string], b.signature, "base");
  if (v === "down") return json({ error: "signature check unavailable, try again" }, 503);
  if (v === "bad") return json({ error: "signature does not match (with a smart wallet, switch it to Base and sign again)" }, 401);
  if (typeof v === "object") return json({ error: "switch your wallet to Base and sign again" }, 409);
  // the wallet bucket is spent only after the wallet is proven (a stranger cannot lock an admin out)
  if (rateLimited(`admin-signin:wallet:${c.wallet}`, 10)) return json({ error: "slow down" }, 429);
  try {
    if (!(await consumeAdminNonce(c.nonce))) return json({ error: "sign-in expired or already used, try again" }, 401);
    const device = deviceLabel(req.headers.get("user-agent"));
    const s = await createAdminSession(c.wallet, device);
    console.info(`[admin] signed in: ${c.wallet} (${device})`);
    const res = json({ ok: true, wallet: c.wallet, expiresAt: s.expiresAt.toISOString() });
    res.cookies.set(ADMIN_COOKIE, s.token, adminCookieOptions(s.expiresAt));
    return res;
  } catch (err) {
    console.error("[admin] sign-in failed:", err instanceof Error ? err.message : err);
    return json({ error: "could not sign in, try again" }, 502);
  }
}

/**
 * DELETE → sign out this session; ?id=N → end one of this wallet's other sessions; ?all=1 → end every session of this
 * wallet. The cookie is cleared whenever this browser's own session ended.
 */
export async function DELETE(req: Request) {
  if (!fromAdminOrigin(req)) return json({ error: "bad origin" }, 403);
  const a = await requireAdmin(req);
  if (!a.ok) {
    const res = json({ error: a.error }, a.status);
    if (a.status === 401) res.cookies.set(ADMIN_COOKIE, "", adminCookieOptions(new Date(0)));
    return res;
  }
  const q = new URL(req.url).searchParams;
  const id = q.has("id") ? Number(q.get("id")) : null;
  if (id !== null && !(Number.isSafeInteger(id) && id > 0)) return json({ error: "bad id" }, 400);
  try {
    const all = q.get("all") === "1";
    const ended = await revokeAdminSessions(a.session.wallet, all ? "all" : { id: id ?? a.session.id });
    const mine = all || id === null || id === a.session.id;
    console.info(`[admin] signed out: ${a.session.wallet} (${all ? "everywhere" : mine ? "this session" : `session ${id}`}, ${ended} ended)`);
    const res = json({ ok: true, ended, signedOut: mine });
    if (mine) res.cookies.set(ADMIN_COOKIE, "", adminCookieOptions(new Date(0)));
    return res;
  } catch (err) {
    console.error("[admin] sign-out failed:", err instanceof Error ? err.message : err);
    return json({ error: "could not sign out, try again" }, 502);
  }
}
