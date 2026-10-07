import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { publicClient } from "@/lib/chain";
import { CHAIN_KEYS, CHAIN_LABELS, DEFAULT_CHAIN, isChainKey, type ChainKey } from "@/lib/chainPublic";
import { maybeDb, type Db } from "@/lib/db";
import { BRAND_DOMAIN, BRAND_X } from "@/lib/brand";
import { rateLimited } from "@/lib/launchpad/editServer";
import { adminWallets } from "@/lib/launchpad/postsServer";
import { buildProfileAdminListMessage, buildProfileDeleteMessage, buildProfileMessage, buildProfileModMessage, isNonce, isProfileModAction, tsFresh } from "./auth";
import { avatarUrl, validateProfile } from "./validate";
import { X_CODE_TTL_MS, intentUrl, isXCode, judgePost, makeXCode, parsePostUrl, postTextFor, type CodeRow } from "./xpost";
import { fetchPostFacts } from "./xFetch";

/**
 * Server half of profiles. Rules, all enforced here regardless of the client:
 *   - every write is a wallet signature (auth.ts) checked BEFORE its single-use nonce is spent, so an RPC blip or
 *     a bad signature never burns a nonce; a plain wallet is recovered locally, a smart wallet (ERC-1271 / 6492) is
 *     checked on the chain it signed on, and only if it is deployed there or nowhere yet (an old owner cannot sign
 *     through an undeployed copy on another chain; a wallet deployed elsewhere is asked to switch)
 *   - usernames are unique, reserved names are refused (validate.ts), a name kept a day or more is held 30 days for
 *     its old wallet when dropped, and a name changes once per 30 days (free in the first day, and always to claim
 *     your own verified X handle); deleting keeps the row (flags and the rename clock survive a re-create)
 *   - the X tick needs a post carrying a one-time code bound to the wallet and the handle (xpost.ts); verifying needs
 *     that code, so nobody else can probe or spend someone's attempt; one X account belongs to one wallet; the
 *     claimed handle is never public before it is verified
 *   - admins (ADMIN_WALLETS) sign every read and action: approve a post X would not show us (only against the code
 *     that was issued), remove a tick, hide a profile, keep it off points boards, retire a username
 */

type Fail = { ok: false; error: string; status: number };
/** A failed result with its HTTP status. */
const fail = (error: string, status: number): Fail => ({ ok: false, error, status });

const DAY = 86_400_000;
const RENAME_COOLDOWN_MS = 30 * DAY;
const RENAME_GRACE_MS = DAY;
/** Names a moderator retired are held by this placeholder, effectively for good. */
const RETIRED = "0x0000000000000000000000000000000000000000";

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
  deleted_at: string | null;
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

/** The code to post, plus `secret`: the private verify key that never goes in the post (only this browser has it). */
export type XCodeView = { code: string; handle: string; expires_at: string; text: string; intent: string; secret: string };

/** The public X state for a stored status. */
function xState(s: Row["x_status"]): PublicProfile["x_state"] {
  return s === "verified" ? "verified" : s === "pending_review" ? "pending" : s === "post_missing" ? "reverify" : "none";
}

/** A stored profile as everyone sees it. */
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

/** The row for a wallet, deleted or not (saving decides what a deleted row means). */
async function rowByWallet(db: Db, wallet: string): Promise<Row | null> {
  const rows = await db<Row[]>`SELECT wallet, username, display_name, bio, avatar_key, x_handle, x_user_id, x_post_id, x_status, x_verified_at, x_account_created, x_followers, hidden, points_flag, username_changed_at, created_at, deleted_at FROM bb_profiles WHERE wallet = ${wallet}`;
  return rows[0] ?? null;
}

