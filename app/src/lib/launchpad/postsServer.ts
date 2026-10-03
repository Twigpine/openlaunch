import "server-only";
import { isAddress, type Address, type Hex } from "viem";
import { publicClient } from "@/lib/chain";
import { CHAIN_KEY_PATTERN, DEFAULT_CHAIN, chainIdOf, chainKeyOf, type ChainKey } from "@/lib/chainPublic";
import { maybeDb } from "@/lib/db";
import { ERC20_MIN_ABI } from "./abi";
import { AUTO_HIDE_REPORTS, POST_DAILY_MAX, POST_MIN_GAP_MS, buildModMessage, buildPostMessage, buildReportMessage, canPostNow, holderTag, isReportReason, tsFresh, validateBody, type ModAction, type Tag } from "./posts";
import { clampFeedOffset } from "./posts-paging";

/** Mute targets: `token:<chain>:<address>`. */
const TOKEN_TARGET_RE = new RegExp(`^token:(${CHAIN_KEY_PATTERN}):(0x[0-9a-f]{40})$`);

/**
 * Server half of posts. Rules, all enforced here regardless of the client:
 *   - every write carries a wallet signature over a message that names the
 *     action, target, a client nonce and a timestamp (±5 min); nonces are
 *     single-use; verification handles EOAs and smart wallets (ERC-1271/6492)
 *   - a wallet may post on a token only if it has skin in the game: it is the
 *     creator, holds the token, or has traded / launched on the site before
 *   - per-wallet gap + daily cap; per-ip limits live in the routes
 *   - creators can mute comments on their own token; admins (ADMIN_WALLETS)
 *     can hide/unhide posts; 5 distinct reports auto-hide pending review
 */
export function adminWallets(): Set<string> {
  return new Set((process.env.ADMIN_WALLETS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => isAddress(s)));
}

