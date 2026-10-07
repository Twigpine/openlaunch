"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, MessageSquare, MessagesSquare, RefreshCw, Search, Signature, X } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import TokenAvatar from "@/components/launchpad/TokenAvatar";
import { ChainLogo } from "@/components/launchpad/ChainLogo";
import { WhoAvatar, WhoName } from "@/components/profile/Who";
import { useLive } from "@/components/launchpad/LiveProvider";
import { CHAIN_SHORT, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import { ago, nowMs } from "@/lib/launchpad/time";
import type { PostRow } from "@/lib/launchpad/postsServer";
import { communityFingerprint, filterCommunityPosts } from "@/lib/launchpad/community-feed";
import shell from "./SectionShell.module.css";
import styles from "./CommunityFeed.module.css";

/** A post's standing on its token, worded and coloured as on the home page's posts. */
const ROLE: Record<NonNullable<PostRow["tag"]>, string> = { creator: "Creator", whale: "Whale", holder: "Holder" };

/** The community page's post stream, each author shown by their profile name and picture. */
export default function CommunityFeed({ initial, loadError = false }: { initial: PostRow[]; loadError?: boolean }) {
  const router = useRouter();
  const { subscribe } = useLive();
  const [chain, setChain] = useState<ChainKey | null>(null);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(0);
  const [refreshing, startTransition] = useTransition();
  const observed = useRef(communityFingerprint(initial));
  const fullWindowRefresh = useRef(0);
  // Keep the server's 100-row window. A changed shared snapshot is a refresh
  // signal, not a replacement with the poller's shorter 30-row window.
  useEffect(() => {
    observed.current = communityFingerprint(initial);
    fullWindowRefresh.current = nowMs();
    const timer = setTimeout(() => setNow(nowMs()), 0);
    const unsubscribe = subscribe((snap) => {
      setNow(nowMs());
      if (!snap.posts) return;
      const next = communityFingerprint(snap.posts);
      // Also refresh the older loaded rows periodically so moderated posts
      // outside the live snapshot cannot remain visible indefinitely.
      if (next === observed.current && nowMs() - fullWindowRefresh.current < 60_000) return;
      observed.current = next;
      fullWindowRefresh.current = nowMs();
      startTransition(() => router.refresh());
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [initial, router, subscribe]);

  const shown = filterCommunityPosts(initial, chain, query);
  const filtered = Boolean(chain || query.trim());
  function reset() { setChain(null); setQuery(""); }

  return <div className={styles.layout}>
    <section className={shell.panel} aria-label="Recent community posts" aria-busy={refreshing}>
      <div className={styles.toolbar}>
        <div className={styles.feedTitle}><span className={styles.titleIcon} aria-hidden="true"><MessagesSquare size={16} /></span><h2>Community feed</h2><span>Newest first</span></div>
        <button type="button" className={styles.refresh} onClick={() => startTransition(() => router.refresh())} disabled={refreshing} aria-label="Refresh posts" title="Refresh posts"><RefreshCw size={15} aria-hidden="true" /></button>
      </div>
      <div className={styles.filters}>
        <ToggleGroup multiple={false} value={[chain ?? "all"]} onValueChange={(values) => { if (values[0]) setChain(values[0] === "all" ? null : values[0] as ChainKey); }} aria-label="Filter posts by chain">
          <ToggleGroupItem value="all" className="min-h-11">All chains</ToggleGroupItem>
          {/* the market board's chain filter: each chain's mark, its name from sm up */}
          {VISIBLE_CHAINS.map((k) => <ToggleGroupItem key={k} value={k} className="min-h-11" title={CHAIN_SHORT[k]}><ChainLogo chain={k} size={16} /><span className="max-sm:sr-only">{CHAIN_SHORT[k]}</span></ToggleGroupItem>)}
        </ToggleGroup>
        <div className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label="Search recent posts" placeholder="Search recent posts" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query ? <button type="button" aria-label="Clear post search" onClick={() => setQuery("")}><X size={14} aria-hidden="true" /></button> : null}
        </div>
      </div>
      <div className={styles.resultLine}><p role="status">{refreshing ? "Refreshing posts…" : loadError ? "Feed unavailable" : <><span>{shown.length}</span> {filtered ? "matching" : "recent"} {shown.length === 1 ? "post" : "posts"}</>}</p><span>Token-page conversations</span></div>
      {loadError ? <div className={styles.empty}>
        <MessageSquare size={30} aria-hidden="true" className={styles.emptyIcon} /><h3>The feed couldn’t load.</h3><p>Your connection or the indexer may be unavailable. You can retry without connecting a wallet.</p><button type="button" className={shell.action} disabled={refreshing} onClick={() => startTransition(() => router.refresh())}>Try again <RefreshCw size={14} aria-hidden="true" /></button>
      </div> : shown.length === 0 ? <div className={styles.empty}>
        <div className={styles.conversationMark} aria-hidden="true"><MessageSquare size={30} /><span /><span /></div>
        <p className={styles.emptyEyebrow}>{filtered ? "Nothing in this view" : "Room for a first word"}</p>
        <h3>{filtered ? "No matching conversations." : "The next conversation starts with you."}</h3>
        <p>{filtered ? "Try another chain or search term. Search covers only the recent posts loaded here." : "Open a token, head to Conversation, and add your perspective. Holders, traders and creators can post with a free wallet signature."}</p>
        {filtered ? <button type="button" onClick={reset} className={shell.action}>Clear filters <X size={14} aria-hidden="true" /></button> : <Link href="/#launches" className={shell.action}>Find a token <ArrowRight size={15} aria-hidden="true" /></Link>}
      </div> : <ol className={styles.posts} aria-label="Posts, newest first">
        {shown.map((post) => <li key={post.id}>
          <article className={styles.post}>
            <Link href={`/t/${post.chain}/${post.token}#comments`} className={styles.postLink}>
              <div className={styles.postHeading}>
                <WhoAvatar address={post.wallet} size={40} />
                <div className={styles.postAuthor}>
                  <h3 title={post.wallet}><span className="sr-only">Post by </span><WhoName address={post.wallet} link={false} fallback={shortAddr(post.wallet)} /></h3>
                  <p>
                    {post.tag ? <span className={styles.role} data-tag={post.tag}>{ROLE[post.tag]}</span> : null}
                    <time dateTime={post.created_at} title={post.created_at} suppressHydrationWarning>{now ? `${ago(post.created_at, now)} ago` : ""}</time>
                  </p>
                </div>
                <ArrowUpRight size={16} className={styles.postArrow} aria-hidden="true" />
              </div>
              <p className={styles.postBody}>{post.body}</p>
              <div className={styles.postMeta}>
                <TokenAvatar chain={post.chain} token={post.token} symbol={post.symbol ?? "?"} size={20} />
                <span className={styles.postToken}>
                  <span>On <strong>{post.name || post.symbol || shortAddr(post.token)}</strong></span>
                  <span>{post.symbol ? `$${post.symbol} · ` : ""}{CHAIN_SHORT[post.chain]}</span>
                </span>
              </div>
              <span className={styles.discussion}>Open conversation <ArrowRight size={13} aria-hidden="true" /></span>
            </Link>
          </article>
        </li>)}
      </ol>}
      <div className={styles.feedFoot}>Showing up to 100 recent posts. Read the full thread on its token page.</div>
    </section>

    <aside className={styles.aside} aria-label="About the community">
      <section className={styles.guide}>
        <h2>Join from the token.</h2>
        <p>Every post belongs to a token. The full thread, the market and the contracts stay together.</p>
        <ol className={styles.steps}>
          <li><span aria-hidden="true"><Search size={15} /></span><div><h3>Find your token</h3><p>Browse launches on any chain.</p></div></li>
          <li><span aria-hidden="true"><MessageSquare size={15} /></span><div><h3>Open Conversation</h3><p>Read the thread or reply to a post.</p></div></li>
          <li><span aria-hidden="true"><Signature size={15} /></span><div><h3>Sign your words</h3><p>A wallet signature, not a transaction.</p></div></li>
        </ol>
        <Link href="/#launches" className={shell.textLink}>Explore launches <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </section>
      <section className={styles.note}>
        <span className={styles.noteIcon} aria-hidden="true"><Signature size={16} /></span>
        <h2>A wallet behind every post.</h2>
        <p>Posting is open to creators, token holders, and wallets that have traded or launched here. No account to create. No gas to post.</p>
        <p className={styles.caution}>Posts are community opinions, not endorsements. Check the token and its contracts for yourself.</p>
      </section>
    </aside>
  </div>;
}
