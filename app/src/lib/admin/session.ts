import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { SITE_URL } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { adminWallets } from "@/lib/launchpad/postsServer";
import { ADMIN_NONCE_TTL_MS, ADMIN_SESSION_MS, ADMIN_SESSIONS_MAX } from "./signIn";

/**
 * Admin sessions. Signing in (signIn.ts) creates one: a random 32-byte token goes to the browser in an HttpOnly,
 * Secure, SameSite=Strict cookie, and the database keeps only its SHA-256, so a leaked database row cannot be used as a
 * cookie. A session counts only while it exists, is not ended, has not passed its 8 hours, and its wallet is still in
 * ADMIN_WALLETS. Removing a wallet from the secret ends its sessions for good at boot (a secret change restarts every
 * machine), so adding the wallet back revives none. Signing out ends it on the server, not only in the browser.
 *
 * The session gates the admin page and the admin reads. Every admin action still needs its own wallet signature as
 * well, from the same wallet: a stolen cookie cannot act without the wallet, and a phished signature cannot act
 * without the cookie.
 */
const PROD = process.env.NODE_ENV === "production";
/** `__Host-`: the browser keeps it only if Secure, Path=/ and no Domain, so it is bound to openlaunch.lol exactly. */
export const ADMIN_COOKIE = PROD ? "__Host-ol_admin" : "ol_admin";

export function adminCookieOptions(expires: Date) {
  return { httpOnly: true, secure: PROD, sameSite: "strict" as const, path: "/", expires };
}

/** The origins a sign-in may be made for and admin requests may come from: the site itself (and localhost in dev). */
export function adminOrigins(): string[] {
  const site = new URL(SITE_URL).origin;
  return PROD ? [site] : [site, "http://localhost:3000", "http://127.0.0.1:3000"];
}

/** A state-changing admin request must come from the site's own pages (a second guard beside SameSite=Strict). */
export function fromAdminOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && adminOrigins().includes(origin);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 32 random bytes, base64url: 43 characters. */
export function isToken(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
}

/** The admin token from a Cookie header, or null. */
export function tokenFromCookieHeader(header: string | null): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === ADMIN_COOKIE) {
      const v = part.slice(i + 1).trim();
      return isToken(v) ? v : null;
    }
  }
  return null;
}

type Fail = { ok: false; error: string; status: number };
const fail = (error: string, status: number): Fail => ({ ok: false, error, status });

/** A server nonce for one sign-in message: single use, 5 minutes. Null without a database. */
export async function issueAdminNonce(): Promise<string | null> {
  const db = maybeDb();
  if (!db) return null;
  const nonce = randomBytes(24).toString("hex");
  await db`INSERT INTO bb_admin_nonces (nonce, expires_at) VALUES (${nonce}, ${new Date(Date.now() + ADMIN_NONCE_TTL_MS)})`;
  void db`DELETE FROM bb_admin_nonces WHERE expires_at < now() - interval '1 hour'`.catch(() => {});
  return nonce;
}

/**
 * Whether a sign-in nonce is one this server issued, unspent and unexpired, without spending it: checked before the
 * signature (whose smart-wallet path costs RPC calls), so a made-up nonce is turned away for one database read.
 */
export async function adminNonceOpen(nonce: string): Promise<boolean> {
  const db = maybeDb();
  if (!db) return false;
  const rows = await db`SELECT 1 FROM bb_admin_nonces WHERE nonce = ${nonce} AND used_at IS NULL AND expires_at > now()`;
  return rows.length === 1;
}

/** Spend a sign-in nonce: true once, for a nonce this server issued that has not expired. */
export async function consumeAdminNonce(nonce: string): Promise<boolean> {
  const db = maybeDb();
  if (!db) return false;
  const rows = await db`UPDATE bb_admin_nonces SET used_at = now() WHERE nonce = ${nonce} AND used_at IS NULL AND expires_at > now() RETURNING nonce`;
  return rows.length === 1;
}

/** A new session for a wallet whose sign-in was verified. Past ADMIN_SESSIONS_MAX active ones, the oldest end. */
export async function createAdminSession(wallet: string, device: string): Promise<{ token: string; expiresAt: Date }> {
  const db = maybeDb();
  if (!db) throw new Error("db unconfigured");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_MS);
  await db.begin(async (t) => {
    await t`INSERT INTO bb_admin_sessions (token_hash, wallet, device, expires_at) VALUES (${hashToken(token)}, ${wallet}, ${device.slice(0, 60)}, ${expiresAt})`;
    await t`
      UPDATE bb_admin_sessions SET revoked_at = now()
       WHERE wallet = ${wallet} AND revoked_at IS NULL AND expires_at > now()
         AND id NOT IN (SELECT id FROM bb_admin_sessions WHERE wallet = ${wallet} AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC, id DESC LIMIT ${ADMIN_SESSIONS_MAX})`;
  });
  void db`DELETE FROM bb_admin_sessions WHERE expires_at < now() - interval '30 days'`.catch(() => {});
  return { token, expiresAt };
}