function isNonce(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

async function consumeNonce(nonce: string, wallet: string): Promise<boolean> {
  const db = maybeDb()!;
  try {
    await db`INSERT INTO bb_post_nonces (nonce, wallet) VALUES (${nonce}, ${wallet})`;
    void db`DELETE FROM bb_post_nonces WHERE created_at < now() - interval '1 hour'`.catch(() => {});
    return true;
  } catch {
    return false; // duplicate → replay
  }
}

async function verify(chain: ChainKey, wallet: string, message: string, signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  try {
    return await publicClient(chain).verifyMessage({ address: wallet as Address, message, signature: signature as Hex });
  } catch {
    return false;
  }
}

type Fail = { ok: false; error: string; status: number };
const fail = (error: string, status: number): Fail => ({ ok: false, error, status });

export type PostRow = { id: number; chain: ChainKey; token: string; wallet: string; parent_id: number | null; body: string; tag: Tag; created_at: string; reports: number; hidden: boolean; symbol?: string; name?: string };

type RawPost = { id: bigint | number; chain_id: number; token: string; wallet: string; parent_id: bigint | number | null; body: string; tag: string | null; created_at: string; reports: number; hidden: boolean; symbol?: string; name?: string };

function shape(r: RawPost): PostRow {
  return { id: Number(r.id), chain: chainKeyOf(r.chain_id) ?? DEFAULT_CHAIN, token: r.token, wallet: r.wallet, parent_id: r.parent_id === null ? null : Number(r.parent_id), body: r.body, tag: (r.tag as Tag) ?? null, created_at: r.created_at, reports: r.reports, hidden: r.hidden, symbol: r.symbol, name: r.name };
}

export async function listTokenPosts(chain: ChainKey, token: string, limit = 100, beforeId: number | null = null): Promise<{ posts: PostRow[]; muted: boolean; nextCursor: number | null }> {
  const db = maybeDb();
  if (!db) return { posts: [], muted: false, nextCursor: null };
  const cid = chainIdOf(chain);
  const n = Math.min(300, Math.max(1, Math.trunc(limit) || 100));
  // Both pages order by id DESC — the same key as the `id < beforeId`
  // continuation predicate. Ordering by created_at DESC instead would skip or
  // repeat rows across pages whenever id order and timestamp order disagree
  // (same-second inserts, backfilled rows). ids are monotonic with insertion,
  // so newest-first is preserved.
  const [rows, st] = await Promise.all([
    beforeId !== null && Number.isInteger(beforeId) && beforeId > 0
      ? db<RawPost[]>`SELECT id, chain_id, token, wallet, parent_id, body, tag, created_at, reports, hidden FROM bb_posts WHERE chain_id = ${cid} AND token = ${token.toLowerCase()} AND NOT hidden AND id < ${beforeId} ORDER BY id DESC LIMIT ${n}`
      : db<RawPost[]>`SELECT id, chain_id, token, wallet, parent_id, body, tag, created_at, reports, hidden FROM bb_posts WHERE chain_id = ${cid} AND token = ${token.toLowerCase()} AND NOT hidden ORDER BY id DESC LIMIT ${n}`,
    db<{ comments_muted: boolean }[]>`SELECT comments_muted FROM bb_token_settings WHERE chain_id = ${cid} AND token = ${token.toLowerCase()}`,
  ]);
  const posts = rows.map(shape);
  return { posts, muted: st[0]?.comments_muted ?? false, nextCursor: posts.length < n ? null : Number(posts[posts.length - 1]?.id ?? 0) || null };
}

/** Global human feed: latest top-level posts across all tokens, with token names. */
export async function listFeed(limit = 30, offset = 0): Promise<PostRow[]> {
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<RawPost[]>`
    SELECT p.id, p.chain_id, p.token, p.wallet, p.parent_id, p.body, p.tag, p.created_at, p.reports, p.hidden, l.symbol, l.name
      FROM bb_posts p JOIN bb_launches l ON l.chain_id = p.chain_id AND l.token = p.token
     WHERE NOT p.hidden AND p.parent_id IS NULL ORDER BY p.created_at DESC LIMIT ${Math.min(100, Math.max(1, Math.trunc(limit) || 30))} OFFSET ${clampFeedOffset(offset)}`;
  return rows.map(shape);
}

export async function listReported(limit = 100): Promise<PostRow[]> {
  const db = maybeDb();
  if (!db) return [];
  const rows = await db<RawPost[]>`
    SELECT p.id, p.chain_id, p.token, p.wallet, p.parent_id, p.body, p.tag, p.created_at, p.reports, p.hidden, l.symbol, l.name
      FROM bb_posts p JOIN bb_launches l ON l.chain_id = p.chain_id AND l.token = p.token
     WHERE p.reports > 0 ORDER BY p.hidden ASC, p.reports DESC, p.created_at DESC LIMIT ${Math.min(300, limit)}`;
  return rows.map(shape);
}

/** Skin-in-the-game check + tag. */
async function eligibility(chain: ChainKey, token: string, wallet: string): Promise<{ allowed: boolean; tag: Tag; reason?: string }> {
  const db = maybeDb()!;
  const cid = chainIdOf(chain);
  const [launch] = await db<{ launcher: string; supply: string }[]>`SELECT launcher, supply FROM bb_launches WHERE chain_id = ${cid} AND token = ${token}`;
  if (!launch) return { allowed: false, tag: null, reason: "unknown token" };
  let balance = 0n;
  try {
    balance = await publicClient(chain).readContract({ address: token as Address, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [wallet as Address] });
  } catch {
    /* rpc hiccup → treat as 0 */
  }
  const tag = holderTag(launch.launcher === wallet, balance, BigInt(launch.supply));
  if (tag) return { allowed: true, tag };
  const [act] = await db<{ n: bigint }[]>`SELECT (SELECT count(*) FROM bb_launch_swaps WHERE trader = ${wallet}) + (SELECT count(*) FROM bb_launches WHERE launcher = ${wallet}) AS n`;
  if (Number(act.n) > 0) return { allowed: true, tag: null };
  return { allowed: false, tag: null, reason: "hold the token, or trade or launch on openlaunch first, to post" };
}

export async function createPost(p: { chain: ChainKey; token: string; wallet: string; parentId: unknown; body: unknown; nonce: unknown; ts: unknown; signature: unknown }): Promise<{ ok: true; post: PostRow } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (!isAddress(p.wallet) || !isAddress(p.token)) return fail("bad address", 400);
  const wallet = p.wallet.toLowerCase();
  const token = p.token.toLowerCase();
  const cid = chainIdOf(p.chain);
  const v = validateBody(p.body);
  if (!v.ok) return fail(v.error, 400);
  if (!isNonce(p.nonce)) return fail("bad nonce", 400);
  const now = Date.now();
  if (!tsFresh(p.ts, now)) return fail("stale signature", 400);
  const parentId = p.parentId === null || p.parentId === undefined || p.parentId === "" ? null : Number(p.parentId);
  if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) return fail("bad parent", 400);

  // policy before crypto (cheap first)
  const [st] = await db<{ comments_muted: boolean }[]>`SELECT comments_muted FROM bb_token_settings WHERE chain_id = ${cid} AND token = ${token}`;
  if (st?.comments_muted) return fail("comments are off for this token", 403);
  const [rate] = await db<{ last: string | null; n24: bigint }[]>`SELECT max(created_at) AS last, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::bigint AS n24 FROM bb_posts WHERE wallet = ${wallet}`;
  const gate = canPostNow(rate.last ? new Date(rate.last).getTime() : null, Number(rate.n24), now);
  if (!gate.ok) return fail(gate.error, 429);
  if (parentId !== null) {
    const [parent] = await db<{ id: bigint; parent_id: bigint | null }[]>`SELECT id, parent_id FROM bb_posts WHERE id = ${parentId} AND chain_id = ${cid} AND token = ${token} AND NOT hidden`;
    if (!parent) return fail("parent not found", 404);
    if (parent.parent_id !== null) return fail("replies are one level deep", 400);
  }
  const elig = await eligibility(p.chain, token, wallet);
  if (!elig.allowed) return fail(elig.reason ?? "not allowed", 403);

  const message = buildPostMessage({ chain: p.chain, token, wallet, nonce: p.nonce, ts: Number(p.ts), parentId, body: v.body });
  if (!(await verify(p.chain, wallet, message, p.signature))) return fail("signature does not match", 401);
  if (!(await consumeNonce(p.nonce, wallet))) return fail("nonce already used", 401);

  const [row] = await db<RawPost[]>`
    INSERT INTO bb_posts (chain_id, token, wallet, parent_id, body, tag, signature)
    VALUES (${cid}, ${token}, ${wallet}, ${parentId}, ${v.body}, ${elig.tag}, ${String(p.signature)})
    RETURNING id, chain_id, token, wallet, parent_id, body, tag, created_at, reports, hidden`;
  return { ok: true, post: shape(row) };
}

