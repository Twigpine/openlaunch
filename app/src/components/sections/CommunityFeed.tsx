"use client";

import Link from "next/link";
import { Component, createRef, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUp, ArrowUpRight, MessageSquare, RefreshCw, Search, Signature, X } from "lucide-react";
import ChainSelector from "@/components/launchpad/ChainSelector";
import TokenAvatar from "@/components/launchpad/TokenAvatar";
import WalletAvatar from "@/components/WalletAvatar";
import { useLive } from "@/components/launchpad/LiveProvider";
import { CHAIN_SHORT, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { ago, nowMs } from "@/lib/launchpad/time";
import type { PostRow } from "@/lib/launchpad/postsServer";
import { communityFingerprint, filterCommunityPosts, reconcileCommunityWindow, revealCommunityPosts } from "@/lib/launchpad/community-feed";
import shell from "./SectionShell.module.css";
import styles from "./CommunityFeed.module.css";

type ScrollAnchorProps = { children: ReactNode; revision: object; filterKey: string; rowIds: number[]; preservePosition: boolean };
type ScrollAnchor = { id: string; top: number } | null;

// getSnapshotBeforeUpdate reads the old DOM immediately before React changes it.
// A layout-effect read is too late to preserve the reader after an edited or
// moderated row changes height. Keep this lifecycle boundary local to the feed.
class FeedScrollAnchor extends Component<ScrollAnchorProps> {
  private list = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: ScrollAnchorProps): ScrollAnchor {
    if (!this.props.preservePosition || previous.revision === this.props.revision || previous.filterKey !== this.props.filterKey) return null;
    const surviving = new Set(this.props.rowIds.map(String));
    const rows = this.list.current?.querySelectorAll<HTMLElement>("[data-post-id]");
    if (!rows) return null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      // The header occupies the top 80px; choose the first surviving reading row.
      if (surviving.has(row.dataset.postId!) && rect.bottom > 80 && rect.top < window.innerHeight) {
        return { id: row.dataset.postId!, top: rect.top };
      }
    }
    return null;
  }

  componentDidUpdate(_previous: ScrollAnchorProps, _state: unknown, anchor: ScrollAnchor) {
    if (!anchor) return;
    const row = this.list.current?.querySelector<HTMLElement>(`[data-post-id="${anchor.id}"]`);
    if (row) {
      const delta = row.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > .5) window.scrollBy({ top: delta, behavior: "instant" });
    }
  }

  render() { return <div id="community-posts" ref={this.list}>{this.props.children}</div>; }
}