/** The visible profile for a wallet or a username, or null (hidden and deleted profiles never show). */
export async function getProfile(by: { wallet: string } | { username: string }): Promise<PublicProfile | null> {
  const db = maybeDb();
  if (!db) return null;
  const rows =
    "wallet" in by
      ? await db<Row[]>`SELECT wallet, username, display_name, bio, avatar_key, x_handle, x_user_id, x_post_id, x_status, x_verified_at, x_account_created, x_followers, hidden, points_flag, username_changed_at, created_at, deleted_at FROM bb_profiles WHERE wallet = ${by.wallet.toLowerCase()} AND NOT hidden AND deleted_at IS NULL`
      : await db<Row[]>`SELECT wallet, username, display_name, bio, avatar_key, x_handle, x_user_id, x_post_id, x_status, x_verified_at, x_account_created, x_followers, hidden, points_flag, username_changed_at, created_at, deleted_at FROM bb_profiles WHERE username = ${by.username.toLowerCase()} AND NOT hidden AND deleted_at IS NULL`;
  return rows[0] ? shape(rows[0]) : null;
}

// ── names map ────────────────────────────────────────────────────────────────
const nameCache = new Map<string, { at: number; v: NameEntry | null }>();
const NAME_TTL_MS = 30_000;

/** Drop a wallet from this machine's names cache (after it changes). */
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
    SELECT wallet, username, display_name, avatar_key, x_status FROM bb_profiles WHERE wallet = ANY(${miss}::text[]) AND NOT hidden AND deleted_at IS NULL`;
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
const deployedOn = new Map<string, { chains: ChainKey[]; at: number }>();

/**
 * Chains where the wallet has code (cached 10 min). Deployed on the chain it signed on settles it at once. Otherwise
 * every chain must answer: a chain that failed to answer could be where the wallet lives, and treating it as "deployed
 * nowhere" would let an old owner sign through an ERC-6492 wrapper. Null = could not be told; nothing is cached then.
 */
async function codeChains(wallet: string, first: ChainKey): Promise<ChainKey[] | null> {
  const hit = deployedOn.get(wallet);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.chains;
  const order = [first, ...CHAIN_KEYS.filter((k) => k !== first)];
  const chains: ChainKey[] = [];
  for (const c of order) {
    try {
      const code = await publicClient(c).getCode({ address: wallet as Address });
      if (code && code !== "0x") chains.push(c);
      if (c === first && chains.length) break; // deployed where it signed: that is all we need
    } catch {
      return null;
    }
  }
  if (deployedOn.size > 10_000) deployedOn.clear();
  deployedOn.set(wallet, { chains, at: Date.now() });
  return chains;
}

type SigCheck = "ok" | "bad" | "down" | { switchTo: ChainKey };

/**
 * A plain wallet's signature is recovered locally (no RPC). A smart wallet's is checked on the chain it signed on
 * (Coinbase Smart Wallet and Safe bind the chain id into what they sign), and only where it is deployed or, if it is
 * deployed nowhere yet, through its ERC-6492 wrapper. Deployed only elsewhere → ask the person to switch chains.
 */
async function verifySig(wallet: string, message: string, signature: unknown, signedOn: unknown): Promise<SigCheck> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return "bad";
  try {
    if ((await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase() === wallet) return "ok";
  } catch {
    /* not a plain 65-byte signature: a smart wallet's */
  }
  const chain: ChainKey = isChainKey(signedOn) ? signedOn : DEFAULT_CHAIN;
  const home = await codeChains(wallet, chain);
  if (home === null) return "down";
  if (home.length > 0 && !home.includes(chain)) return { switchTo: home.includes(DEFAULT_CHAIN) ? DEFAULT_CHAIN : home[0] };
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

/** Spend a profile nonce; false when it was already used (a replay). */
async function consumeNonce(db: Db, nonce: string, wallet: string): Promise<boolean> {
  try {
    await db`INSERT INTO bb_profile_nonces (nonce, wallet) VALUES (${nonce}, ${wallet})`;
    void db`DELETE FROM bb_profile_nonces WHERE created_at < now() - interval '1 hour'`.catch(() => {});
    return true;
  } catch {
    return false; // duplicate → replay
  }
}

type Signed = { chain?: unknown; wallet: unknown; nonce: unknown; ts: unknown; signature: unknown };

/** Shared front of every signed write: shapes, freshness, signature, then (only then) the nonce. */
async function admit(db: Db, s: Signed, message: (w: string, nonce: string, ts: number) => string): Promise<{ ok: true; wallet: string; ts: number } | Fail> {
  if (typeof s.wallet !== "string" || !isAddress(s.wallet)) return fail("bad wallet", 400);
  if (!isNonce(s.nonce)) return fail("bad nonce", 400);
  const now = Date.now();
  if (!tsFresh(s.ts, now)) return fail("signature expired, try again", 400);
  const wallet = s.wallet.toLowerCase();
  const ts = Number(s.ts);
  const v = await verifySig(wallet, message(wallet, s.nonce, ts), s.signature, s.chain);
  if (v === "down") return fail("signature check unavailable, try again", 503);
  if (v === "bad") return fail("signature does not match (with a smart wallet, switch it to Base and sign again)", 401);
  if (typeof v === "object") return fail(`your wallet lives on ${CHAIN_LABELS[v.switchTo]}: switch your wallet to ${CHAIN_LABELS[v.switchTo]} and sign again`, 409);
  // the wallet bucket is spent only after the wallet is proven (a stranger cannot freeze someone's edits)
  if (rateLimited(`profile:wallet:${wallet}`, 12)) return fail("slow down", 429);
  if (!(await consumeNonce(db, s.nonce, wallet))) return fail("nonce already used", 401);
  return { ok: true, wallet, ts };
}

/** Random lowercase letters and digits without look-alikes. */
function randomSuffix(n: number): string {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(randomBytes(n), (b) => a[b % a.length]).join("");
}

/** A fresh one-time X code. */
function newXCode(): string {
  for (;;) {
    const c = makeXCode(randomBytes(32));
    if (c) return c;
  }
}

/** The post text and intent link for a code, with the private verify key that goes with it. */
export function codeView(code: string, handle: string, expiresAt: string, username: string, secret: string): XCodeView {
  const text = postTextFor(username, code, BRAND_X, BRAND_DOMAIN);
  return { code, handle, expires_at: expiresAt, text, intent: intentUrl(text), secret };
}

/** Hex sha256 of a string. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Constant-time check of a presented verify key against the stored hash. */
function secretMatches(secret: unknown, hash: string | null): boolean {
  if (typeof secret !== "string" || !/^[0-9a-f]{32}$/.test(secret) || !hash || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(sha256(secret), "hex"), Buffer.from(hash, "hex"));
}

/** A dropped name is held for its wallet only if it was really theirs (kept a day or more): no farming of holds. */
function holdable(r: Row, now: number): boolean {
  if (r.deleted_at || r.username.startsWith("~")) return false;
  const since = new Date(r.username_changed_at ?? r.created_at).getTime();
  return now - since >= DAY;
}

// ── save ─────────────────────────────────────────────────────────────────────
export type SaveRequest = Signed & { fields: Record<string, unknown> };

/** Save a signed profile: name rules, holds and the rename clock, the X claim, and a fresh code + verify key when the claim needs verifying. */
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
      const claimingOwnX = Boolean(existing && !existing.deleted_at && existing.x_status === "verified" && existing.x_handle === f.username);
      let renamed: string | undefined;
      if (nameChange) {
        const [held] = await t<{ wallet: string }[]>`SELECT wallet FROM bb_username_holds WHERE username = ${f.username} AND released_at > now() - interval '30 days'`;
        const restoringOwn = Boolean(held && held.wallet === me);
        // the rename clock: free in the first day of the profile, to take back your own held name, or to claim your verified X handle
        if (existing && !claimingOwnX && !restoringOwn && now - new Date(existing.created_at).getTime() > RENAME_GRACE_MS && existing.username_changed_at && now - new Date(existing.username_changed_at).getTime() < RENAME_COOLDOWN_MS) {
          return fail("you can change your username once every 30 days", 429);
        }
        // holds yield only to the verified owner of the same X handle (a retired name never does)
        if (held && held.wallet !== me && (!claimingOwnX || held.wallet === RETIRED)) return fail("that username is taken", 409);
        const [holder] = await t<{ wallet: string; x_status: string }[]>`SELECT wallet, x_status FROM bb_profiles WHERE username = ${f.username}`;
        if (holder && holder.wallet !== me) {
          // a verified X owner takes their own handle back from an unverified profile; everyone else waits
          if (!claimingOwnX || holder.x_status === "verified") return fail("that username is taken", 409);
          const base = f.username.slice(0, 15).replace(/_+$/, "").padEnd(3, "x");
          for (let i = 0; i < 8 && !renamed; i++) {
            const candidate = `${base}_${randomSuffix(4)}`;
            const [clash] = await t`SELECT 1 FROM bb_profiles WHERE username = ${candidate}`;
            if (!clash) renamed = candidate;
          }
          if (!renamed) return fail("could not free that username, try again", 503);
          const moved = await t`UPDATE bb_profiles SET username = ${renamed}, updated_at = now() WHERE wallet = ${holder.wallet} AND username = ${f.username} RETURNING wallet`;
          if (moved.length === 0) return fail("that username just changed hands, try again", 409);
          forgetName(holder.wallet);
        }
        if (existing && holdable(existing, now)) {
          await t`INSERT INTO bb_username_holds (username, wallet, released_at) VALUES (${existing.username}, ${me}, now())
                  ON CONFLICT (username) DO UPDATE SET wallet = EXCLUDED.wallet, released_at = now() WHERE bb_username_holds.wallet <> ${RETIRED}`;
        }
        await t`DELETE FROM bb_username_holds WHERE username = ${f.username} AND wallet = ${me}`;
      }
      await t`
        INSERT INTO bb_profiles (wallet, username, display_name, bio, avatar_key, x_handle)
        VALUES (${me}, ${f.username}, ${f.display_name}, ${f.bio || null}, ${f.avatar_key}, ${f.x_handle || null})
        ON CONFLICT (wallet) DO UPDATE SET
          username = EXCLUDED.username, display_name = EXCLUDED.display_name, bio = EXCLUDED.bio, avatar_key = EXCLUDED.avatar_key,
          username_changed_at = CASE WHEN bb_profiles.username <> EXCLUDED.username THEN now() ELSE bb_profiles.username_changed_at END,
          deleted_at = NULL, updated_at = now()`;
      // a different X handle (or none) drops the old verification and any pending review: the tick is earned again
      const xChanged = !existing || Boolean(existing.deleted_at) || (existing.x_handle ?? "") !== f.x_handle;
      if (xChanged) {
        await t`UPDATE bb_profiles SET x_handle = ${f.x_handle || null}, x_user_id = NULL, x_post_id = NULL, x_verified_at = NULL, x_account_created = NULL,
                x_followers = NULL, x_checked_at = NULL, x_status = 'none' WHERE wallet = ${me}`;
        await t`UPDATE bb_x_codes SET used_at = now(), review = CASE WHEN review = 'pending' THEN 'rejected' ELSE review END WHERE wallet = ${me} AND used_at IS NULL`;
      }
      let code: XCodeView | null = null;
      const verified = !xChanged && existing?.x_status === "verified";
      if (f.x_handle && !verified) {
        await t`UPDATE bb_x_codes SET used_at = now() WHERE wallet = ${me} AND used_at IS NULL AND review IS NULL`;
        const c = newXCode();
        const secret = randomBytes(16).toString("hex");
        const expires = new Date(now + X_CODE_TTL_MS).toISOString();
        await t`INSERT INTO bb_x_codes (code, wallet, x_handle, expires_at, secret_hash) VALUES (${c}, ${me}, ${f.x_handle}, ${expires}, ${sha256(secret)})`;
        code = codeView(c, f.x_handle, expires, f.username, secret);
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
const NO_CODE = "that code is not open for this wallet; save your profile again for a new one";

/**
 * Check a post against the wallet's open code. The code itself is public once posted, so the request must also carry
 * the private verify key that was returned only to the signer at save time. Without both, nothing happens: no
 * rate-limit bucket is spent, no lookup is made, nothing is said about the claimed handle, and nothing can be pushed
 * into the review queue. A stranger who read the post holds the code and the wallet, never the key.
 */
export async function verifyXPost(r: { wallet: unknown; postUrl: unknown; code: unknown; secret: unknown }): Promise<{ ok: true; status: "verified" | "pending_review"; profile: PublicProfile | null } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (typeof r.wallet !== "string" || !isAddress(r.wallet)) return fail("bad wallet", 400);
  if (!isXCode(r.code)) return fail(NO_CODE, 400);
  const me = r.wallet.toLowerCase();
  const post = parsePostUrl(r.postUrl);
  if (!post) return fail("paste the link to your post (x.com/you/status/…)", 400);
  const [code] = await db<(CodeRow & { secret_hash: string | null })[]>`SELECT code, x_handle, expires_at, used_at, secret_hash FROM bb_x_codes WHERE wallet = ${me} AND code = ${r.code} AND used_at IS NULL AND review IS NULL`;
  if (!code || !secretMatches(r.secret, code.secret_hash)) return fail(NO_CODE, 400);
  if (rateLimited(`xverify:wallet:${me}`, 10, 60 * 60_000)) return fail("too many tries, wait a bit", 429);
  const prof = await rowByWallet(db, me);
  if (!prof || prof.deleted_at || prof.x_handle !== code.x_handle) return fail(NO_CODE, 400);

  const facts = await fetchPostFacts(post.handle, post.id);
  const j = judgePost({ code, facts, now: Date.now() });
  if (!j.ok) {
    // X answered nobody: a person checks it against this code (only for a link that at least names the right account)
    if (j.review && post.handle.toLowerCase() === code.x_handle) {
      // code and profile change together, under the profile lock that save, delete and moderate take first: a save
      // in between can never leave the profile waiting for review with no code behind it
      const queued = await db.begin(async (tx) => {
        const t = tx as unknown as Db;
        await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${me}`}))`;
        const current = await rowByWallet(t, me);
        if (!current || current.deleted_at || current.x_status === "verified" || current.x_handle !== code.x_handle) return false;
        const queuedCode = await t`UPDATE bb_x_codes SET post_id = ${post.id}, submitted_at = now(), review = 'pending' WHERE code = ${code.code} AND used_at IS NULL AND review IS NULL RETURNING code`;
        if (queuedCode.length === 0) return false;
        await t`UPDATE bb_profiles SET x_status = 'pending_review', x_post_id = ${post.id}, updated_at = now() WHERE wallet = ${me}`;
        return true;
      });
      if (!queued) return fail(NO_CODE, 400);
      return { ok: true, status: "pending_review", profile: await getProfile({ wallet: me }) };
    }
    return fail(j.error, j.review ? 503 : 400);
  }
  const done = await db.begin(async (tx) => {
    const t = tx as unknown as Db;
    // the profile lock first, as save and delete take it: the same rows are never locked in opposite orders
    await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${me}`}))`;
    const used = await t`UPDATE bb_x_codes SET used_at = now(), post_id = ${post.id}, submitted_at = now() WHERE code = ${code.code} AND used_at IS NULL RETURNING code`;
    if (used.length === 0) return false;
    // one X account, one wallet: verifying here releases it from any other wallet (only the account owner could post the code)
    const others = await t<{ wallet: string }[]>`
      UPDATE bb_profiles SET x_handle = NULL, x_user_id = NULL, x_post_id = NULL, x_verified_at = NULL, x_status = 'none', updated_at = now()
       WHERE wallet <> ${me} AND (x_user_id = ${j.userId} OR x_user_id = ${`h:${j.handle}`} OR (x_handle = ${j.handle} AND x_status IN ('verified', 'post_missing'))) RETURNING wallet`;
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
/**
 * Delete = the profile disappears everywhere and its name is released, but the row stays: moderation flags,
 * created_at and the rename clock survive, so deleting and re-creating is not a way around either. Coming back
 * follows the same clock as a rename (your own held name is always free to take back).
 */
export async function deleteProfile(r: Signed): Promise<{ ok: true } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  const a = await admit(db, r, (wallet, nonce, ts) => buildProfileDeleteMessage({ wallet, nonce, ts }));
  if (!a.ok) return a;
  const now = Date.now();
  await db.begin(async (tx) => {
    const t = tx as unknown as Db;
    await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${a.wallet}`}))`;
    const existing = await rowByWallet(t, a.wallet);
    if (!existing || existing.deleted_at) return;
    if (holdable(existing, now)) {
      await t`INSERT INTO bb_username_holds (username, wallet, released_at) VALUES (${existing.username}, ${a.wallet}, now())
              ON CONFLICT (username) DO UPDATE SET wallet = EXCLUDED.wallet, released_at = now() WHERE bb_username_holds.wallet <> ${RETIRED}`;
    }
    await t`
      UPDATE bb_profiles SET deleted_at = now(), username = ${`~del_${randomSuffix(12)}`}, display_name = '', bio = NULL, avatar_key = NULL,
             x_handle = NULL, x_user_id = NULL, x_post_id = NULL, x_verified_at = NULL, x_account_created = NULL, x_followers = NULL, x_checked_at = NULL,
             x_status = 'none', updated_at = now()
       WHERE wallet = ${a.wallet}`;
    await t`UPDATE bb_x_codes SET used_at = now(), review = CASE WHEN review = 'pending' THEN 'rejected' ELSE review END WHERE wallet = ${a.wallet} AND used_at IS NULL`;
  });
  forgetName(a.wallet);
  return { ok: true };
}

// ── moderation ───────────────────────────────────────────────────────────────
export type ReviewRow = {
  wallet: string;
  username: string;
  display_name: string;
  x_handle: string | null;
  x_status: string;
  hidden: boolean;
  points_flag: string | null;
  created_at: string;
  /** pending only: the code that was issued for this claim and the post that was submitted */
  code: string | null;
  post_id: string | null;
};

/** The review queue, for a signed admin read (it lists claimed, not yet verified handles). */
export async function listProfilesForReview(r: Signed, limit = 100): Promise<{ ok: true; pending: ReviewRow[]; recent: ReviewRow[] } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (typeof r.wallet !== "string" || !adminWallets().has(r.wallet.toLowerCase())) return fail("not an admin", 403);
  const a = await admit(db, r, (wallet, nonce, ts) => buildProfileAdminListMessage({ wallet, nonce, ts }));
  if (!a.ok) return a;
  const [pending, recent] = await Promise.all([
    db<ReviewRow[]>`
      SELECT p.wallet, p.username, p.display_name, p.x_handle, p.x_status, p.hidden, p.points_flag, p.created_at, c.code, c.post_id
        FROM bb_profiles p JOIN LATERAL (SELECT code, post_id FROM bb_x_codes WHERE wallet = p.wallet AND review = 'pending' ORDER BY submitted_at DESC LIMIT 1) c ON true
       WHERE p.x_status = 'pending_review' AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT ${limit}`,
    db<ReviewRow[]>`
      SELECT wallet, username, display_name, x_handle, x_status, hidden, points_flag, created_at, NULL::text AS code, x_post_id AS post_id
        FROM bb_profiles WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ${limit}`,
  ]);
  return { ok: true, pending, recent };
}

/** Apply one admin-signed moderation action to a profile. */
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
  // every action runs under the profile lock that save, delete and verify take first, and judges the profile and its
  // pending code as they are now: an owner's save between an admin's look and the write can never be overridden
  // (approving @a after the claim moved to @b refuses instead of marking @b verified)
  const refused = await db.begin(async (tx): Promise<Fail | null> => {
    const t = tx as unknown as Db;
    await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${target}`}))`;
    const prof = await rowByWallet(t, target);
    if (!prof) return fail("no such profile", 404);
    switch (action) {
      case "approve_x":
      case "reject_x": {
        const [code] = await t<{ code: string; x_handle: string; post_id: string | null }[]>`SELECT code, x_handle, post_id FROM bb_x_codes WHERE wallet = ${target} AND review = 'pending' ORDER BY submitted_at DESC LIMIT 1`;
        if (!code) return fail("nothing to review", 404);
        if (action === "reject_x") {
          await t`UPDATE bb_x_codes SET review = 'rejected', used_at = now() WHERE code = ${code.code}`;
          await t`UPDATE bb_profiles SET x_status = 'none', x_post_id = NULL, updated_at = now() WHERE wallet = ${target} AND x_status = 'pending_review'`;
          return null;
        }
        // only the claim that is pending, for the handle this code was issued for
        if (prof.deleted_at || prof.x_status !== "pending_review" || prof.x_handle !== code.x_handle) return fail("this claim changed since it was submitted; reject it", 409);
        // a handle another wallet has verified is not handed out by hand
        const [taken] = await t`SELECT 1 FROM bb_profiles WHERE wallet <> ${target} AND deleted_at IS NULL AND x_handle = ${code.x_handle} AND x_status IN ('verified', 'post_missing')`;
        if (taken) return fail(`@${code.x_handle} is already verified by another wallet; reject this one`, 409);
        await t`UPDATE bb_x_codes SET review = 'approved', used_at = now() WHERE code = ${code.code}`;
        await t`UPDATE bb_profiles SET x_status = 'verified', x_user_id = COALESCE(x_user_id, ${`h:${code.x_handle}`}), x_post_id = ${code.post_id}, x_verified_at = now(), x_checked_at = NULL, updated_at = now() WHERE wallet = ${target}`;
        return null;
      }
      case "remove_x":
        await t`UPDATE bb_profiles SET x_handle = NULL, x_user_id = NULL, x_post_id = NULL, x_verified_at = NULL, x_account_created = NULL, x_followers = NULL, x_checked_at = NULL, x_status = 'none', updated_at = now() WHERE wallet = ${target}`;
        await t`UPDATE bb_x_codes SET used_at = now(), review = CASE WHEN review = 'pending' THEN 'rejected' ELSE review END WHERE wallet = ${target} AND used_at IS NULL`;
        return null;
      case "hide":
      case "unhide":
        await t`UPDATE bb_profiles SET hidden = ${action === "hide"}, updated_at = now() WHERE wallet = ${target}`;
        return null;
      case "exclude_points":
      case "include_points":
        await t`UPDATE bb_profiles SET points_flag = ${action === "exclude_points" ? "excluded" : null}, points_flag_reason = ${action === "exclude_points" ? reason || null : null}, updated_at = now() WHERE wallet = ${target}`;
        return null;
      case "reset_username":
        if (prof.deleted_at) return fail("a deleted profile has no username to retire", 409);
        // the old name is retired (held by nobody, effectively for good) and the rename clock starts again
        await t`INSERT INTO bb_username_holds (username, wallet, released_at) VALUES (${prof.username}, ${RETIRED}, now() + interval '100 years')
                ON CONFLICT (username) DO UPDATE SET wallet = EXCLUDED.wallet, released_at = EXCLUDED.released_at`;
        await t`UPDATE bb_profiles SET username = ${`user_${randomSuffix(8)}`}, username_changed_at = now(), updated_at = now() WHERE wallet = ${target}`;
        return null;
    }
    return null;
  });
  if (refused) return refused;
  forgetName(target);
  return { ok: true };
}

// ── re-check ─────────────────────────────────────────────────────────────────
let lastRecheck = 0;
const RECHECK_EVERY_MS = 10 * 60_000;

/**
 * Re-read verified posts older than a week, a small batch at a time (claimed with SKIP LOCKED so two machines never
 * read the same one). The post must still be there AND still be by the bound account: a post X says is gone, or one
 * now attributed to a different account, pauses the tick ("reverify"). The same account under a new handle (a rename
 * on X) updates the handle. A post that answers refreshes the facts points use (account age, followers) and upgrades
 * a handle-only binding to the account id. No answer changes nothing.
 */
export async function recheckProfiles(batch = 20): Promise<number> {
  const db = maybeDb();
  const now = Date.now();
  if (!db || now - lastRecheck < RECHECK_EVERY_MS) return 0;
  lastRecheck = now;
  const rows = await db<{ wallet: string; x_handle: string | null; x_post_id: string | null; x_user_id: string | null; x_status: string }[]>`
    UPDATE bb_profiles p SET x_checked_at = now()
      FROM (SELECT wallet FROM bb_profiles WHERE x_status IN ('verified', 'post_missing') AND deleted_at IS NULL AND x_post_id IS NOT NULL AND x_handle IS NOT NULL
             AND (x_checked_at IS NULL OR x_checked_at < now() - interval '7 days') ORDER BY x_checked_at NULLS FIRST LIMIT ${batch} FOR UPDATE SKIP LOCKED) due
     WHERE p.wallet = due.wallet
     RETURNING p.wallet, p.x_handle, p.x_post_id, p.x_user_id, p.x_status`;
  let changed = 0;
  const pause = async (wallet: string) => {
    const up = await db`UPDATE bb_profiles SET x_status = 'post_missing', updated_at = now() WHERE wallet = ${wallet} AND x_status = 'verified' RETURNING wallet`;
    changed += up.length;
  };
  for (const r of rows) {
    if (!r.x_handle || !r.x_post_id) continue;
    const facts = await fetchPostFacts(r.x_handle, r.x_post_id);
    if (facts.found === null) continue;
    if (facts.found === false || !facts.handle) {
      await pause(r.wallet);
      continue;
    }
    const boundId = r.x_user_id && !r.x_user_id.startsWith("h:") ? r.x_user_id : null;
    // the post now reads as another account's: never keep a tick we cannot tie to the bound account
    if (boundId && facts.userId && facts.userId !== boundId) {
      await pause(r.wallet);
      continue;
    }
    const sameHandle = facts.handle.toLowerCase() === r.x_handle;
    if (!sameHandle && !(boundId && facts.userId === boundId)) {
      await pause(r.wallet);
      continue;
    }
    const upgrade = !boundId && facts.userId ? facts.userId : null;
    if (upgrade) {
      const [taken] = await db`SELECT 1 FROM bb_profiles WHERE x_user_id = ${upgrade} AND wallet <> ${r.wallet}`;
      if (taken) {
        await pause(r.wallet); // another wallet holds the account id: leave this one for a person
        continue;
      }
    }
    await db`
      UPDATE bb_profiles SET x_status = 'verified', x_handle = ${facts.handle.toLowerCase()}, x_user_id = COALESCE(${upgrade}, x_user_id),
             x_account_created = COALESCE(${facts.accountCreated}, x_account_created), x_followers = COALESCE(${facts.followers}::int, x_followers), updated_at = now()
       WHERE wallet = ${r.wallet} AND x_status IN ('verified', 'post_missing')`;
    if (r.x_status === "post_missing") changed++;
  }
  for (const r of rows) forgetName(r.wallet);
  return changed;
}
