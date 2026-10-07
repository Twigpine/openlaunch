import "server-only";
import { randomBytes } from "node:crypto";
import { isAddress, type Address, type Hex } from "viem";
import { publicClient } from "@/lib/chain";
import { DEFAULT_CHAIN, isChainKey, type ChainKey } from "@/lib/chainPublic";
import { maybeDb, type Db } from "@/lib/db";
import { BRAND_DOMAIN, BRAND_X } from "@/lib/brand";
import { rateLimited } from "@/lib/launchpad/editServer";
import { adminWallets } from "@/lib/launchpad/postsServer";
import { buildProfileDeleteMessage, buildProfileMessage, buildProfileModMessage, isNonce, isProfileModAction, tsFresh } from "./auth";
import { avatarUrl, validateProfile } from "./validate";
import { X_CODE_TTL_MS, intentUrl, judgePost, makeXCode, parsePostUrl, postTextFor, type CodeRow } from "./xpost";
import { fetchPostFacts } from "./xFetch";

/**
 * Server half of profiles. Rules, all enforced here regardless of the client:
 *   - every write is a wallet signature (auth.ts) checked BEFORE its single-use nonce is spent, so an RPC blip or
 *     a bad signature never burns a nonce; EOAs, ERC-1271 and ERC-6492 wallets all verify
 *   - usernames are unique, reserved names are refused (validate.ts), a dropped name is held 30 days for its old
 *     wallet, and a name changes once per 30 days (free in the first day, and always to claim your verified X handle)
 *   - the X tick needs a post carrying a one-time code bound to the wallet and the handle (xpost.ts); one X account
 *     belongs to one wallet; the claimed handle is never public before it is verified
 *   - admins (ADMIN_WALLETS) can approve a post X would not show us, hide a profile, or keep it off points boards
 */

type Fail = { ok: false; error: string; status: number };
const fail = (error: string, status: number): Fail => ({ ok: false, error, status });

const DAY = 86_400_000;
const RENAME_COOLDOWN_MS = 30 * DAY;
const RENAME_GRACE_MS = DAY;

type Row = {
  wallet: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_key: string | null;
  x_handle: string | null;
  x_user_id: string | null;
  x_post_id: string | null;
  x_status: "none" | "verified" | "post_missing" | "pending_review";
  x_verified_at: string | null;
  x_account_created: string | null;
  x_followers: number | null;
  hidden: boolean;
  points_flag: string | null;
  username_changed_at: string | null;
  created_at: string;
};

/** What a profile looks like to everyone. The X handle shows only once verified. */
export type PublicProfile = {
  wallet: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  x: { handle: string; post_id: string | null; verified_at: string | null } | null;
  /** none | verified | pending (a person is checking the post) | reverify (the post is gone) */
  x_state: "none" | "verified" | "pending" | "reverify";
  created_at: string;
};

/** One entry of the names map that rides along with trades, holders and posts. */
export type NameEntry = { u: string; d: string; a: string | null; v: boolean };

export type XCodeView = { code: string; handle: string; expires_at: string; text: string; intent: string };

function xState(s: Row["x_status"]): PublicProfile["x_state"] {
  return s === "verified" ? "verified" : s === "pending_review" ? "pending" : s === "post_missing" ? "reverify" : "none";
}

function shape(r: Row): PublicProfile {
  return {
    wallet: r.wallet,
    username: r.username,
    display_name: r.display_name,
    bio: r.bio,
    avatar_url: avatarUrl(r.avatar_key),
    x: r.x_status === "verified" && r.x_handle ? { handle: r.x_handle, post_id: r.x_post_id, verified_at: r.x_verified_at } : null,
    x_state: xState(r.x_status),
    created_at: r.created_at,
  };
}

async function rowByWallet(db: Db, wallet: string): Promise<Row | null> {
  const rows = await db<Row[]>`SELECT wallet, username, display_name, bio, avatar_key, x_handle, x_user_id, x_post_id, x_status, x_verified_at, x_account_created, x_followers, hidden, points_flag, username_changed_at, created_at FROM bb_profiles WHERE wallet = ${wallet}`;
  return rows[0] ?? null;
}