export type AdminSession = { id: number; wallet: string; expiresAt: string };

/** The session a token belongs to, if it still counts (exists, not ended, not expired, wallet still an admin). */
export async function adminSessionFromToken(token: string | null | undefined): Promise<AdminSession | null> {
  if (!isToken(token)) return null;
  const db = maybeDb();
  if (!db) return null;
  const [row] = await db<{ id: string; wallet: string; expires_at: Date }[]>`
    SELECT id, wallet, expires_at FROM bb_admin_sessions
     WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL AND expires_at > now()`;
  if (!row) return null;
  // not an admin on this machine: refused, but never ended from here. While a secret change rolls out, a machine still on
  // the old list would end a newly added admin's sessions; ending a removed wallet's is the boot sweep's job
  if (!adminWallets().has(row.wallet)) return null;
  void db`UPDATE bb_admin_sessions SET last_seen_at = now() WHERE id = ${row.id} AND last_seen_at < now() - interval '1 minute'`.catch(() => {});
  return { id: Number(row.id), wallet: row.wallet, expiresAt: new Date(row.expires_at).toISOString() };
}

export async function adminFromRequest(req: Request): Promise<AdminSession | null> {
  return adminSessionFromToken(tokenFromCookieHeader(req.headers.get("cookie")));
}

/**
 * At boot (a change to ADMIN_WALLETS restarts the machines): end, for good, every session of a wallet no longer listed,
 * so adding it back later revives none. Retried (3 tries, 10 s apart) so a database blip at boot does not skip it.
 */
export async function revokeNonAdminSessions(tries = 3, waitMs = 10_000): Promise<number> {
  const db = maybeDb();
  if (!db) return 0;
  for (let i = 1; ; i++) {
    try {
      const rows = await db`UPDATE bb_admin_sessions SET revoked_at = now() WHERE revoked_at IS NULL AND wallet <> ALL(${[...adminWallets()]}::text[]) RETURNING id`;
      return rows.length;
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

type Gate = { ok: true; session: AdminSession } | Fail;

/** The gate for every admin read: a session that still counts. Fails closed: no database or a failed read refuses. */
export async function requireAdmin(req: Request): Promise<Gate> {
  if (!maybeDb()) return fail("db unconfigured", 503);
  let session: AdminSession | null;
  try {
    session = await adminFromRequest(req);
  } catch (err) {
    console.error("[admin] session check failed:", err instanceof Error ? err.message : err);
    return fail("admin check unavailable, try again", 503);
  }
  if (!session) return fail("admin session needed: sign in at /admin", 401);
  return { ok: true, session };
}

/**
 * The gate for every admin action: a request from the site's own pages, a session, and the session's wallet is the one
 * that signed the action. A missing or malformed wallet is refused here, never let through as a read would be.
 */
export async function requireAdminAction(req: Request, signedWallet: unknown): Promise<Gate> {
  if (!maybeDb()) return fail("db unconfigured", 503);
  if (!fromAdminOrigin(req)) return fail("bad origin", 403);
  if (typeof signedWallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(signedWallet)) return fail("bad wallet", 400);
  const a = await requireAdmin(req);
  if (!a.ok) return a;
  if (signedWallet.toLowerCase() !== a.session.wallet) return fail("signed by a different wallet than the signed-in admin: switch back to it", 403);
  return a;
}

export type AdminSessionRow = { id: number; device: string; created_at: string; last_seen_at: string; expires_at: string };

/** A wallet's sessions that still count, newest first. */
export async function listAdminSessions(wallet: string): Promise<AdminSessionRow[]> {
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<{ id: string; device: string; created_at: Date; last_seen_at: Date; expires_at: Date }[]>`
    SELECT id, device, created_at, last_seen_at, expires_at FROM bb_admin_sessions
     WHERE wallet = ${wallet} AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC, id DESC`;
  return rows.map((r) => ({ id: Number(r.id), device: r.device, created_at: new Date(r.created_at).toISOString(), last_seen_at: new Date(r.last_seen_at).toISOString(), expires_at: new Date(r.expires_at).toISOString() }));
}

/** End one of a wallet's sessions (only its own), or all of them. Returns how many ended. */
export async function revokeAdminSessions(wallet: string, which: { id: number } | "all"): Promise<number> {
  const db = maybeDb();
  if (!db) return 0;
  const rows = which === "all"
    ? await db`UPDATE bb_admin_sessions SET revoked_at = now() WHERE wallet = ${wallet} AND revoked_at IS NULL RETURNING id`
    : await db`UPDATE bb_admin_sessions SET revoked_at = now() WHERE wallet = ${wallet} AND id = ${which.id} AND revoked_at IS NULL RETURNING id`;
  return rows.length;
}
