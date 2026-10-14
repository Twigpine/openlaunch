"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConfig } from "wagmi";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { getWalletClient } from "wagmi/actions";
import { WhoAvatar, WhoName } from "@/components/profile/Who";
import ChainBadge from "./ChainBadge";
import { useLive } from "./LiveProvider";
import { toast } from "./TxToasts";
import { btn } from "@/components/ui";
import { buildModMessage, buildPostMessage, buildReportMessage, POST_MAX, REPORT_REASONS, validateBody, type ReportReason } from "@/lib/launchpad/posts";
import type { PostRow } from "@/lib/launchpad/postsServer";
import { nowMs } from "@/lib/launchpad/time";
import { CHAINS, CHAIN_SHORT, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import ConnectWallet from "@/components/ConnectWallet";
import { ArrowUpRight, ChevronDown, MessageSquare } from "lucide-react";
import { useTranslations } from "use-intl";
import { useAgo } from "@/i18n/useAgo";
import type { Messages } from "@/i18n/messages";
import { MagicCard } from "@/components/vendor/magic-card";
import { nonce } from "@/lib/nonce";

/** The holder tag shown beside a post's author (creator, whale, holder). */
function TagChip({ tag }: { tag: PostRow["tag"] }) {
  const t = useTranslations("posts");
  if (!tag) return null;
  const cls = tag === "creator" ? "bg-brand-soft text-brand border-brand/20" : tag === "whale" ? "bg-warm-soft text-warm-ink border-warm/30" : "bg-up-soft text-up border-up/20";
  return <span className={`inline-flex items-center rounded-md border px-1.5 h-5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{t(`tags.${tag}`)}</span>;
}

type Reason = Exclude<keyof Messages["posts"]["errors"], "wait" | "tooLong">;
/**
 * Why a post, report or mute failed, as messages: the English reasons validateBody (lib/launchpad/posts.ts) and the
 * posts API (lib/launchpad/postsServer.ts) give. friendlyError (lib/errors.ts) already words its reasons in the reader's
 * language (the errors area), and any other text, such as a wallet's own error, reads as it came.
 */
const REASONS = new Map<string, Reason>([
  ["empty post", "empty"],
  ["no HTML", "noHtml"],
  ["slow down", "slowDown"],
  ["comments are off for this token", "commentsOff"],
  ["daily post limit reached", "dailyLimit"],
  ["parent not found", "parentNotFound"],
  ["replies are one level deep", "replyDepth"],
  ["hold the token, or trade or launch on openlaunch first, to post", "notEligible"],
  ["signature does not match", "badSignature"],
  ["nonce already used", "nonceUsed"],
  ["stale signature", "staleSignature"],
  ["stale or bad nonce", "staleNonce"],
  ["unknown token", "unknownToken"],
  ["post not found", "postNotFound"],
  ["cannot report your own post", "ownPost"],
  ["trade, launch or post first to report", "reportNotEligible"],
  ["not the creator", "notCreator"],
  ["db unconfigured", "unavailable"],
  ["post rejected", "postRejected"],
  ["report rejected", "reportRejected"],
  ["failed", "failed"],
]);

/** A failure reason (see REASONS) in the reader's language. */
function useReason() {
  const t = useTranslations("posts");
  return useCallback((reason: string) => {
    const key = REASONS.get(reason);
    if (key) return t(`errors.${key}`);
    const wait = /^wait (\d+)s between posts$/.exec(reason);
    if (wait) return t("errors.wait", { seconds: Number(wait[1]) });
    const max = /^max (\d+) characters$/.exec(reason);
    if (max) return t("errors.tooLong", { max: Number(max[1]) });
    return reason;
  }, [t]);
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
  const { address, isConnected } = useHydratedAccount();
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
  const t = useTranslations("posts");
  const explain = useReason();

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
      toast({ kind: "info", title: d.hidden ? t("comments.hidden") : t("comments.reported"), sub: t("comments.thanks") });
      if (d.hidden) setPosts((cur) => cur.filter((x) => x.id !== p.id));
    } catch (e) {
      toast({ kind: "info", title: t("comments.reportFailed"), sub: explain(friendlyError(e)) });
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
      toast({ kind: "info", title: next ? t("comments.commentsOff", { symbol }) : t("comments.commentsOn", { symbol }) });
    } catch (e) {
      toast({ kind: "info", title: t("comments.commentsFailed"), sub: explain(friendlyError(e)) });
    }
  }

  const top = posts.filter((p) => p.parent_id === null);
  const replies = (id: number) => posts.filter((p) => p.parent_id === id).slice().reverse();

  return (
    <section className={embedded ? "overflow-hidden bg-paper" : "rounded-2xl bg-card border border-line overflow-hidden"} id="comments">
      <div className="px-4 h-11 flex items-center justify-between border-b border-line">
        <h2 className="text-sm font-semibold text-ink">
          {t("comments.title")} <span className="ml-1 text-xs font-normal text-muted font-mono tnum">{posts.length}</span>
        </h2>
        {isCreator ? (
          <button type="button" onClick={() => void mute(!muted)} className="text-[11px] font-medium text-muted hover:text-ink">
            {muted ? t("comments.turnOn") : t("comments.turnOff")}
          </button>
        ) : null}
      </div>

      {/* composer */}
      <div className="px-4 py-3 border-b border-line bg-paper/60">
        {muted ? (
          <p className="text-sm text-muted">{t("comments.off")}</p>
        ) : !isConnected ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted">{t("comments.connectPrompt")}</p>
            <ConnectWallet className={btn.secondarySm}>{t("comments.connect")}</ConnectWallet>
          </div>
        ) : (
          <div className="space-y-2">
            {replyTo !== null ? (
              <p className="text-[11px] text-muted">
                {t("comments.replyingTo", { id: replyTo })}{" "}
                <button type="button" className="underline hover:text-ink" onClick={() => setReplyTo(null)}>
                  {t("comments.cancel")}
                </button>
              </p>
            ) : null}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, POST_MAX))}
              placeholder={t("comments.placeholder", { symbol })}
              className="w-full rounded-xl bg-card border border-line-strong focus:border-brand focus:ring-4 focus:ring-brand/10 outline-none px-3 py-2 text-sm text-ink placeholder:text-faint min-h-16 resize-y"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted font-mono tnum">{POST_MAX - body.length}</span>
              <button type="button" onClick={() => void submit()} disabled={busy || !body.trim()} className={btn.primarySm}>
                {busy ? t("comments.signing") : replyTo !== null ? t("comments.reply") : t("comments.post")}
              </button>
            </div>
            {err ? <p className="text-xs text-down-ink">{explain(err)}</p> : null}
          </div>
        )}
      </div>

      <ul className="divide-y divide-line">
        {top.length === 0 ? <li className="px-4 py-8 text-center text-sm text-muted">{t("comments.empty")}</li> : null}
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

/** One comment: author (name and avatar from their profile), tag, age, body and the reply / report controls. */
function PostItem({ p, now, canReply, onReply, onReport }: { p: PostRow; now: number; canReply: boolean; onReply?: () => void; onReport?: (r: ReportReason) => void }) {
  const [menu, setMenu] = useState(false);
  const t = useTranslations("posts");
  const { ago } = useAgo();
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted font-mono">
        <span className="inline-flex shrink-0 items-center gap-2 text-ink" title={p.wallet}><WhoAvatar address={p.wallet} size={24} /><WhoName address={p.wallet} className="font-sans text-[12px]" fallback={shortAddr(p.wallet)} /></span>
        <TagChip tag={p.tag} />
        <span suppressHydrationWarning>{now ? ago(p.created_at, now) : ""}</span>
        <span className="text-faint">#{p.id}</span>
        <span className="ml-auto flex items-center gap-2">
          {canReply && onReply ? (
            <button type="button" onClick={onReply} className="hover:text-ink">
              {t("item.reply")}
            </button>
          ) : null}
          {onReport ? (
            <span className="relative">
              <button type="button" onClick={() => setMenu((m) => !m)} className="hover:text-ink" aria-haspopup="menu" aria-expanded={menu}>
                {t("item.report")}
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
                      {t(`item.reasons.${r}`)}
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
/** The home column's tag badge: the same three standings and labels (posts.tags) as TagChip, in sentence case. */
const TAG_BADGE: Record<Exclude<PostRow["tag"], null>, string> = {
  creator: "bg-brand-soft text-brand",
  whale: "bg-warm-soft text-warm-ink",
  holder: "bg-up-soft text-up",
};

/** The latest posts across all tokens, compact on the home page, each author shown by their profile name. */
export function PostsFeed({ initial, compact = false }: { initial: PostRow[]; compact?: boolean }) {
  const { subscribe } = useLive();
  const t = useTranslations("posts");
  const { short } = useAgo();
  const [posts, setPosts] = useState<PostRow[]>(initial);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setNow(nowMs()), 0);
    return () => clearTimeout(id);
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
    const id = setTimeout(() => {
      try { setCollapsed(localStorage.getItem("bb:posts-collapsed") === "1"); } catch { /* storage unavailable */ }
    }, 0);
    return () => clearTimeout(id);
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
  const feed = (
    <section className={compact ? "overflow-hidden rounded-[inherit]" : "rounded-2xl border border-line overflow-hidden bg-card"}>
      <div className={`px-4 ${compact ? "min-h-14" : "h-11"} flex items-center justify-between gap-2 ${compact && collapsed ? "" : "border-b border-line"}`}>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
          {compact ? <MessageSquare size={14} aria-hidden="true" className="text-muted" /> : null}
          {t("feed.title")}
          {compact && posts.length > 0 ? <span className="font-mono text-[11px] font-normal text-muted tnum" title={t("feed.showing", { shown: Math.min(COMPACT_LIMIT, posts.length), total: posts.length })}>{posts.length}</span> : null}
        </h2>
        {compact ? (
          <div className="flex items-center gap-2">
            <Link href="/feed" className="inline-flex min-h-10 items-center gap-0.5 text-[11px] font-medium text-muted transition-colors hover:text-ink motion-reduce:transition-none">
              {t("feed.viewAll")}<ArrowUpRight size={12} aria-hidden="true" />
            </Link>
            <button
              type="button"
              onClick={toggle}
              aria-expanded={!collapsed}
              aria-controls="home-posts"
              aria-label={collapsed ? t("feed.show") : t("feed.hide")}
              title={collapsed ? t("feed.show") : t("feed.hide")}
              className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-muted transition-colors hover:text-ink hover:bg-ink/[0.05] motion-reduce:transition-none"
            >
              <ChevronDown size={14} className={`transition-transform motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-muted">{t("feed.subtitle")}</span>
        )}
      </div>
      <ul id="home-posts" className="divide-y divide-line" hidden={compact && collapsed}>
        {shown.length === 0 ? <li className={`px-4 py-6 ${compact ? "" : "text-center"}`}><p className="text-xs font-medium text-ink">{t("feed.emptyTitle")}</p><p className="mt-1.5 text-pretty text-xs leading-relaxed text-muted">{t("feed.emptyBody")}</p></li> : null}
        {shown.map((p) => (
          <li key={p.id} className={compact ? "" : "px-4 py-3"}>
            <Link href={`/t/${p.chain}/${p.token}#comments`} className={`flex items-start gap-2.5 min-w-0 ${compact ? "px-4 py-3 transition-colors hover:bg-ink/[0.03] motion-reduce:transition-none" : ""}`}>
              <WhoAvatar address={p.wallet} />
              <div className="min-w-0 flex-1">
                {compact ? <>
                  <div className="flex min-w-0 items-center gap-2 text-[11px]">
                    <WhoName address={p.wallet} link={false} fallback={<span className="truncate font-code text-ink" title={p.wallet}>{shortAddr(p.wallet)}</span>} />
                    {p.tag ? <span className={`shrink-0 rounded-md px-1.5 py-px text-[10px] font-semibold ${TAG_BADGE[p.tag]}`}>{t(`tags.${p.tag}`)}</span> : null}
                    <time dateTime={p.created_at} className="ml-auto shrink-0 text-muted tnum" suppressHydrationWarning>{now ? short(p.created_at, now) : ""}</time>
                  </div>
                  {/* a speech bubble that points back at the wallet; long links wrap instead of running out of the card */}
                  <div className="mt-1.5 rounded-xl rounded-tl-sm bg-ink/[0.045] px-3 py-2"><p className="line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere]">{p.body}</p></div>
                  <p className="mt-1.5 truncate text-[11px] text-muted">{t.rich("feed.on", { symbol: `$${p.symbol || shortAddr(p.token)}`, token: (chunks) => <span className="font-medium text-body">{chunks}</span> })} · {CHAIN_SHORT[p.chain]}</p>
                </> : <div className="flex items-center gap-1.5 text-[11px] text-muted font-mono min-w-0">
                  <WhoName address={p.wallet} link={false} className="shrink-0 font-sans" fallback={<span className="text-ink shrink-0" title={p.wallet}>{shortAddr(p.wallet)}</span>} />
                  <ChainBadge chain={p.chain} className="shrink-0" />
                  <TagChip tag={p.tag} />
                  <span className="truncate font-sans">{t.rich("feed.on", { symbol: p.symbol || shortAddr(p.token), token: (chunks) => chunks })}</span>
                  <span className="ml-auto shrink-0" suppressHydrationWarning>{now ? short(p.created_at, now) : ""}</span>
                </div>}
                {compact ? null : <p className="mt-0.5 text-[13px] text-ink whitespace-pre-wrap break-words">{p.body}</p>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
  // the home column sits among the other sidebar cards, with the same frame and pointer light
  return compact ? <MagicCard className="rounded-2xl">{feed}</MagicCard> : feed;
}