export async function getProfile(by: { wallet: string } | { username: string }): Promise<PublicProfile | null> {
  const db = maybeDb();
  if (!db) return null;
  const rows =
    "wallet" in by
      ? await db<Row[]>`SELECT wallet, username, display_name, bio, avatar_key, x_handle, x_user_id, x_post_id, x_status, x_verified_at, x_account_created, x_followers, hidden, points_flag, username_changed_at, created_at FROM bb_profiles WHERE wallet = ${by.wallet.toLowerCase()} AND NOT hidden`
      : await db<Row[]>`SELECT wallet, username, display_name, bio, avatar_key, x_handle, x_user_id, x_post_id, x_status, x_verified_at, x_account_created, x_followers, hidden, points_flag, username_changed_at, created_at FROM bb_profiles WHERE username = ${by.username.toLowerCase()} AND NOT hidden`;
  return rows[0] ? shape(rows[0]) : null;
}

// ── names map ────────────────────────────────────────────────────────────────
const nameCache = new Map<string, { at: number; v: NameEntry | null }>();
const NAME_TTL_MS = 30_000;

export function forgetName(wallet: string): void {
  nameCache.delete(wallet.toLowerCase());
}

/** Names for a set of wallets in one query (30 s per-wallet cache). Wallets without a visible profile are absent. */
export async function namesFor(wallets: readonly (string | null | undefined)[]): Promise<Record<string, NameEntry>> {
  const want = [...new Set(wallets.filter((w): w is string => typeof w === "string" && isAddress(w)).map((w) => w.toLowerCase()))].slice(0, 500);
  const out: Record<string, NameEntry> = {};
  const now = Date.now();
  const miss: string[] = [];
  for (const w of want) {
    const hit = nameCache.get(w);
    if (hit && now - hit.at < NAME_TTL_MS) {
      if (hit.v) out[w] = hit.v;
    } else miss.push(w);
  }
  const db = maybeDb();
  if (miss.length === 0 || !db) return out;
  const rows = await db<{ wallet: string; username: string; display_name: string; avatar_key: string | null; x_status: string }[]>`
    SELECT wallet, username, display_name, avatar_key, x_status FROM bb_profiles WHERE wallet = ANY(${miss}::text[]) AND NOT hidden`;
  if (nameCache.size > 50_000) nameCache.clear();
  const found = new Map(rows.map((r) => [r.wallet, { u: r.username, d: r.display_name, a: avatarUrl(r.avatar_key), v: r.x_status === "verified" } satisfies NameEntry]));
  for (const w of miss) {
    const v = found.get(w) ?? null;
    nameCache.set(w, { at: now, v });
    if (v) out[w] = v;
  }
  return out;
}

// ── signatures ───────────────────────────────────────────────────────────────
async function verifySig(chain: ChainKey, wallet: string, message: string, signature: unknown): Promise<"ok" | "bad" | "down"> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return "bad";
  let valid = false;
  try {
    valid = await publicClient(chain).verifyMessage({ address: wallet as Address, message, signature: signature as Hex });
  } catch {
    return "down";
  }
  if (valid) return "ok";
  // viem returns false (not a throw) on an unreachable transport: tell an outage from a mismatch
  try {
    await publicClient(chain).getChainId();
  } catch {
    return "down";
  }
  return "bad";
}

async function consumeNonce(db: Db, nonce: string, wallet: string): Promise<boolean> {
  try {
    await db`INSERT INTO bb_profile_nonces (nonce, wallet) VALUES (${nonce}, ${wallet})`;
    void db`DELETE FROM bb_profile_nonces WHERE created_at < now() - interval '1 hour'`.catch(() => {});
    return true;
  } catch {
    return false; // duplicate → replay
  }
}

type Signed = { chain: unknown; wallet: unknown; nonce: unknown; ts: unknown; signature: unknown };

/** Shared front of every signed write: shapes, freshness, signature, then (only then) the nonce. */
async function admit(db: Db, s: Signed, message: (w: string, nonce: string, ts: number) => string): Promise<{ ok: true; wallet: string; ts: number } | Fail> {
  if (typeof s.wallet !== "string" || !isAddress(s.wallet)) return fail("bad wallet", 400);
  if (!isNonce(s.nonce)) return fail("bad nonce", 400);
  const now = Date.now();
  if (!tsFresh(s.ts, now)) return fail("signature expired, try again", 400);
  const chain: ChainKey = isChainKey(s.chain) ? s.chain : DEFAULT_CHAIN;
  const wallet = s.wallet.toLowerCase();
  const ts = Number(s.ts);
  const v = await verifySig(chain, wallet, message(wallet, s.nonce, ts), s.signature);
  if (v === "down") return fail("signature check unavailable, try again", 503);
  if (v === "bad") return fail("signature does not match", 401);
  // the wallet bucket is spent only after the wallet is proven (a stranger cannot freeze someone's edits)
  if (rateLimited(`profile:wallet:${wallet}`, 12)) return fail("slow down", 429);
  if (!(await consumeNonce(db, s.nonce, wallet))) return fail("nonce already used", 401);
  return { ok: true, wallet, ts };
}

