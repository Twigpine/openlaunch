"use client";

import Link from "next/link";
import { useContext, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, MessageSquare, MessagesSquare, RefreshCw, Search, Signature, X } from "lucide-react";
import { useTranslations } from "use-intl";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import TokenAvatar from "@/components/launchpad/TokenAvatar";
import { ChainLogo } from "@/components/launchpad/ChainLogo";
import { WhoAvatar, WhoName } from "@/components/profile/Who";
import { NamesContext } from "@/components/profile/NamesProvider";
import { cachedName, namesVersion, subscribeNames } from "@/lib/profiles/names-client";
import { useLive } from "@/components/launchpad/LiveProvider";
import { CHAIN_SHORT, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import { nowMs } from "@/lib/launchpad/time";
import { useAgo } from "@/i18n/useAgo";
import type { PostRow } from "@/lib/launchpad/postsServer";
import { communityFingerprint, filterCommunityPosts } from "@/lib/launchpad/community-feed";
import shell from "./SectionShell.module.css";
import styles from "./CommunityFeed.module.css";

/** The community page's post stream, each author shown by their profile name and picture. */
export default function CommunityFeed({ initial, loadError = false }: { initial: PostRow[]; loadError?: boolean }) {
  const t = useTranslations("info.community");
  const { ago } = useAgo();
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

  // authors are searchable by the names the feed shows: the server's seed first, then the browser's store (re-filtered
  // as names arrive)
  const seeded = useContext(NamesContext);
  useSyncExternalStore(subscribeNames, namesVersion, () => 0);
  const shown = filterCommunityPosts(initial, chain, query, (w) => cachedName(w) ?? seeded?.[w.toLowerCase()]);
  const filtered = Boolean(chain || query.trim());
  function reset() { setChain(null); setQuery(""); }

  return <div className={styles.layout}>
    <section className={shell.panel} aria-label={t("label")} aria-busy={refreshing}>
      <div className={styles.toolbar}>
        <div className={styles.feedTitle}><span className={styles.titleIcon} aria-hidden="true"><MessagesSquare size={16} /></span><h2>{t("title")}</h2><span>{t("newest")}</span></div>
        <button type="button" className={styles.refresh} onClick={() => startTransition(() => router.refresh())} disabled={refreshing} aria-label={t("refresh")} title={t("refresh")}><RefreshCw size={15} aria-hidden="true" /></button>
      </div>
      <div className={styles.filters}>
        <ToggleGroup multiple={false} value={[chain ?? "all"]} onValueChange={(values) => { if (values[0]) setChain(values[0] === "all" ? null : values[0] as ChainKey); }} aria-label={t("filterByChain")}>
          <ToggleGroupItem value="all" className="min-h-11">{t("allChains")}</ToggleGroupItem>
          {/* the market board's chain filter: each chain's mark, its name from sm up */}
          {VISIBLE_CHAINS.map((k) => <ToggleGroupItem key={k} value={k} className="min-h-11" title={CHAIN_SHORT[k]}><ChainLogo chain={k} size={16} /><span className="max-sm:sr-only">{CHAIN_SHORT[k]}</span></ToggleGroupItem>)}
        </ToggleGroup>
        <div className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          {query ? <button type="button" aria-label={t("clearSearch")} onClick={() => setQuery("")}><X size={14} aria-hidden="true" /></button> : null}
        </div>
      </div>
      <div className={styles.resultLine}><p role="status">{refreshing ? t("refreshing") : loadError ? t("unavailable") : t.rich(filtered ? "matching" : "recent", { count: shown.length, num: (chunks) => <span>{chunks}</span> })}</p><span>{t("conversations")}</span></div>
      {loadError ? <div className={styles.empty}>
        <MessageSquare size={30} aria-hidden="true" className={styles.emptyIcon} /><h3>{t("loadErrorTitle")}</h3><p>{t("loadErrorBody")}</p><button type="button" className={shell.action} disabled={refreshing} onClick={() => startTransition(() => router.refresh())}>{t("tryAgain")} <RefreshCw size={14} aria-hidden="true" /></button>
      </div> : shown.length === 0 ? <div className={styles.empty}>
        <div className={styles.conversationMark} aria-hidden="true"><MessageSquare size={30} /><span /><span /></div>
        <p className={styles.emptyEyebrow}>{filtered ? t("filteredEyebrow") : t("emptyEyebrow")}</p>
        <h3>{filtered ? t("filteredTitle") : t("emptyTitle")}</h3>
        <p>{filtered ? t("filteredBody") : t("emptyBody")}</p>
        {filtered ? <button type="button" onClick={reset} className={shell.action}>{t("clearFilters")} <X size={14} aria-hidden="true" /></button> : <Link href="/#launches" className={shell.action}>{t("findToken")} <ArrowRight size={15} aria-hidden="true" /></Link>}
      </div> : <ol className={styles.posts} aria-label={t("list")}>
        {shown.map((post) => <li key={post.id}>
          <article className={styles.post}>
            <Link href={`/t/${post.chain}/${post.token}#comments`} className={styles.postLink}>
              <div className={styles.postHeading}>
                <WhoAvatar address={post.wallet} size={40} />
                <div className={styles.postAuthor}>
                  <h3 title={post.wallet}><span className="sr-only">{t("postBy")} </span><WhoName address={post.wallet} link={false} fallback={shortAddr(post.wallet)} /></h3>
                  <p>
                    {/* a post's standing on its token, worded and coloured as on the home page's posts */}
                    {post.tag ? <span className={styles.role} data-tag={post.tag}>{t(`roles.${post.tag}`)}</span> : null}
                    <time dateTime={post.created_at} title={post.created_at} suppressHydrationWarning>{now ? ago(post.created_at, now) : ""}</time>
                  </p>
                </div>
                <ArrowUpRight size={16} className={styles.postArrow} aria-hidden="true" />
              </div>
              <p className={styles.postBody}>{post.body}</p>
              <div className={styles.postMeta}>
                <TokenAvatar chain={post.chain} token={post.token} symbol={post.symbol ?? "?"} size={20} />
                <span className={styles.postToken}>
                  <span>{t.rich("on", { token: post.name || post.symbol || shortAddr(post.token), strong: (chunks) => <strong>{chunks}</strong> })}</span>
                  <span>{post.symbol ? `$${post.symbol} · ` : ""}{CHAIN_SHORT[post.chain]}</span>
                </span>
              </div>
              <span className={styles.discussion}>{t("openConversation")} <ArrowRight size={13} aria-hidden="true" /></span>
            </Link>
          </article>
        </li>)}
      </ol>}
      <div className={styles.feedFoot}>{t("foot")}</div>
    </section>

    <aside className={styles.aside} aria-label={t("aside")}>
      <section className={styles.guide}>
        <h2>{t("joinHeading")}</h2>
        <p>{t("joinBody")}</p>
        <ol className={styles.steps}>
          <li><span aria-hidden="true"><Search size={15} /></span><div><h3>{t("findStep")}</h3><p>{t("findStepBody")}</p></div></li>
          <li><span aria-hidden="true"><MessageSquare size={15} /></span><div><h3>{t("openStep")}</h3><p>{t("openStepBody")}</p></div></li>
          <li><span aria-hidden="true"><Signature size={15} /></span><div><h3>{t("signStep")}</h3><p>{t("signStepBody")}</p></div></li>
        </ol>
        <Link href="/#launches" className={shell.textLink}>{t("explore")} <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </section>
      <section className={styles.note}>
        <span className={styles.noteIcon} aria-hidden="true"><Signature size={16} /></span>
        <h2>{t("walletHeading")}</h2>
        <p>{t("walletBody")}</p>
        <p className={styles.caution}>{t("caution")}</p>
      </section>
    </aside>
  </div>;
}
