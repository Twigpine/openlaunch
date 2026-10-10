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
import type { NameEntry } from "./names-client";

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
// a retired username is held by this marker, which can never be a wallet (no signature can ever be "from" it)
const RETIRED = "retired";
const ZERO_ADDRESS = /^0x0{40}$/;

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

/** One entry of the names map that rides along with trades, holders and posts (one definition, in the names store). */
export type { NameEntry };

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

/**
 * Whether a moderator hid this wallet's profile (not deleted: a deleted one is gone and may be made again). The
 * contents stay private; only this fact is public, the way a suspended account says so, so the owner's card can say
 * why there is no profile instead of offering to create one.
 */
export async function profileHidden(wallet: string): Promise<boolean> {
  const db = maybeDb();
  if (!db) return false;
  const [row] = await db`SELECT 1 FROM bb_profiles WHERE wallet = ${wallet.toLowerCase()} AND hidden AND deleted_at IS NULL`;
  return Boolean(row);
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
// "this wallet has code on this chain": once true, true for good (deployed code stays), so it is cached for good.
// "no code" is never cached: it can turn true any moment (a deploy), and a remembered "deployed nowhere" is exactly
// what would let an old owner sign through an ERC-6492 wrapper after the wallet was deployed and its key rotated.
const hasCode = new Set<string>();

/**
 * Chains where the wallet has code. Deployed on the chain it signed on settles it at once. Otherwise every chain must
 * answer: a chain that failed to answer could be where the wallet lives, and treating it as "deployed nowhere" would
 * let an old owner sign through an ERC-6492 wrapper. Null = could not be told.
 */
async function codeChains(wallet: string, first: ChainKey): Promise<ChainKey[] | null> {
  const known = (c: ChainKey) => hasCode.has(`${c}:${wallet}`);
  const check = async (c: ChainKey): Promise<boolean | null> => {
    if (known(c)) return true;
    try {
      const code = await publicClient(c).getCode({ address: wallet as Address });
      if (!code || code === "0x") return false;
      if (hasCode.size > 20_000) hasCode.clear();
      hasCode.add(`${c}:${wallet}`);
      return true;
    } catch {
      return null;
    }
  };
  const here = await check(first);
  if (here === null) return null;
  if (here) return [first]; // deployed where it signed: that is all we need
  const chains: ChainKey[] = [];
  for (const c of CHAIN_KEYS.filter((k) => k !== first)) {
    const there = await check(c);
    if (there === null) return null;
    if (there) chains.push(c);
  }
  return chains;
}

type SigCheck = "ok" | "bad" | "down" | { switchTo: ChainKey };

/**
 * Whether `signature` is the wallet's over any one of `messages`. A plain wallet's signature is recovered locally, for
 * every candidate text first (no RPC, so a brief node outage can never turn a good plain signature into "down"). Only
 * when none recovers is it treated as a smart wallet's: checked on the chain it signed on (Coinbase Smart Wallet and
 * Safe bind the chain id into what they sign), and only where it is deployed or, if it is deployed nowhere yet,
 * through its ERC-6492 wrapper. Deployed only elsewhere → ask the person to switch chains.
 */
async function verifySig(wallet: string, messages: readonly string[], signature: unknown, signedOn: unknown): Promise<SigCheck> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return "bad";
  // the zero address has no key and no code: an ERC-6492 check compares ecrecover's failure value (0x0) to it and
  // passes for a garbage signature, so nothing is ever accepted as signed by it
  if (ZERO_ADDRESS.test(wallet)) return "bad";
  for (const message of messages) {
    try {
      if ((await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase() === wallet) return "ok";
    } catch {
      break; // not a plain 65-byte signature: a smart wallet's (the shape does not depend on the text)
    }
  }
  const chain: ChainKey = isChainKey(signedOn) ? signedOn : DEFAULT_CHAIN;
  const home = await codeChains(wallet, chain);
  if (home === null) return "down";
  if (home.length > 0 && !home.includes(chain)) return { switchTo: home.includes(DEFAULT_CHAIN) ? DEFAULT_CHAIN : home[0] };
  // every candidate text is tried before an outage is reported: one that answers "valid" settles it
  let unreachable = false;
  for (const message of messages) {
    try {
      if (await publicClient(chain).verifyMessage({ address: wallet as Address, message, signature: signature as Hex })) return "ok";
    } catch {
      unreachable = true;
    }
  }
  if (unreachable) return "down";
  // viem returns false (not a throw) on an unreachable transport: tell an outage from a mismatch
  try {
    await publicClient(chain).getChainId();
  } catch {
    return "down";
  }
  return "bad";
}

/**
 * Every fact of an X claim except the handle, back to "no claim": the one SET list for each place that drops a claim (a
 * new or cleared handle, a delete, a rejected or removed tick, another wallet proving the account).
 */
const noXClaim = (t: Db) => t`x_user_id = NULL, x_post_id = NULL, x_verified_at = NULL, x_account_created = NULL, x_followers = NULL, x_checked_at = NULL, x_status = 'none'`;
/** Close a wallet's open X codes; a claim still waiting for review is rejected with them. */
const closeXCodes = (t: Db, wallet: string) => t`UPDATE bb_x_codes SET used_at = now(), review = CASE WHEN review = 'pending' THEN 'rejected' ELSE review END WHERE wallet = ${wallet} AND used_at IS NULL`;

/** Spend a profile nonce; false when it was already used (a replay). */
async function consumeNonce(db: Db, nonce: string, wallet: string): Promise<boolean> {
  try {
    await db`INSERT INTO bb_profile_nonces (nonce, wallet) VALUES (${nonce}, ${wallet})`;
    void db`DELETE FROM bb_profile_nonces WHERE created_at < now() - interval '1 hour'`.catch(() => {});
    return true;
  } catch (err) {
    // only a duplicate is a replay; any other failure (the database is down) is an error, not "already used"
    if ((err as { code?: string })?.code === "23505") return false;
    throw err;
  }
}

export type Signed = { chain?: unknown; wallet: unknown; nonce: unknown; ts: unknown; signature: unknown };

/** An admin-signed request from another feature (points): admin wallet, then the same front as every signed write. */
export async function admitAdmin(s: Signed, message: (w: string, nonce: string, ts: number) => string): Promise<{ ok: true; wallet: string } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (typeof s.wallet !== "string" || !adminWallets().has(s.wallet.toLowerCase())) return fail("not an admin", 403);
  const a = await admit(db, s, message);
  return a.ok ? { ok: true, wallet: a.wallet } : a;
}