export default function CommunityFeed({ initial, loadError = false }: { initial: PostRow[]; loadError?: boolean }) {
  const router = useRouter();
  const { subscribe } = useLive();
  const [chain, setChain] = useState<ChainKey | null>(null);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(0);
  const [refreshing, startTransition] = useTransition();
  const [readingDown, setReadingDown] = useState(false);
  const [feed, setFeed] = useState(() => ({ source: initial, ...reconcileCommunityWindow<PostRow>({ visible: [], pending: [] }, initial, false) }));
  const [entering, setEntering] = useState<number[]>([]);
  const entryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedStart = useRef<HTMLDivElement>(null);
  const observed = useRef(communityFingerprint(initial));
  const fullWindowRefresh = useRef(0);
  // Reconcile before committing the new server payload. A failed load is not an
  // authoritative empty window. Filters remain local and are never reset here.
  if (!loadError && initial !== feed.source) {
    setFeed({ source: initial, ...reconcileCommunityWindow(feed, initial, readingDown || feed.pending.length > 0) });
  }

  useEffect(() => {
    const updateReadingPosition = () => setReadingDown((feedStart.current?.getBoundingClientRect().top ?? 0) < 80);
    updateReadingPosition();
    window.addEventListener("scroll", updateReadingPosition, { passive: true });
    window.addEventListener("resize", updateReadingPosition);
    return () => {
      window.removeEventListener("scroll", updateReadingPosition);
      window.removeEventListener("resize", updateReadingPosition);
    };
  }, []);

  useEffect(() => () => { if (entryTimer.current) clearTimeout(entryTimer.current); }, []);
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

  const shown = filterCommunityPosts(feed.visible, chain, query);
  const pending = filterCommunityPosts(feed.pending, chain, query);
  const filtered = Boolean(chain || query.trim());
  function reset() { setChain(null); setQuery(""); }
  function showNewPosts() {
    const revealIds = pending.map((post) => post.id);
    setEntering(revealIds);
    if (entryTimer.current) clearTimeout(entryTimer.current);
    // Clear even when reduced motion disables animationend, so changing a filter
    // later cannot replay an old batch's entrance.
    entryTimer.current = setTimeout(() => setEntering([]), 250);
    setFeed((current) => ({ source: current.source, ...revealCommunityPosts(current, current.source, revealIds) }));
  }

  return <div className={styles.layout}>
    <section className={shell.panel} aria-label="Recent community posts" aria-busy={refreshing}>
      <header className={styles.controls}>
      <div className={styles.toolbar}>
        <div className={styles.feedTitle}><MessageSquare size={17} aria-hidden="true" /><h2>Community feed</h2><span>Newest first</span></div>
      </div>
      <div className={styles.filters}>
        <ChainSelector value={chain} onChange={setChain} label="Filter posts by chain" />
        <div className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label="Search recent posts" placeholder="Search recent posts" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query ? <button type="button" aria-label="Clear post search" onClick={() => setQuery("")}><X size={14} aria-hidden="true" /></button> : null}
        </div>
        <button type="button" className={styles.refresh} onClick={() => startTransition(() => router.refresh())} disabled={refreshing} aria-label="Refresh posts" title="Refresh posts"><RefreshCw size={15} aria-hidden="true" /></button>
      </div>
      <div className={styles.resultLine}><p role="status">{refreshing ? "Refreshing posts…" : loadError ? "Feed unavailable" : <><span>{shown.length}</span> {filtered ? "matching" : "recent"} {shown.length === 1 ? "post" : "posts"}</>}</p><span>Token-page conversations</span></div>
      </header>
      <div ref={feedStart} className={styles.feedStart} />
      {!loadError && pending.length > 0 && shown.length > 0 ? <div className={styles.newPostsSlot}>
        <button type="button" className={styles.newPosts} onClick={showNewPosts} aria-controls="community-posts"><ArrowUp size={14} aria-hidden="true" />{pending.length} new {pending.length === 1 ? "post" : "posts"}<span className={styles.newPostsAction}>Show</span></button>
        <span className="sr-only" role="status">{pending.length} new {pending.length === 1 ? "post is" : "posts are"} available in this view.</span>
      </div> : null}
      <FeedScrollAnchor revision={feed} filterKey={`${chain ?? ""}:${query}`} rowIds={loadError ? [] : shown.map((post) => post.id)} preservePosition={readingDown}>
      {loadError ? <div className={styles.empty}>
        <MessageSquare size={30} aria-hidden="true" className={styles.emptyIcon} /><h3>The feed couldn’t load.</h3><p>Your connection or the indexer may be unavailable. You can retry without connecting a wallet.</p><button type="button" className={shell.action} disabled={refreshing} onClick={() => startTransition(() => router.refresh())}>Try again <RefreshCw size={14} aria-hidden="true" /></button>
      </div> : shown.length === 0 ? <div className={styles.empty}>
        <MessageSquare size={30} aria-hidden="true" className={styles.emptyIcon} />
        <h3>{pending.length ? "New conversations are ready." : filtered ? "No matching conversations." : "The next conversation starts with you."}</h3>
        <p className={styles.emptyEyebrow}>{pending.length ? "Ready when you are" : filtered ? "Nothing in this view" : "Room for a first word"}</p>
        <p>{pending.length ? `${pending.length} new ${pending.length === 1 ? "post is" : "posts are"} waiting in this view. Your filters will stay the same.` : filtered ? "Try another chain or search term. Search covers only the recent posts loaded here." : "Open a token, head to Conversation, and add your perspective. Holders, traders and creators can post with a free wallet signature."}</p>
        {pending.length ? <button type="button" onClick={showNewPosts} className={shell.action}>Show new posts <ArrowUp size={14} aria-hidden="true" /></button> : filtered ? <button type="button" onClick={reset} className={shell.action}>Clear filters <X size={14} aria-hidden="true" /></button> : <Link href="/#launches" className={shell.action}>Find a token <ArrowRight size={15} aria-hidden="true" /></Link>}
      </div> : <ol className={styles.posts} aria-label="Posts, newest first">
        {shown.map((post) => <li key={post.id} data-post-id={post.id} className={entering.includes(post.id) ? styles.postEntering : undefined}>
          <article className={styles.post}>
            <Link href={`/t/${post.chain}/${post.token}#comments`} className={styles.postLink}>
              <div className={styles.postHeading}>
                <WalletAvatar address={post.wallet} size={40} />
                <div className={styles.postAuthor}>
                  <h3 title={post.wallet}><span className="sr-only">Post by </span>{shortAddr(post.wallet)}</h3>
                  <p>
                    {post.tag ? <span className={styles.role}>{post.tag}</span> : null}
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
      </FeedScrollAnchor>
      <div className={styles.feedFoot}>Showing up to 100 recent posts. Read the full thread on its token page.</div>
    </section>

    <aside className={styles.aside} aria-label="About the community">
      <section className={styles.guide}>
        <h2>Join from the token.</h2>
        <p className={styles.asideEyebrow}>A little context goes a long way</p>
        <p>Every post belongs to a token. The full thread, the market and the contracts stay together.</p>
        <ol className={styles.steps}>
          <li><span>01</span><div><h3>Find your token</h3><p>Browse launches on any chain.</p></div></li>
          <li><span>02</span><div><h3>Open Conversation</h3><p>Read the thread or reply to a post.</p></div></li>
          <li><span>03</span><div><h3>Sign your words</h3><p>A wallet signature, not a transaction.</p></div></li>
        </ol>
        <Link href="/#launches" className={shell.textLink}>Explore launches <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </section>
      <section className={styles.note}>
        <Signature size={21} aria-hidden="true" />
        <h2>A wallet behind every post.</h2>
        <p>Posting is open to creators, token holders, and wallets that have traded or launched here. No account to create. No gas to post.</p>
        <p className={styles.caution}>Posts are community opinions, not endorsements. Check the token and its contracts for yourself.</p>
      </section>
    </aside>
  </div>;
}