export async function reportPost(p: { postId: unknown; wallet: string; reason: unknown; nonce: unknown; ts: unknown; signature: unknown }): Promise<{ ok: true; hidden: boolean } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (!isAddress(p.wallet)) return fail("bad address", 400);
  const wallet = p.wallet.toLowerCase();
  const postId = Number(p.postId);
  if (!Number.isInteger(postId) || postId <= 0) return fail("bad post", 400);
  if (!isReportReason(p.reason)) return fail("bad reason", 400);
  if (!isNonce(p.nonce) || !tsFresh(p.ts, Date.now())) return fail("stale or bad nonce", 400);
  const [post] = await db<{ chain_id: number; wallet: string }[]>`SELECT chain_id, wallet FROM bb_posts WHERE id = ${postId}`;
  if (!post) return fail("post not found", 404);
  if (post.wallet === wallet) return fail("cannot report your own post", 400);
  const chain = chainKeyOf(post.chain_id) ?? DEFAULT_CHAIN;
  // reporters need skin in the game too: any trade or launch on the site
  const [act] = await db<{ n: bigint }[]>`SELECT (SELECT count(*) FROM bb_launch_swaps WHERE trader = ${wallet}) + (SELECT count(*) FROM bb_launches WHERE launcher = ${wallet}) + (SELECT count(*) FROM bb_posts WHERE wallet = ${wallet}) AS n`;
  if (Number(act.n) === 0) return fail("trade, launch or post first to report", 403);
  const message = buildReportMessage({ postId, wallet, nonce: p.nonce, ts: Number(p.ts), reason: p.reason });
  if (!(await verify(chain, wallet, message, p.signature))) return fail("signature does not match", 401);
  if (!(await consumeNonce(p.nonce, wallet))) return fail("nonce already used", 401);
  await db`INSERT INTO bb_post_reports (post_id, wallet, reason) VALUES (${postId}, ${wallet}, ${p.reason}) ON CONFLICT DO NOTHING`;
  const [c] = await db<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM bb_post_reports WHERE post_id = ${postId}`;
  const n = Number(c.n);
  const hide = n >= AUTO_HIDE_REPORTS;
  await db`UPDATE bb_posts SET reports = ${n}, hidden = CASE WHEN ${hide} AND hidden_by IS NULL THEN true ELSE hidden END, hidden_by = CASE WHEN ${hide} AND hidden_by IS NULL THEN 'auto' ELSE hidden_by END WHERE id = ${postId}`;
  return { ok: true, hidden: hide };
}

/** Creator mute/unmute of their own token, or admin hide/unhide of a post. */
export async function moderate(p: { action: unknown; target: unknown; wallet: string; nonce: unknown; ts: unknown; signature: unknown }): Promise<{ ok: true } | Fail> {
  const db = maybeDb();
  if (!db) return fail("db unconfigured", 503);
  if (!isAddress(p.wallet)) return fail("bad address", 400);
  const wallet = p.wallet.toLowerCase();
  const action = p.action as ModAction;
  if (!["hide", "unhide", "mute", "unmute"].includes(action)) return fail("bad action", 400);
  if (typeof p.target !== "string" || p.target.length > 120) return fail("bad target", 400);
  if (!isNonce(p.nonce) || !tsFresh(p.ts, Date.now())) return fail("stale or bad nonce", 400);
  const admins = adminWallets();
  let chain: ChainKey = DEFAULT_CHAIN;
  if (action === "mute" || action === "unmute") {
    const m = TOKEN_TARGET_RE.exec(p.target);
    if (!m) return fail("bad target", 400);
    chain = m[1] as ChainKey;
    const [l] = await db<{ launcher: string }[]>`SELECT launcher FROM bb_launches WHERE chain_id = ${chainIdOf(chain)} AND token = ${m[2]}`;
    if (!l) return fail("unknown token", 404);
    if (l.launcher !== wallet && !admins.has(wallet)) return fail("not the creator", 403);
  } else {
    if (!admins.has(wallet)) return fail("admin only", 403);
    if (!/^post:\d+$/.test(p.target)) return fail("bad target", 400);
  }
  const message = buildModMessage({ action, target: p.target, wallet, nonce: p.nonce, ts: Number(p.ts) });
  if (!(await verify(chain, wallet, message, p.signature))) return fail("signature does not match", 401);
  if (!(await consumeNonce(p.nonce, wallet))) return fail("nonce already used", 401);
  if (action === "mute" || action === "unmute") {
    const [, c, t] = TOKEN_TARGET_RE.exec(p.target)!;
    await db`INSERT INTO bb_token_settings (chain_id, token, comments_muted) VALUES (${chainIdOf(c as ChainKey)}, ${t}, ${action === "mute"})
             ON CONFLICT (chain_id, token) DO UPDATE SET comments_muted = EXCLUDED.comments_muted, updated_at = now()`;
  } else {
    const id = Number(p.target.slice(5));
    const rows = await db<{ id: number }[]>`UPDATE bb_posts SET hidden = ${action === "hide"}, hidden_by = ${action === "hide" ? wallet : null} WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) return fail("post not found", 404);
  }
  return { ok: true };
}

export { POST_MIN_GAP_MS, POST_DAILY_MAX };