/**
 * Shared front of every signed write: shapes, freshness, signature, then (only then) the rate-limit bucket and the
 * nonce. The signature may be over any one of several candidate messages, tried in order (a save accepts its fields
 * exactly as sent or their cleaned form).
 */
async function admit(db: Db, s: Signed, message: (w: string, nonce: string, ts: number) => string | string[]): Promise<{ ok: true; wallet: string; ts: number } | Fail> {
  if (typeof s.wallet !== "string" || !isAddress(s.wallet)) return fail("bad wallet", 400);
  if (!isNonce(s.nonce)) return fail("bad nonce", 400);
  const now = Date.now();
  if (!tsFresh(s.ts, now)) return fail("signature expired, try again", 400);
  const wallet = s.wallet.toLowerCase();
  const ts = Number(s.ts);
  const v = await verifySig(wallet, [...new Set([message(wallet, s.nonce, ts)].flat())], s.signature, s.chain);
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
  // the signature is checked over exactly the fields that were sent (what our form shows and signs), and failing
  // that over their cleaned form (a client that signs what it will be stored as); the stored values are always the
  // cleaned ones. A browser that cleans text slightly differently from the server can then never fail a save.
  const asText = (x: unknown) => (typeof x === "string" ? x : "");
  const signed = { username: asText(r.fields.username), display_name: asText(r.fields.display_name), bio: asText(r.fields.bio), avatar_key: asText(r.fields.avatar) || null, x_handle: asText(r.fields.x_handle) };
  // the as-sent text is a candidate only when it holds no control characters (the bio may keep line breaks): a crafted
  // client must never be able to put extra lines into the message the wallet shows its owner
  // (C0/C1 controls, bidi marks, overrides and isolates, and the line / paragraph separators)
  const UNSHOWABLE = "\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069";
  const oneLine = new RegExp(`[\\u000a${UNSHOWABLE}]`);
  const bioOk = new RegExp(`[${UNSHOWABLE}]`);
  const plain = [signed.username, signed.display_name, signed.avatar_key ?? "", signed.x_handle].every((x) => !oneLine.test(x)) && !bioOk.test(signed.bio);
  const a = await admit(db, r, (wallet, nonce, ts) => [...(plain ? [buildProfileMessage({ wallet, nonce, ts, fields: { ...f, ...signed } })] : []), buildProfileMessage({ wallet, nonce, ts, fields: f })]);
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
      // a profile a moderator hid is not editable: its owner sees "Create profile" (the public read cannot show a
      // hidden row), and a save from that blank form would replace their real profile and drop their X verification.
      // Only the owner learns this: a save needs their signature.
      // (a deleted one may come back: it has nothing left to lose, and it stays hidden)
      if (existing?.hidden && !existing.deleted_at) return fail("a moderator has hidden your profile, so it can't be changed right now", 409);
      const nameChange = !existing || existing.username !== f.username;
      // a verified X owner may take their own handle as a username, and only while keeping that verification in this
      // same save (taking the name and dropping the X claim at once would evict the holder for nothing)
      const claimingOwnX = Boolean(existing && !existing.deleted_at && existing.x_status === "verified" && existing.x_handle === f.username && f.x_handle === existing.x_handle);
      let renamed: string | undefined;
      let restoredAfterDelete = false;
      if (nameChange) {
        // the hold and the current owner in ONE statement (one snapshot): a rename or delete of that name committing
        // between two separate reads could otherwise show neither, and hand out a name that is held
        const [n] = await t<{ held_wallet: string | null; held_at: Date | string | null; owner_wallet: string | null; owner_x_status: string | null }[]>`
          SELECT h.wallet AS held_wallet, h.released_at AS held_at, p.wallet AS owner_wallet, p.x_status AS owner_x_status
            FROM (SELECT 1) one
            LEFT JOIN bb_username_holds h ON h.username = ${f.username} AND h.released_at > now() - interval '30 days'
            LEFT JOIN bb_profiles p ON p.username = ${f.username}`;
        const held = n?.held_wallet ? { wallet: n.held_wallet } : null;
        const restoringOwn = Boolean(held && held.wallet === me);
        // taking your own name back skips the rename clock only as an undo, within a day of letting it go: the name
        // left behind was then kept under a day, so it is not held, and two names can never be swapped back and forth
        const undo = restoringOwn && n?.held_at != null && now - new Date(n.held_at).getTime() < RENAME_GRACE_MS;
        // coming back after a delete under the very name the delete let go of (its hold was written in the delete's own
        // transaction, so it carries the same instant) is no rename either: the profile simply returns
        restoredAfterDelete = Boolean(restoringOwn && existing?.deleted_at && n?.held_at != null && new Date(n.held_at).getTime() === new Date(existing.deleted_at).getTime());
        // the rename clock: free in the first day of the profile, to undo a rename, to come back under your name after a
        // delete, or to claim your verified X handle
        if (existing && !claimingOwnX && !undo && !restoredAfterDelete && now - new Date(existing.created_at).getTime() > RENAME_GRACE_MS && existing.username_changed_at && now - new Date(existing.username_changed_at).getTime() < RENAME_COOLDOWN_MS) {
          return fail("you can change your username once every 30 days", 429);
        }
        // holds yield only to the verified owner of the same X handle (a retired name never does)
        if (held && held.wallet !== me && (!claimingOwnX || held.wallet === RETIRED)) return fail("that username is taken", 409);
        const holder = n?.owner_wallet ? { wallet: n.owner_wallet, x_status: n.owner_x_status ?? "none" } : null;
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
          username_changed_at = CASE WHEN bb_profiles.username <> EXCLUDED.username AND NOT ${restoredAfterDelete} THEN now() ELSE bb_profiles.username_changed_at END,
          deleted_at = NULL, updated_at = now()`;
      // a different X handle (or none) drops the old verification and any pending review: the tick is earned again
      const xChanged = !existing || Boolean(existing.deleted_at) || (existing.x_handle ?? "") !== f.x_handle;
      if (xChanged) {
        await t`UPDATE bb_profiles SET x_handle = ${f.x_handle || null}, ${noXClaim(t)} WHERE wallet = ${me}`;
        await closeXCodes(t, me);
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
      // code and profile change together, under the profile lock that save, delete and moderate also hold before they
      // write any row (save takes its username lock first, then this one): a save in between can never leave the
      // profile waiting for review with no code behind it
      const queued = await db.begin(async (tx) => {
        const t = tx as unknown as Db;
        await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${me}`}))`;
        const current = await rowByWallet(t, me);
        if (!current || current.deleted_at || current.x_status === "verified" || current.x_handle !== code.x_handle) return false;
        const queuedCode = await t`UPDATE bb_x_codes SET post_id = ${post.id}, submitted_at = now(), review = 'pending' WHERE code = ${code.code} AND used_at IS NULL AND review IS NULL RETURNING code`;
        if (queuedCode.length === 0) return false;
        // one claim waits for review per wallet: an older one is retired, so the queue shows exactly what is decided
        await t`UPDATE bb_x_codes SET review = 'rejected', used_at = now() WHERE wallet = ${me} AND review = 'pending' AND used_at IS NULL AND code <> ${code.code}`;
        await t`UPDATE bb_profiles SET x_status = 'pending_review', x_post_id = ${post.id}, updated_at = now() WHERE wallet = ${me}`;
        return true;
      });
      if (!queued) return fail(NO_CODE, 400);
      return { ok: true, status: "pending_review", profile: await getProfile({ wallet: me }) };
    }
    // X answered nobody, and the link names another account: nothing was queued, so never say a person will look
    if (j.review) return fail(`X did not answer just now, and that link is not a post from @${code.x_handle}: paste the link to your post from @${code.x_handle}, or try again in a minute`, 503);
    return fail(j.error, 400);
  }
  const done = await db.begin(async (tx) => {
    const t = tx as unknown as Db;
    // the profile lock before any row, as save, delete and moderate do: the same rows are never locked in opposite orders
    await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${me}`}))`;
    const used = await t`UPDATE bb_x_codes SET used_at = now(), post_id = ${post.id}, submitted_at = now() WHERE code = ${code.code} AND used_at IS NULL RETURNING code`;
    if (used.length === 0) return false;
    // a claim still waiting for review is settled by this proof: it leaves the queue
    await t`UPDATE bb_x_codes SET review = 'rejected', used_at = now() WHERE wallet = ${me} AND review = 'pending' AND used_at IS NULL`;
    // one X account, one wallet: verifying here releases it from any other wallet (only the account owner could post the code)
    // (all of it: the account facts too, and any claim of theirs still open or waiting for review)
    const others = await t<{ wallet: string }[]>`
      UPDATE bb_profiles SET x_handle = NULL, ${noXClaim(t)}, updated_at = now()
       WHERE wallet <> ${me} AND (x_user_id = ${j.userId} OR x_user_id = ${`h:${j.handle}`} OR (x_handle = ${j.handle} AND x_status IN ('verified', 'post_missing'))) RETURNING wallet`;
    for (const o of others) {
      await closeXCodes(t, o.wallet);
      forgetName(o.wallet);
    }
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
 * created_at and the rename clock survive, so deleting and re-creating is not a way around either. A name kept a day or
 * more is held for this wallet for 30 days, and coming back under it is no rename (the clock is skipped and not
 * restarted). A name kept under a day is not held: coming back under it, or any other name, follows the same clock
 * as a rename.
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
             x_handle = NULL, ${noXClaim(t)}, updated_at = now()
       WHERE wallet = ${a.wallet}`;
    await closeXCodes(t, a.wallet);
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