function randomSuffix(n: number): string {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(randomBytes(n), (b) => a[b % a.length]).join("");
}

function newXCode(): string {
  for (;;) {
    const c = makeXCode(randomBytes(32));
    if (c) return c;
  }
}

export function codeView(code: string, handle: string, expiresAt: string, username: string): XCodeView {
  const text = postTextFor(username, code, BRAND_X, BRAND_DOMAIN);
  return { code, handle, expires_at: expiresAt, text, intent: intentUrl(text) };
}

// ── save ─────────────────────────────────────────────────────────────────────
export type SaveRequest = Signed & { fields: Record<string, unknown> };

export async function saveProfile(r: SaveRequest): Promise<{ ok: true; profile: PublicProfile; code: XCodeView | null; renamed?: string } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  const v = validateProfile({ username: r.fields.username, display_name: r.fields.display_name, bio: r.fields.bio, avatar: r.fields.avatar, x_handle: r.fields.x_handle });
  if (!v.ok) return fail(v.error, 400);
  const f = v.value;
  const a = await admit(db, r, (wallet, nonce, ts) => buildProfileMessage({ wallet, nonce, ts, fields: f }));
  if (!a.ok) return a;
  const me = a.wallet;
  const now = Date.now();

  try {
    const result = await db.begin(async (tx) => {
      const t = tx as unknown as Db;
      // one writer per name and per wallet at a time (two people racing for a name, or a double submit)
      await t`SELECT pg_advisory_xact_lock(hashtext(${`username:${f.username}`}))`;
      await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${me}`}))`;
      const existing = await rowByWallet(t, me);
      const nameChange = !existing || existing.username !== f.username;
      const claimingOwnX = Boolean(existing && existing.x_status === "verified" && existing.x_handle === f.username);
      let renamed: string | undefined;
      if (nameChange) {
        if (existing && !claimingOwnX && now - new Date(existing.created_at).getTime() > RENAME_GRACE_MS && existing.username_changed_at && now - new Date(existing.username_changed_at).getTime() < RENAME_COOLDOWN_MS) {
          return fail("you can change your username once every 30 days", 429);
        }
        const [held] = await t<{ wallet: string }[]>`SELECT wallet FROM bb_username_holds WHERE username = ${f.username} AND released_at > now() - interval '30 days'`;
        if (held && held.wallet !== me) return fail("that username is taken", 409);
        const [holder] = await t<{ wallet: string; x_status: string }[]>`SELECT wallet, x_status FROM bb_profiles WHERE username = ${f.username}`;
        if (holder && holder.wallet !== me) {
          // a verified X owner takes their own handle back from an unverified profile; everyone else waits
          if (!claimingOwnX || holder.x_status === "verified") return fail("that username is taken", 409);
          for (let i = 0; i < 8 && !renamed; i++) {
            const candidate = `${f.username.slice(0, 15)}_${randomSuffix(4)}`;
            const [clash] = await t`SELECT 1 FROM bb_profiles WHERE username = ${candidate}`;
            if (!clash) renamed = candidate;
          }
          if (!renamed) return fail("could not free that username, try again", 503);
          await t`UPDATE bb_profiles SET username = ${renamed}, updated_at = now() WHERE wallet = ${holder.wallet}`;
          forgetName(holder.wallet);
        }
        if (existing) {
          await t`INSERT INTO bb_username_holds (username, wallet, released_at) VALUES (${existing.username}, ${me}, now())
                  ON CONFLICT (username) DO UPDATE SET wallet = EXCLUDED.wallet, released_at = now()`;
        }
        await t`DELETE FROM bb_username_holds WHERE username = ${f.username} AND wallet = ${me}`;
      }
      await t`
        INSERT INTO bb_profiles (wallet, username, display_name, bio, avatar_key, x_handle)
        VALUES (${me}, ${f.username}, ${f.display_name}, ${f.bio || null}, ${f.avatar_key}, ${f.x_handle || null})
        ON CONFLICT (wallet) DO UPDATE SET
          username = EXCLUDED.username, display_name = EXCLUDED.display_name, bio = EXCLUDED.bio, avatar_key = EXCLUDED.avatar_key,
          username_changed_at = CASE WHEN bb_profiles.username <> EXCLUDED.username THEN now() ELSE bb_profiles.username_changed_at END,
          updated_at = now()`;
      // a different X handle (or none) drops the old verification; the tick has to be earned again for the new one
      const xChanged = !existing || (existing.x_handle ?? "") !== f.x_handle;
      if (xChanged) {
        await t`UPDATE bb_profiles SET x_handle = ${f.x_handle || null}, x_user_id = NULL, x_post_id = NULL, x_verified_at = NULL, x_account_created = NULL,
                x_followers = NULL, x_checked_at = NULL, x_status = 'none' WHERE wallet = ${me}`;
      }
      let code: XCodeView | null = null;
      const verified = !xChanged && existing?.x_status === "verified";
      if (f.x_handle && !verified) {
        await t`UPDATE bb_x_codes SET used_at = now() WHERE wallet = ${me} AND used_at IS NULL AND review IS NULL`;
        const c = newXCode();
        const expires = new Date(now + X_CODE_TTL_MS).toISOString();
        await t`INSERT INTO bb_x_codes (code, wallet, x_handle, expires_at) VALUES (${c}, ${me}, ${f.x_handle}, ${expires})`;
        code = codeView(c, f.x_handle, expires, f.username);
      }
      const row = await rowByWallet(t, me);
      return { ok: true as const, profile: shape(row!), code, renamed };
    });
    forgetName(me);
    return result as Awaited<ReturnType<typeof saveProfile>>;
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") return fail("that username is taken", 409);
    throw err;
  }
}

