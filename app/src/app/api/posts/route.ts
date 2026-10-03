import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { isChainKey } from "@/lib/chainPublic";
import { rateLimited } from "@/lib/launchpad/editServer";
import { createPost, listFeed, listTokenPosts } from "@/lib/launchpad/postsServer";
import { memo } from "@/lib/launchpad/memo";
import { FEED_POSTS_LIMIT, feedPostsKey, parseFeedPaging, parseTokenPostsPaging, postsCursorKey } from "@/lib/launchpad/posts-paging";

export const dynamic = "force-dynamic";

/** GET /api/posts?chain=&token=[&limit=&before=] → one page of posts on a token (+ muted flag, nextCursor);  GET /api/posts?feed=1&offset= → global human feed. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("feed")) {
    const { offset } = parseFeedPaging({ offset: u.searchParams.get("offset") });
    try {
      return NextResponse.json({ posts: await memo(feedPostsKey(offset), 2_000, () => listFeed(FEED_POSTS_LIMIT, offset)) }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      console.error("[posts] feed failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "could not load feed" }, { status: 502 });
    }
  }
  const chain = u.searchParams.get("chain");
  const token = (u.searchParams.get("token") ?? "").toLowerCase();
  if (!isChainKey(chain) || !isAddress(token)) return NextResponse.json({ error: "bad params" }, { status: 400 });
  const { limit, beforeId } = parseTokenPostsPaging({ limit: u.searchParams.get("limit"), before: u.searchParams.get("before") });
  try {
    return NextResponse.json(await memo(postsCursorKey(chain, token, limit, beforeId), 2_000, () => listTokenPosts(chain, token, limit, beforeId)), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[posts] token posts failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load comments" }, { status: 502 });
  }
}

/** POST {chain, token, wallet, parentId?, body, nonce, ts, signature} → new post. */
export async function POST(req: Request) {
  const ip = (req.headers.get("fly-client-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "0.0.0.0";
  if (rateLimited(`post:ip:${ip}`, 30)) return NextResponse.json({ error: "slow down" }, { status: 429 });
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!isChainKey(b.chain) || typeof b.token !== "string" || typeof b.wallet !== "string") return NextResponse.json({ error: "bad params" }, { status: 400 });
  const r = await createPost({ chain: b.chain, token: b.token, wallet: b.wallet, parentId: b.parentId, body: b.body, nonce: b.nonce, ts: b.ts, signature: b.signature });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, post: r.post });
}