/**
 * Apply one admin-signed moderation action to a profile, and return the profile as the queue shows it afterwards (so
 * the queue updates in place, without asking the admin to sign another list read).
 */
export async function moderateProfile(r: Signed & { action: unknown; target: unknown; reason?: unknown; claim?: unknown }): Promise<{ ok: true; row: ReviewRow | null } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (!isProfileModAction(r.action)) return fail("bad action", 400);
  if (typeof r.target !== "string" || !isAddress(r.target)) return fail("bad target", 400);
  if (typeof r.wallet !== "string" || !adminWallets().has(r.wallet.toLowerCase())) return fail("not an admin", 403);
  const action = r.action;
  const target = r.target.toLowerCase();
  const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, 200) : "";
  // approve / reject act on the one claim the admin reviewed (its code is in the signed message), nothing else
  const reviewsClaim = action === "approve_x" || action === "reject_x";
  const claim = reviewsClaim && isXCode(r.claim) ? r.claim : "";
  if (reviewsClaim && !claim) return fail("reload the queue: this action needs the claim you reviewed", 400);
  const a = await admit(db, r, (wallet, nonce, ts) => buildProfileModMessage({ action, target, wallet, nonce, ts, reason, claim }));
  if (!a.ok) return a;
  // every action runs under the profile lock that save, delete and verify also hold before writing any row, and
  // judges the profile and its pending code as they are now: an owner's save between an admin's look and the write
  // can never be overridden (approving @a after the claim moved to @b refuses instead of marking @b verified)
  const refused = await db.begin(async (tx): Promise<Fail | null> => {
    const t = tx as unknown as Db;
    await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${target}`}))`;
    const prof = await rowByWallet(t, target);
    if (!prof) return fail("no such profile", 404);
    switch (action) {
      case "approve_x":
      case "reject_x": {
        const [code] = await t<{ code: string; x_handle: string; post_id: string | null }[]>`SELECT code, x_handle, post_id FROM bb_x_codes WHERE wallet = ${target} AND code = ${claim} AND review = 'pending' AND used_at IS NULL`;
        if (!code) return fail("this claim is no longer waiting for review; reload the queue", 409);
        if (action === "reject_x") {
          await t`UPDATE bb_x_codes SET review = 'rejected', used_at = now() WHERE code = ${code.code}`;
          // back to an unproven claim: any account binding a paused verification carried goes too, so it can never
          // block another wallet's approval or a re-check of the account's real owner
          await t`UPDATE bb_profiles SET ${noXClaim(t)}, updated_at = now() WHERE wallet = ${target} AND x_status = 'pending_review'`;
          return null;
        }
        // only the claim that is pending, for the handle this code was issued for
        if (prof.deleted_at || prof.x_status !== "pending_review" || prof.x_handle !== code.x_handle) return fail("this claim changed since it was submitted; reject it", 409);
        // a handle another wallet has verified is not handed out by hand
        const [taken] = await t`SELECT 1 FROM bb_profiles WHERE wallet <> ${target} AND deleted_at IS NULL AND x_handle = ${code.x_handle} AND x_status IN ('verified', 'post_missing')`;
        if (taken) return fail(`@${code.x_handle} is already verified by another wallet; reject this one`, 409);
        // one X account, one wallet: any other wallet still holding this account's binding (a paused claim that went
        // back to review, say) lets go of it, so the approval never trips the one-account-per-wallet constraint
        const binding = prof.x_user_id ?? `h:${code.x_handle}`;
        // each of those wallets' profile lock first (in wallet order), as their own verify takes it before their rows:
        // the release can then never lock their codes and profile in the opposite order to a verify running for them
        const holders = await t<{ wallet: string }[]>`
          SELECT wallet FROM bb_profiles WHERE wallet <> ${target} AND (x_user_id = ${binding} OR x_user_id = ${`h:${code.x_handle}`}) ORDER BY wallet`;
        for (const o of holders) await t`SELECT pg_advisory_xact_lock(hashtext(${`profile:${o.wallet}`}))`;
        const released = holders.length
          ? await t<{ wallet: string }[]>`
              UPDATE bb_profiles SET x_handle = NULL, ${noXClaim(t)}, updated_at = now()
               WHERE wallet IN ${t(holders.map((o) => o.wallet))} AND (x_user_id = ${binding} OR x_user_id = ${`h:${code.x_handle}`}) RETURNING wallet`
          : [];
        for (const o of released) {
          await closeXCodes(t, o.wallet);
          forgetName(o.wallet);
        }
        await t`UPDATE bb_x_codes SET review = 'approved', used_at = now() WHERE code = ${code.code}`;
        await t`UPDATE bb_profiles SET x_status = 'verified', x_user_id = ${binding}, x_post_id = ${code.post_id}, x_verified_at = now(), x_checked_at = NULL, updated_at = now() WHERE wallet = ${target}`;
        return null;
      }
      case "remove_x":
        await t`UPDATE bb_profiles SET x_handle = NULL, ${noXClaim(t)}, updated_at = now() WHERE wallet = ${target}`;
        await closeXCodes(t, target);
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
  const [row] = await db<ReviewRow[]>`
    SELECT wallet, username, display_name, x_handle, x_status, hidden, points_flag, created_at, NULL::text AS code, x_post_id AS post_id
      FROM bb_profiles WHERE wallet = ${target} AND deleted_at IS NULL`;
  return { ok: true, row: row ?? null };
}

// ── re-check ─────────────────────────────────────────────────────────────────
let lastRecheck = 0;
const RECHECK_EVERY_MS = 10 * 60_000;

/**
 * Re-read verified posts older than a week, and paused ones every day (so a pause that X takes back does not last a
 * week), a small batch at a time (claimed with SKIP LOCKED so two machines never read the same one). The post must
 * still be there AND still be by the bound account: a post X says is gone, or one now attributed to a different
 * account, pauses the tick ("reverify"). The same account under a new handle (a rename on X) updates the handle. A post
 * that answers refreshes the facts points use (account age, followers), upgrades a handle-only binding to the account
 * id, and gives a paused tick back. No answer, or an unsure one, changes nothing.
 */
export async function recheckProfiles(batch = 20): Promise<number> {
  const db = maybeDb();
  const now = Date.now();
  if (!db || now - lastRecheck < RECHECK_EVERY_MS) return 0;
  lastRecheck = now;
  const rows = await db<{ wallet: string; x_handle: string | null; x_post_id: string | null; x_user_id: string | null; x_status: string }[]>`
    UPDATE bb_profiles p SET x_checked_at = now()
      FROM (SELECT wallet FROM bb_profiles WHERE x_status IN ('verified', 'post_missing') AND deleted_at IS NULL AND x_post_id IS NOT NULL AND x_handle IS NOT NULL
             AND (x_checked_at IS NULL OR x_checked_at < now() - CASE WHEN x_status = 'post_missing' THEN interval '1 day' ELSE interval '7 days' END)
           ORDER BY x_checked_at NULLS FIRST LIMIT ${batch} FOR UPDATE SKIP LOCKED) due
     WHERE p.wallet = due.wallet
     RETURNING p.wallet, p.x_handle, p.x_post_id, p.x_user_id, p.x_status`;
  let changed = 0;
  // every write re-tests the claim that was read (handle and post): the owner may re-verify, or move to another
  // handle, while its post is being fetched, and a re-check must never overwrite that
  const pause = async (r: { wallet: string; x_handle: string; x_post_id: string }) => {
    const up = await db`UPDATE bb_profiles SET x_status = 'post_missing', updated_at = now() WHERE wallet = ${r.wallet} AND x_status = 'verified' AND x_handle = ${r.x_handle} AND x_post_id = ${r.x_post_id} RETURNING wallet`;
    changed += up.length;
  };
  // an unsure read changes nothing, and is tried again in about an hour instead of waiting out the whole 1- or 7-day
  // gap the claim set before the fetch
  const retrySoon = async (r: { wallet: string; x_handle: string; x_post_id: string }) => {
    await db`UPDATE bb_profiles SET x_checked_at = now() - CASE WHEN x_status = 'post_missing' THEN interval '1 day' ELSE interval '7 days' END + interval '1 hour'
              WHERE wallet = ${r.wallet} AND x_handle = ${r.x_handle} AND x_post_id = ${r.x_post_id}`;
  };
  for (const r of rows) {
    if (!r.x_handle || !r.x_post_id) continue;
    const facts = await fetchPostFacts(r.x_handle, r.x_post_id);
    // only X saying the post is gone pauses the tick; no answer, or X's two sources disagreeing on the author (as just
    // after a rename on X, while one still serves the old handle), is unsure and changes nothing
    if (facts.found === false) {
      await pause({ wallet: r.wallet, x_handle: r.x_handle, x_post_id: r.x_post_id });
      continue;
    }
    if (facts.found === null || !facts.handle) {
      await retrySoon({ wallet: r.wallet, x_handle: r.x_handle, x_post_id: r.x_post_id });
      continue;
    }
    const boundId = r.x_user_id && !r.x_user_id.startsWith("h:") ? r.x_user_id : null;
    // the post now reads as another account's: never keep a tick we cannot tie to the bound account
    if (boundId && facts.userId && facts.userId !== boundId) {
      await pause({ wallet: r.wallet, x_handle: r.x_handle, x_post_id: r.x_post_id });
      continue;
    }
    const sameHandle = facts.handle.toLowerCase() === r.x_handle;
    // a new handle while X gives no account id (its embed data, the only source of it, did not answer): a rename on X
    // looks exactly like this, so it is unsure, not a reason to pause
    if (!sameHandle && !facts.userId) {
      await retrySoon({ wallet: r.wallet, x_handle: r.x_handle, x_post_id: r.x_post_id });
      continue;
    }
    if (!sameHandle && !(boundId && facts.userId === boundId)) {
      await pause({ wallet: r.wallet, x_handle: r.x_handle, x_post_id: r.x_post_id });
      continue;
    }
    const upgrade = !boundId && facts.userId ? facts.userId : null;
    if (upgrade) {
      const [taken] = await db`SELECT 1 FROM bb_profiles WHERE x_user_id = ${upgrade} AND wallet <> ${r.wallet}`;
      if (taken) {
        await pause({ wallet: r.wallet, x_handle: r.x_handle, x_post_id: r.x_post_id }); // another wallet holds the account id: leave this one for a person
        continue;
      }
    }
    await db`
      UPDATE bb_profiles SET x_status = 'verified', x_handle = ${facts.handle.toLowerCase()}, x_user_id = COALESCE(${upgrade}, x_user_id),
             x_account_created = COALESCE(${facts.accountCreated}, x_account_created), x_followers = COALESCE(${facts.followers}::int, x_followers), updated_at = now()
       WHERE wallet = ${r.wallet} AND x_status IN ('verified', 'post_missing') AND x_handle = ${r.x_handle} AND x_post_id = ${r.x_post_id}`;
    if (r.x_status === "post_missing") changed++;
  }
  for (const r of rows) forgetName(r.wallet);
  return changed;
}