// ── verify X ─────────────────────────────────────────────────────────────────
export async function verifyXPost(r: { wallet: unknown; postUrl: unknown }): Promise<{ ok: true; status: "verified" | "pending_review"; profile: PublicProfile | null } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (typeof r.wallet !== "string" || !isAddress(r.wallet)) return fail("bad wallet", 400);
  const me = r.wallet.toLowerCase();
  const post = parsePostUrl(r.postUrl);
  if (!post) return fail("paste the link to your post (x.com/you/status/…)", 400);
  if (rateLimited(`xverify:wallet:${me}`, 10, 60 * 60_000)) return fail("too many tries, wait a bit", 429);
  const [code] = await db<CodeRow[]>`SELECT code, x_handle, expires_at, used_at FROM bb_x_codes WHERE wallet = ${me} AND used_at IS NULL AND review IS NULL ORDER BY issued_at DESC LIMIT 1`;
  if (!code) return fail("save your profile with your X handle first; that gives you a code to post", 400);
  const prof = await rowByWallet(db, me);
  if (!prof || prof.x_handle !== code.x_handle) return fail("your X handle changed since this code; save your profile again for a new one", 400);

  const facts = await fetchPostFacts(post.handle, post.id);
  const j = judgePost({ code, facts, now: Date.now() });
  if (!j.ok) {
    // X answered nobody: a person checks it (only for a link that at least names the right account)
    if (j.review && post.handle.toLowerCase() === code.x_handle) {
      await db`UPDATE bb_x_codes SET post_id = ${post.id}, submitted_at = now(), review = 'pending' WHERE code = ${code.code} AND used_at IS NULL`;
      await db`UPDATE bb_profiles SET x_status = 'pending_review', x_post_id = ${post.id}, updated_at = now() WHERE wallet = ${me} AND x_status <> 'verified'`;
      return { ok: true, status: "pending_review", profile: await getProfile({ wallet: me }) };
    }
    return fail(j.error, j.review ? 503 : 400);
  }
  const done = await db.begin(async (tx) => {
    const t = tx as unknown as Db;
    const used = await t`UPDATE bb_x_codes SET used_at = now(), post_id = ${post.id}, submitted_at = now() WHERE code = ${code.code} AND used_at IS NULL RETURNING code`;
    if (used.length === 0) return false;
    // one X account, one wallet: verifying here releases it from any other wallet (only the account owner could post the code)
    const others = await t<{ wallet: string }[]>`
      UPDATE bb_profiles SET x_handle = NULL, x_user_id = NULL, x_post_id = NULL, x_verified_at = NULL, x_status = 'none', updated_at = now()
       WHERE wallet <> ${me} AND (x_user_id = ${j.userId} OR x_user_id = ${`h:${j.handle}`}) RETURNING wallet`;
    for (const o of others) forgetName(o.wallet);
    await t`
      UPDATE bb_profiles SET x_status = 'verified', x_handle = ${j.handle}, x_user_id = ${j.userId}, x_post_id = ${post.id}, x_verified_at = now(), x_checked_at = now(),
             x_account_created = ${facts.accountCreated}, x_followers = ${facts.followers}, updated_at = now()
       WHERE wallet = ${me}`;
    return true;
  });
  if (!done) return fail("that code was already used; save your profile again for a new one", 409);
  forgetName(me);
  return { ok: true, status: "verified", profile: await getProfile({ wallet: me }) };
}

