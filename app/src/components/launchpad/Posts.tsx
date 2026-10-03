"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import WalletAvatar from "@/components/WalletAvatar";
import ChainBadge from "./ChainBadge";
import { useLive } from "./LiveProvider";
import { toast } from "./TxToasts";
import { btn } from "@/components/ui";
import { buildModMessage, buildPostMessage, buildReportMessage, POST_MAX, REPORT_REASONS, validateBody, type ReportReason } from "@/lib/launchpad/posts";
import type { PostRow } from "@/lib/launchpad/postsServer";
import { ago, nowMs } from "@/lib/launchpad/time";
import { CHAINS, CHAIN_SHORT, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import ConnectWallet from "@/components/ConnectWallet";
import { ChevronDown, MessageSquare } from "lucide-react";

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function TagChip({ tag }: { tag: PostRow["tag"] }) {
  if (!tag) return null;
  const cls = tag === "creator" ? "bg-brand-soft text-brand border-brand/20" : tag === "whale" ? "bg-warm-soft text-warm-ink border-warm/30" : "bg-up-soft text-up border-up/20";
  return <span className={`inline-flex items-center rounded-md border px-1.5 h-5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{tag}</span>;
}

/** Sign-and-send helper shared by post / report / mute. Free signatures, never a transaction. */
async function signed(config: ReturnType<typeof useConfig>, chain: ChainKey, message: string): Promise<{ signature: string }> {
  const wallet = await getWalletClient(config, { chainId: CHAINS[chain].id });
  return { signature: await wallet.signMessage({ message }) };
}

/**
 * Comments on a token page. Posting needs a wallet with skin in the game
 * (creator, holder, or has traded/launched here) and a free signature. One
 * reply level. Report and (for the creator) mute are signatures too.
 */
export default function TokenComments({ chain, token, symbol, launcher, embedded = false }: { chain: ChainKey; token: string; symbol: string; launcher: string; embedded?: boolean }) {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const { subscribe } = useLive();
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [muted, setMuted] = useState(false);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const seenPosts = useRef<string>("");
  const isCreator = Boolean(address && address.toLowerCase() === launcher.toLowerCase());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/posts?chain=${chain}&token=${token}`, { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { posts: PostRow[]; muted: boolean };
      setPosts(d.posts);
      setMuted(d.muted);
      setNow(nowMs());
    } catch {
      /* keep */
    }
  }, [chain, token]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);
  // refresh when the shared poller says there is a newer post on this token
  useEffect(
    () =>
      subscribe((snap) => {
        const latest = snap.posts?.find((p) => p.chain === chain && p.token === token);
        const k = latest ? `${latest.id}` : "";
        if (k && k !== seenPosts.current) {
          seenPosts.current = k;
          void load();
        }
      }),
    [subscribe, chain, token, load],
  );

  async function submit() {
    if (!address) return;
    const v = validateBody(body);
    if (!v.ok) {
      setErr(v.error);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const n = nonce();
      const ts = nowMs();
      const message = buildPostMessage({ chain, token, wallet: address, nonce: n, ts, parentId: replyTo, body: v.body });
      const { signature } = await signed(config, chain, message);
      const res = await fetch("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain, token, wallet: address, parentId: replyTo, body: v.body, nonce: n, ts, signature }) });
      const d = (await res.json()) as { ok?: boolean; post?: PostRow; error?: string };
      if (!res.ok || !d.post) throw new Error(d.error ?? "post rejected");
      setPosts((cur) => [d.post!, ...cur]);
      setBody("");
      setReplyTo(null);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function report(p: PostRow, reason: ReportReason) {
    if (!address) return;
    try {
      const n = nonce();
      const ts = nowMs();
      const { signature } = await signed(config, chain, buildReportMessage({ postId: p.id, wallet: address, nonce: n, ts, reason }));
      const res = await fetch("/api/posts/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ postId: p.id, wallet: address, reason, nonce: n, ts, signature }) });
      const d = (await res.json()) as { ok?: boolean; hidden?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "report rejected");
      toast({ kind: "info", title: d.hidden ? "Post hidden after reports" : "Report received", sub: "Thanks for keeping the feed clean." });
      if (d.hidden) setPosts((cur) => cur.filter((x) => x.id !== p.id));
    } catch (e) {
      toast({ kind: "info", title: "Could not report", sub: friendlyError(e) });
    }
  }

  async function mute(next: boolean) {
    if (!address) return;
    try {
      const n = nonce();
      const ts = nowMs();
      const target = `token:${chain}:${token.toLowerCase()}`;
      const { signature } = await signed(config, chain, buildModMessage({ action: next ? "mute" : "unmute", target, wallet: address, nonce: n, ts }));
      const res = await fetch("/api/posts/mod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: next ? "mute" : "unmute", target, wallet: address, nonce: n, ts, signature }) });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "failed");
      setMuted(next);
      toast({ kind: "info", title: next ? `Comments off for ${symbol}` : `Comments on for ${symbol}` });
    } catch (e) {
      toast({ kind: "info", title: "Could not change comments", sub: friendlyError(e) });
    }
  }

  const top = posts.filter((p) => p.parent_id === null);
  const replies = (id: number) => posts.filter((p) => p.parent_id === id).slice().reverse();

  return (
    <section className={embedded ? "min-w-0" : "min-w-0 border-t border-line"} id="comments">
      <div className="px-4 h-11 flex items-center justify-between border-b border-line">
        <h2 className="text-sm font-semibold text-ink">
          Comments <span className="ml-1 text-xs font-normal text-muted font-mono tnum">{posts.length}</span>
        </h2>
        {isCreator ? (
          <button type="button" onClick={() => void mute(!muted)} className="text-[11px] font-medium text-muted hover:text-ink">
            {muted ? "Turn comments on" : "Turn comments off"}
          </button>
        ) : null}
      </div>

      {/* composer */}
      <div className="px-4 py-3 border-b border-line bg-paper/60">
        {muted ? (
          <p className="text-sm text-muted">The creator turned comments off for this token.</p>
        ) : !isConnected ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted">Connect a wallet to post. Free signature, no transaction. Holders, traders and creators can post.</p>
            <ConnectWallet className={btn.secondarySm}>Connect</ConnectWallet>
          </div>
        ) : (
          <div className="space-y-2">
            {replyTo !== null ? (
              <p className="text-[11px] text-muted">
                Replying to #{replyTo}{" "}
                <button type="button" className="underline hover:text-ink" onClick={() => setReplyTo(null)}>
                  cancel
                </button>
              </p>
            ) : null}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, POST_MAX))}
              placeholder={`Say something about ${symbol}…`}
              className="w-full rounded-xl bg-card border border-line-strong focus:border-brand focus:ring-4 focus:ring-brand/10 outline-none px-3 py-2 text-sm text-ink placeholder:text-faint min-h-16 resize-y"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted font-mono tnum">{POST_MAX - body.length}</span>
              <button type="button" onClick={() => void submit()} disabled={busy || !body.trim()} className={btn.primarySm}>
                {busy ? "Sign in wallet…" : replyTo !== null ? "Reply" : "Post"}
              </button>
            </div>
            {err ? <p className="text-xs text-down-ink">{err}</p> : null}
          </div>
        )}
      </div>

      <ul className="divide-y divide-line">
        {top.length === 0 ? <li className="px-4 py-8 text-center text-sm text-muted">No comments yet.</li> : null}
        {top.map((p) => (
          <li key={p.id} className="px-4 py-3">
            <PostItem p={p} now={now} canReply={isConnected && !muted} onReply={() => setReplyTo(p.id)} onReport={address && p.wallet !== address.toLowerCase() ? (r) => void report(p, r) : undefined} />
            {replies(p.id).length ? (
              <ul className="mt-2 ml-6 pl-3 border-l border-line space-y-2">
                {replies(p.id).map((r) => (
                  <li key={r.id}>
                    <PostItem p={r} now={now} canReply={false} onReport={address && r.wallet !== address.toLowerCase() ? (x) => void report(r, x) : undefined} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PostItem({ p, now, canReply, onReply, onReport }: { p: PostRow; now: number; canReply: boolean; onReply?: () => void; onReport?: (r: ReportReason) => void }) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted font-mono">
        <span className="inline-flex shrink-0 items-center gap-2 text-ink" title={p.wallet}><WalletAvatar address={p.wallet} size={24} />{shortAddr(p.wallet)}</span>
        <TagChip tag={p.tag} />
        <span suppressHydrationWarning>{now ? `${ago(p.created_at, now)} ago` : ""}</span>
        <span className="text-faint">#{p.id}</span>
        <span className="ml-auto flex items-center gap-2">
          {canReply && onReply ? (
            <button type="button" onClick={onReply} className="hover:text-ink">
              reply
            </button>
          ) : null}
          {onReport ? (
            <span className="relative">
              <button type="button" onClick={() => setMenu((m) => !m)} className="hover:text-ink" aria-haspopup="menu" aria-expanded={menu}>
                report
              </button>
              {menu ? (
                <span className="absolute right-0 top-5 z-10 rounded-xl bg-card border border-line shadow-dialog p-1 flex flex-col min-w-28" role="menu">
                  {REPORT_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        onReport(r);
                      }}
                      className="text-left px-2.5 py-1.5 rounded-lg text-[12px] font-sans text-body hover:bg-paper hover:text-ink"
                    >
                      {r}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </div>
      <p className="mt-1 text-[14px] text-ink whitespace-pre-wrap break-words">{p.body}</p>
    </div>
  );
}

/** The human feed (home column + /feed): latest top-level posts across tokens. */
const COMPACT_LIMIT = 5;

export function PostsFeed({ initial, compact = false }: { initial: PostRow[]; compact?: boolean }) {
  const { subscribe } = useLive();
  const [posts, setPosts] = useState<PostRow[]>(initial);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setNow(nowMs()), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(
    () =>
      subscribe((snap) => {
        if (snap.posts) {
          setPosts(snap.posts);
          setNow(nowMs());
        }
      }),
    [subscribe],
  );
  // compact (home): last 5 only, collapsible; the choice is remembered per browser
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!compact) return;
    const t = setTimeout(() => {
      try { setCollapsed(localStorage.getItem("bb:posts-collapsed") === "1"); } catch { /* storage unavailable */ }
    }, 0);
    return () => clearTimeout(t);
  }, [compact]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("bb:posts-collapsed", next ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };
  const shown = compact ? posts.slice(0, COMPACT_LIMIT) : posts;
  return (
    <section className="min-w-0">
      <div className={`px-4 ${compact ? "min-h-14" : "h-11"} flex items-center justify-between gap-2 ${compact && collapsed ? "" : "border-b border-line"}`}>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
          {compact ? <MessageSquare size={14} aria-hidden="true" className="text-muted" /> : null}
          Posts
          {compact && posts.length > 0 ? <span className="font-mono text-[11px] font-normal text-muted tnum" title={`Showing the latest ${Math.min(COMPACT_LIMIT, posts.length)} of ${posts.length} recent posts`}>{posts.length}</span> : null}
        </h2>
        {compact ? (
          <div className="flex items-center gap-2">
            <Link href="/feed" className="inline-flex min-h-10 items-center text-[11px] text-muted hover:text-ink">
              View all ↗
            </Link>
            <button
              type="button"
              onClick={toggle}
              aria-expanded={!collapsed}
              aria-controls="home-posts"
              aria-label={collapsed ? "Show posts" : "Hide posts"}
              title={collapsed ? "Show posts" : "Hide posts"}
              className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-muted hover:text-ink hover:bg-card"
            >
              <ChevronDown size={14} className={`transition-transform motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-muted">what people are saying</span>
        )}
      </div>
      <ul id="home-posts" className="divide-y divide-line" hidden={compact && collapsed}>
        {shown.length === 0 ? <li className={`px-4 py-6 ${compact ? "" : "text-center"}`}><p className="text-xs font-medium text-ink">The conversation starts on a token page.</p><p className="mt-1.5 text-pretty text-xs leading-relaxed text-muted">No posts yet. Holders, traders and creators can join with a wallet signature.</p></li> : null}
        {shown.map((p) => (
          <li key={p.id} className="px-4 py-3">
            <Link href={`/t/${p.chain}/${p.token}#comments`} className="flex items-start gap-2.5 min-w-0">
              <WalletAvatar address={p.wallet} />
              <div className="min-w-0 flex-1">
                {compact ? <>
                  <div className="flex min-w-0 items-center justify-between gap-2 text-[11px]"><span className="truncate font-mono text-ink" title={p.wallet}>{shortAddr(p.wallet)}</span><time dateTime={p.created_at} className="shrink-0 font-mono text-muted tnum" suppressHydrationWarning>{now ? ago(p.created_at, now) : ""}</time></div>
                  <p className="mt-0.5 truncate text-[10px] text-muted">On {p.symbol || shortAddr(p.token)} · {CHAIN_SHORT[p.chain]}{p.tag ? ` · ${p.tag}` : ""}</p>
                </> : <div className="flex items-center gap-1.5 text-[11px] text-muted font-mono min-w-0">
                  <span className="text-ink shrink-0" title={p.wallet}>{shortAddr(p.wallet)}</span>
                  <ChainBadge chain={p.chain} className="shrink-0" />
                  <TagChip tag={p.tag} />
                  <span className="truncate font-sans">on {p.symbol || shortAddr(p.token)}</span>
                  <span className="ml-auto shrink-0" suppressHydrationWarning>{now ? ago(p.created_at, now) : ""}</span>
                </div>}
                <p className={`mt-0.5 text-[13px] text-ink whitespace-pre-wrap break-words ${compact ? "line-clamp-3" : ""}`}>{p.body}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
