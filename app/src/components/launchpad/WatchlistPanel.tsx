"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, CheckCheck, Database, RefreshCw, Star } from "lucide-react";
import ChainSelector from "./ChainSelector";
import { btn } from "@/components/ui";
import { CHAIN_SHORT, type ChainKey } from "@/lib/chainPublic";
import { watchlistKey, type WatchlistEntry } from "@/lib/launchpad/watchlist";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { ago } from "@/lib/launchpad/time";
import type { WatchlistData as WatchlistResponse } from "@/lib/launchpad/watchlistData";
import TokenAvatar from "./TokenAvatar";
import WatchButton from "./WatchButton";
import { useWatchlist } from "./useWatchlist";

type Item = WatchlistResponse["items"][number];
const number = (value: number) => value.toLocaleString("en-US");

export default function WatchlistPanel({ onBrowse }: { onBrowse: () => void }) {
  const { entries, ready, storageError, markSeen } = useWatchlist();
  const [chain, setChain] = useState<ChainKey | null>(null);
  const [notice, setNotice] = useState("");
  const [reviewCount, setReviewCount] = useState(0);
  const [reviewedScope, setReviewedScope] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  const request = JSON.stringify({ items: entries.map((entry) => ({ chain: entry.chain, token: entry.token, since: entry.seenAt ?? entry.addedAt })) });
  const query = useQuery({
    queryKey: ["watchlist", request],
    enabled: ready && entries.length > 0,
    queryFn: async ({ signal }): Promise<WatchlistResponse> => {
      const response = await fetch("/api/launch/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: request, signal, cache: "no-store" });
      if (!response.ok) throw new Error("Watchlist unavailable");
      const data = await response.json() as WatchlistResponse;
      if (!data.indexed || !Array.isArray(data.items)) throw new Error("Index unavailable");
      return data;
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const data = query.data;
  const byKey = new Map(data?.items.map((item) => [watchlistKey(item), item]));
  const shown = entries.filter((entry) => !chain || entry.chain === chain);
  const changed = shown.filter((entry) => hasChanges(entry, byKey.get(watchlistKey(entry))));
  const incomplete = shown.some((entry) => { const item = byKey.get(watchlistKey(entry)); return !item?.launch || item.holders === null; });
  const reviewable = shown.flatMap((entry) => { const item = byKey.get(watchlistKey(entry)); return item?.launch ? [item] : []; });
  const loading = !ready || (entries.length > 0 && query.isPending);
  const rowLayout = shown.map(watchlistKey).join("|");
  const reviewed = Boolean(notice && reviewedScope === rowLayout && !changed.length && !query.isError && !query.isPlaceholderData);
  function review(items: Item[]) {
    if (!data || query.isError || query.isPlaceholderData) return;
    markSeen(items.filter((item) => item.launch).map((item) => ({ chain: item.chain, token: item.token, seenAt: data.at, holders: item.holders })));
    setNotice("Reviewed. New indexed activity will appear here.");
    setReviewCount((count) => count + 1);
    setReviewedScope(items.map(watchlistKey).join("|"));
  }
  function focusAfterRemoval(button: HTMLButtonElement) {
    const row = button.closest("li");
    const next = row?.nextElementSibling?.querySelector("button") ?? row?.previousElementSibling?.querySelector("button");
    requestAnimationFrame(() => (next?.isConnected ? next : heading.current)?.focus({ preventScroll: true }));
  }

  return (
    <section aria-labelledby="watchlist-heading" className="@container min-w-0">
      <header className="pb-4 pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <h2 ref={heading} tabIndex={-1} id="watchlist-heading" className="text-2xl font-semibold tracking-tight text-ink">Your watchlist.</h2>
          <span aria-label={ready ? `${entries.length} of 50 tokens saved` : "Loading saved tokens"} className="shrink-0 font-mono text-xs text-muted tnum">{ready ? <><span className="text-ink">{entries.length}</span><span aria-hidden="true"> / 50</span></> : "…"}</span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">Your picks. Across chains. No wallet needed.</p>
      </header>
      {storageError ? <p role="alert" className="border-t border-line px-5 py-3 text-xs text-warm-ink">Some changes could not be saved. If another tab filled your watchlist, remove a token to make room. Unsaved changes last for this session.</p> : null}
      {loading ? <div role="status" className="space-y-4 border-t border-line p-6"><span className="sr-only">Loading your watchlist</span>{[0, 1, 2].map((key) => <div key={key} className="flex h-20 items-center gap-4 border-b border-line"><span className="h-10 w-10 rounded-xl bg-skeleton" /><span className="h-4 w-36 rounded bg-skeleton" /><span className="ml-auto h-4 w-20 rounded bg-skeleton" /></div>)}</div> : entries.length === 0 ? (
        <div className="border-t border-line py-10 sm:py-12">
          <Star size={20} strokeWidth={1.4} className="mb-4 text-brand" aria-hidden="true" />
          <h3 className="max-w-sm text-2xl font-semibold leading-tight tracking-tight text-ink">A little less searching.<br />A lot more keeping up.</h3>
          <p className="mt-4 max-w-sm text-pretty text-sm leading-relaxed text-body">Star a token from the launch list or its page. Come back to its trades, creator posts and holder changes in one place.</p>
          <button type="button" onClick={onBrowse} className={`${btn.secondary} mt-7`}>Find your first token <ArrowRight size={15} aria-hidden="true" /></button>
          <p className="mt-8 text-[11px] text-muted">Saved in this browser. No account, signatures or notifications.</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 pb-3">
            <ChainSelector label="Watchlist chain" value={chain} onChange={setChain} />
            <button type="button" aria-label={query.isFetching ? "Refreshing activity" : "Refresh activity"} title="Refresh activity" onClick={() => { if (!query.isFetching) void query.refetch(); }} aria-disabled={query.isFetching} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card hover:text-ink aria-disabled:opacity-50 motion-reduce:transition-none"><RefreshCw size={15} aria-hidden="true" className={query.isFetching ? "animate-spin motion-reduce:animate-none" : ""} /></button>
          </div>
          {query.isError ? <div role="alert" className="border-t border-line px-5 py-4 text-sm text-warm-ink">Could not refresh indexed activity. {data ? "Showing the last successful snapshot." : "Your saved tokens are still here."} Use Refresh to try again.</div> : null}
          {data ? <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-y border-line py-4">
            <div className="min-w-0 flex-1 basis-44"><h3 className="flex items-center gap-2 text-sm font-semibold text-ink">{query.isPlaceholderData ? "Updating your activity…" : changed.length && !query.isError ? <><span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" />Since you checked in</> : <>{incomplete && !reviewed ? <Database size={16} className="text-muted" aria-hidden="true" /> : <CheckCheck size={16} className="text-muted" aria-hidden="true" />}{query.isError ? "Last saved snapshot" : reviewed ? "Checkpoint updated" : incomplete ? "Some data is still indexing" : "No new indexed activity"}</>}</h3><p className="mt-1.5 max-w-sm text-pretty text-xs leading-relaxed text-muted">{query.isPlaceholderData ? "Loading your new activity window." : changed.length && !query.isError ? `${changed.length} ${changed.length === 1 ? "token has" : "tokens have"} updates. Mark them reviewed when you're done.` : reviewed ? incomplete ? "New activity will appear here. Holder history is still indexing." : "New indexed activity will appear here." : "Mark reviewed to set a checkpoint for the tokens shown."}</p></div>
            {reviewable.length ? <button type="button" aria-disabled={query.isError || query.isPlaceholderData} onClick={() => review(reviewable)} className={`${btn.secondarySm} min-h-11 whitespace-nowrap aria-disabled:opacity-50`}><motion.span key={reviewCount} initial={reviewCount && !reduced ? { scale: 0.7 } : false} animate={{ scale: 1 }} transition={{ duration: reduced ? 0 : 0.2 }} className="inline-flex"><Check size={13} aria-hidden="true" /></motion.span>{query.isPlaceholderData ? "Updating…" : "Mark reviewed"}</button> : null}
          </div> : null}
          <p role="status" className="sr-only"><span key={reviewCount}>{notice}</span></p>
          <ul aria-label="Watched tokens" className="divide-y divide-line">
            {shown.map((entry) => <WatchRow key={watchlistKey(entry)} entry={entry} item={byKey.get(watchlistKey(entry))} now={data?.at} pending={query.isPlaceholderData} layoutKey={rowLayout} reduced={Boolean(reduced)} onRemoved={focusAfterRemoval} />)}
          </ul>
          {!shown.length ? <p className="px-6 py-10 text-center text-sm text-muted">No saved tokens on {chain ? CHAIN_SHORT[chain] : "this chain"}. Choose All chains to see your list.</p> : null}
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-4 text-[11px] leading-relaxed text-muted">
            <p className="max-w-md text-pretty">Stored in this browser. Activity refreshes every 15s while open and may lag the chain. Trade and post catch-up covers up to 30 days.</p>
            <button type="button" onClick={onBrowse} className="inline-flex min-h-11 items-center gap-1.5 text-xs text-body hover:text-ink">Explore launches <ArrowRight size={13} aria-hidden="true" /></button>
          </footer>
        </>
      )}
    </section>
  );
}

function holderChange(entry: WatchlistEntry, item?: Item) {
  return entry.holders !== null && item?.holders != null ? item.holders - entry.holders : null;
}
function hasChanges(entry: WatchlistEntry, item?: Item) {
  return Boolean(item?.launch && ((item.trades ?? 0) > 0 || (item.creatorPosts ?? 0) > 0 || holderChange(entry, item)));
}
function WatchRow({ entry, item, now = entry.seenAt ?? entry.addedAt, pending = false, layoutKey, reduced, onRemoved }: { entry: WatchlistEntry; item?: Item; now?: number; pending?: boolean; layoutKey: string; reduced: boolean; onRemoved: (button: HTMLButtonElement) => void }) {
  const l = item?.launch;
  const delta = holderChange(entry, item);
  const href = `/t/${entry.chain}/${entry.token}`;
  const cap = l ? capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }) : null;
  const established = !pending && item?.since != null;
  return (
    <motion.li initial={false} layout={reduced ? false : "position"} layoutDependency={layoutKey} transition={{ layout: { duration: 0.24, ease: [0.16, 1, 0.3, 1] } }} className="grid gap-x-5 gap-y-2 py-4 @min-[38rem]:grid-cols-[minmax(0,1.1fr)_minmax(17rem,0.9fr)]">
      <div className="flex min-w-0 items-center gap-2">
        <WatchButton token={entry} onRemoved={onRemoved} />
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg">
          <TokenAvatar chain={entry.chain} token={entry.token} symbol={l?.symbol ?? entry.symbol} image={l?.image_url} size={40} className="shrink-0 rounded-xl" />
          <div className="min-w-0"><span className="block truncate text-[15px] font-semibold text-ink">{l?.name ?? entry.name}</span><span className="mt-1 block truncate text-[11px] text-muted"><span className="font-mono">{l?.symbol ?? entry.symbol}</span> · {CHAIN_SHORT[entry.chain]}</span></div>
        </Link>
        {cap ? <div className="shrink-0 text-right"><span className="text-[11px] text-muted">Market cap</span><span className="mt-0.5 block font-mono text-base font-semibold text-ink tnum" title={`${cap.main} · ${cap.detail}`}>{cap.main}</span></div> : null}
      </div>
      {l ? <>
        <dl className="grid grid-cols-3 pt-2 @min-[38rem]:pt-0">
          <Activity tokenName={l.name} label="Trades" value={established ? item?.trades : null} href={`${href}#trades`} />
          <Activity tokenName={l.name} label="Creator posts" value={established ? item?.creatorPosts : null} href={`${href}#comments`} />
          <Activity tokenName={l.name} label="Holder change" value={established ? delta : null} href={`${href}#holders`} signed />
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-2 text-[11px] leading-relaxed text-muted @min-[38rem]:col-span-2 @min-[38rem]:pl-13"><span>{item?.windowClamped ? "Trades & posts: last 30 days" : `Since ${entry.seenAt === null ? "saved" : "reviewed"} ${ago(new Date(entry.seenAt ?? entry.addedAt).toISOString(), now)} ago`}{l.quote_symbol ? ` · ${l.quote_symbol} pair` : ""}</span>{item?.holders === null ? <span>Holder history is indexing</span> : entry.holders === null ? <span>Review to track holder changes</span> : null}</div>
        {item?.windowClamped && delta !== null ? <p className="text-right text-[11px] text-muted @min-[38rem]:col-span-2">Holder change is since your last review.</p> : null}
      </> : <p className="mt-3 pl-2 text-xs text-muted sm:pl-14">{item ? "Token isn’t available in the index right now. It stays saved." : "Activity unavailable. Try refreshing."}</p>}
    </motion.li>
  );
}
function Activity({ tokenName, label, value, href, signed = false }: { tokenName: string; label: string; value: number | null | undefined; href: string; signed?: boolean }) {
  const formatted = value == null ? "Pending" : `${signed && value > 0 ? "+" : ""}${number(value)}`;
  return <div className="min-w-0 px-2"><dt className="min-h-8 text-[11px] leading-4 text-muted @min-[21rem]:min-h-4">{label}</dt><dd><Link href={href} aria-label={`${tokenName}: ${label}, ${formatted}`} title={`${label}: ${formatted}`} className="group flex min-h-11 items-center justify-between gap-1 rounded-md text-ink transition-colors hover:text-brand motion-reduce:transition-none"><span className={`min-w-0 truncate font-mono tnum ${value == null ? "text-xs text-muted" : "text-lg"}`}>{formatted}</span>{value != null ? <ArrowRight size={12} aria-hidden="true" className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /> : null}</Link></dd></div>;
}