// ── delete ───────────────────────────────────────────────────────────────────
export async function deleteProfile(r: Signed): Promise<{ ok: true } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  const a = await admit(db, r, (wallet, nonce, ts) => buildProfileDeleteMessage({ wallet, nonce, ts }));
  if (!a.ok) return a;
  await db.begin(async (tx) => {
    const t = tx as unknown as Db;
    const [gone] = await t<{ username: string }[]>`DELETE FROM bb_profiles WHERE wallet = ${a.wallet} RETURNING username`;
    if (gone) await t`INSERT INTO bb_username_holds (username, wallet, released_at) VALUES (${gone.username}, ${a.wallet}, now()) ON CONFLICT (username) DO UPDATE SET wallet = EXCLUDED.wallet, released_at = now()`;
    await t`UPDATE bb_x_codes SET used_at = now() WHERE wallet = ${a.wallet} AND used_at IS NULL`;
  });
  forgetName(a.wallet);
  return { ok: true };
}

// ── moderation ───────────────────────────────────────────────────────────────
export type ReviewRow = { wallet: string; username: string; display_name: string; x_handle: string | null; x_status: string; x_post_id: string | null; hidden: boolean; points_flag: string | null; created_at: string };

export async function listProfilesForReview(limit = 100): Promise<{ pending: ReviewRow[]; recent: ReviewRow[] }> {
  const db = maybeDb();
  if (!db) return { pending: [], recent: [] };
  const [pending, recent] = await Promise.all([
    db<ReviewRow[]>`SELECT wallet, username, display_name, x_handle, x_status, x_post_id, hidden, points_flag, created_at FROM bb_profiles WHERE x_status = 'pending_review' ORDER BY updated_at DESC LIMIT ${limit}`,
    db<ReviewRow[]>`SELECT wallet, username, display_name, x_handle, x_status, x_post_id, hidden, points_flag, created_at FROM bb_profiles ORDER BY created_at DESC LIMIT ${limit}`,
  ]);
  return { pending, recent };
}

export async function moderateProfile(r: Signed & { action: unknown; target: unknown; reason?: unknown }): Promise<{ ok: true } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (!isProfileModAction(r.action)) return fail("bad action", 400);
  if (typeof r.target !== "string" || !isAddress(r.target)) return fail("bad target", 400);
  if (typeof r.wallet !== "string" || !adminWallets().has(r.wallet.toLowerCase())) return fail("not an admin", 403);
  const action = r.action;
  const target = r.target.toLowerCase();
  const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, 200) : "";
  const a = await admit(db, r, (wallet, nonce, ts) => buildProfileModMessage({ action, target, wallet, nonce, ts, reason }));
  if (!a.ok) return a;
  const prof = await rowByWallet(db, target);
  if (!prof) return fail("no such profile", 404);
  switch (action) {
    case "approve_x":
    case "reject_x": {
      const [code] = await db<{ code: string; x_handle: string; post_id: string | null }[]>`SELECT code, x_handle, post_id FROM bb_x_codes WHERE wallet = ${target} AND review = 'pending' ORDER BY submitted_at DESC LIMIT 1`;
      if (!code) return fail("nothing to review", 404);
      if (action === "reject_x") {
        await db`UPDATE bb_x_codes SET review = 'rejected', used_at = now() WHERE code = ${code.code}`;
        await db`UPDATE bb_profiles SET x_status = 'none', x_post_id = NULL, updated_at = now() WHERE wallet = ${target} AND x_status = 'pending_review'`;
        break;
      }
      await db.begin(async (tx) => {
        const t = tx as unknown as Db;
        await t`UPDATE bb_x_codes SET review = 'approved', used_at = now() WHERE code = ${code.code}`;
        const key = `h:${code.x_handle}`;
        await t`UPDATE bb_profiles SET x_handle = NULL, x_user_id = NULL, x_post_id = NULL, x_verified_at = NULL, x_status = 'none', updated_at = now() WHERE wallet <> ${target} AND x_user_id = ${key}`;
        await t`UPDATE bb_profiles SET x_status = 'verified', x_handle = ${code.x_handle}, x_user_id = COALESCE(x_user_id, ${key}), x_post_id = ${code.post_id}, x_verified_at = now(), x_checked_at = NULL, updated_at = now() WHERE wallet = ${target}`;
      });
      break;
    }
    case "hide":
    case "unhide":
      await db`UPDATE bb_profiles SET hidden = ${action === "hide"}, updated_at = now() WHERE wallet = ${target}`;
      break;
    case "exclude_points":
    case "include_points":
      await db`UPDATE bb_profiles SET points_flag = ${action === "exclude_points" ? "excluded" : null}, points_flag_reason = ${action === "exclude_points" ? reason || null : null}, updated_at = now() WHERE wallet = ${target}`;
      break;
    case "reset_username":
      await db`UPDATE bb_profiles SET username = ${`user_${randomSuffix(8)}`}, updated_at = now() WHERE wallet = ${target}`;
      break;
  }
  forgetName(target);
  return { ok: true };
}

// ── re-check ─────────────────────────────────────────────────────────────────
let lastRecheck = 0;
const RECHECK_EVERY_MS = 10 * 60_000;

/**
 * Re-read verified posts older than a week, a small batch at a time (claimed with SKIP LOCKED so two machines never
 * read the same one). A post X says is gone pauses the tick ("reverify"); a post that answers refreshes the account
 * facts points use (age, followers) and upgrades a handle-only binding to the account id. No answer changes nothing.
 */
export async function recheckProfiles(batch = 20): Promise<number> {
  const db = maybeDb();
  const now = Date.now();
  if (!db || now - lastRecheck < RECHECK_EVERY_MS) return 0;
  lastRecheck = now;
  const rows = await db<{ wallet: string; x_handle: string | null; x_post_id: string | null; x_user_id: string | null; x_status: string }[]>`
    UPDATE bb_profiles p SET x_checked_at = now()
      FROM (SELECT wallet FROM bb_profiles WHERE x_status IN ('verified', 'post_missing') AND x_post_id IS NOT NULL AND x_handle IS NOT NULL
             AND (x_checked_at IS NULL OR x_checked_at < now() - interval '7 days') ORDER BY x_checked_at NULLS FIRST LIMIT ${batch} FOR UPDATE SKIP LOCKED) due
     WHERE p.wallet = due.wallet
     RETURNING p.wallet, p.x_handle, p.x_post_id, p.x_user_id, p.x_status`;
  let changed = 0;
  for (const r of rows) {
    if (!r.x_handle || !r.x_post_id) continue;
    const facts = await fetchPostFacts(r.x_handle, r.x_post_id);
    if (facts.found === null) continue;
    if (facts.found === false) {
      if (r.x_status !== "post_missing") {
        await db`UPDATE bb_profiles SET x_status = 'post_missing', updated_at = now() WHERE wallet = ${r.wallet} AND x_status = 'verified'`;
        changed++;
      }
      continue;
    }
    const upgrade = facts.userId && r.x_user_id?.startsWith("h:") ? facts.userId : null;
    if (upgrade) {
      const [taken] = await db`SELECT 1 FROM bb_profiles WHERE x_user_id = ${upgrade} AND wallet <> ${r.wallet}`;
      if (taken) continue; // another wallet already holds the account id: leave both for a person
    }
    await db`
      UPDATE bb_profiles SET x_status = 'verified', x_user_id = COALESCE(${upgrade}, x_user_id),
             x_account_created = COALESCE(${facts.accountCreated}, x_account_created), x_followers = COALESCE(${facts.followers}::int, x_followers), updated_at = now()
       WHERE wallet = ${r.wallet} AND x_status IN ('verified', 'post_missing')`;
    if (r.x_status === "post_missing") changed++;
  }
  for (const r of rows) forgetName(r.wallet);
  return changed;
}
