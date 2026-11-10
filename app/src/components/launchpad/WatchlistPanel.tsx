"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { ArrowRight, Check, CheckCheck, Database, RefreshCw, Star } from "lucide-react";
import { btn } from "@/components/ui";
import { CHAIN_SHORT, type ChainKey } from "@/lib/chainPublic";
import { WATCHLIST_LIMIT, watchlistKey, type WatchlistEntry } from "@/lib/launchpad/watchlist";
import { capDisplay } from "@/lib/launchpad/market-cap";
import { useAgo } from "@/i18n/useAgo";
import type { WatchlistData as WatchlistResponse } from "@/lib/launchpad/watchlistData";
import TokenAvatar from "./TokenAvatar";
import WatchButton from "./WatchButton";
import { localizedCap } from "./LaunchRow";
import { useWatchlist } from "./useWatchlist";

type Item = WatchlistResponse["items"][number];
const number = (value: number) => value.toLocaleString("en-US");

/** The launch list's Watchlist tab. The list's own chain toggle scopes it. */
export default function WatchlistPanel({ chain, onBrowse }: { chain: ChainKey | null; onBrowse: () => void }) {
  const { entries, ready, storageError, markSeen } = useWatchlist();
  const t = useTranslations("market.watchlist");
  const tm = useTranslations("market");
  const [notice, setNotice] = useState(false);
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
    setNotice(true);
    setReviewCount((count) => count + 1);
    setReviewedScope(items.map(watchlistKey).join("|"));
  }
  function focusAfterRemoval(button: HTMLButtonElement) {
    const row = button.closest("li");
    const next = row?.nextElementSibling?.querySelector("button") ?? row?.previousElementSibling?.querySelector("button");
    requestAnimationFrame(() => (next?.isConnected ? next : heading.current)?.focus({ preventScroll: true }));
  }

  return (
    <section aria-labelledby="watchlist-heading" className="@container min-w-0 border-t border-line px-4">
      <header className="flex items-start justify-between gap-4 pb-4 pt-5">
        <div className="min-w-0">
          <h3 ref={heading} tabIndex={-1} id="watchlist-heading" className="text-lg font-semibold tracking-tight text-ink">{t("heading")}</h3>
          <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">{t("intro")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span aria-label={ready ? t("count", { count: entries.length, max: WATCHLIST_LIMIT }) : t("countLoading")} className="font-mono text-xs text-muted tnum">{ready ? <><span className="text-ink">{entries.length}</span><span aria-hidden="true"> / 50</span></> : "…"}</span>
          {ready && entries.length ? <button type="button" aria-label={query.isFetching ? t("refreshing") : t("refresh")} title={t("refresh")} onClick={() => { if (!query.isFetching) void query.refetch(); }} aria-disabled={query.isFetching} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card hover:text-ink aria-disabled:opacity-50 motion-reduce:transition-none"><RefreshCw size={15} aria-hidden="true" className={query.isFetching ? "animate-spin motion-reduce:animate-none" : ""} /></button> : null}
        </div>
      </header>
      {storageError ? <p role="alert" className="border-t border-line px-5 py-3 text-xs text-warm-ink">{t("storageError")}</p> : null}
      {loading ? <div role="status" className="space-y-4 border-t border-line p-6"><span className="sr-only">{t("loading")}</span>{[0, 1, 2].map((key) => <div key={key} className="flex h-20 items-center gap-4 border-b border-line"><span className="h-10 w-10 rounded-xl bg-skeleton" /><span className="h-4 w-36 rounded bg-skeleton" /><span className="ml-auto h-4 w-20 rounded bg-skeleton" /></div>)}</div> : entries.length === 0 ? (
        <div className="border-t border-line py-10 sm:py-12">
          <Star size={20} strokeWidth={1.4} className="mb-4 text-brand" aria-hidden="true" />
          <h4 className="max-w-sm text-xl font-semibold leading-tight tracking-tight text-ink">{t("emptyTop")}<br />{t("emptyBottom")}</h4>
          <p className="mt-4 max-w-sm text-pretty text-sm leading-relaxed text-body">{t("emptyBody")}</p>
          <button type="button" onClick={onBrowse} className={`${btn.secondary} mt-7`}>{t("findFirst")}</button>
          <p className="mt-8 text-[11px] text-muted">{t("emptyNote")}</p>
        </div>
      ) : (
        <>
          {query.isError ? <div role="alert" className="border-t border-line px-5 py-4 text-sm text-warm-ink">{data ? t("errorSnapshot") : t("errorSaved")}</div> : null}
          {data ? <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-y border-line py-4">
            <div className="min-w-0 flex-1 basis-44"><h4 className="flex items-center gap-2 text-sm font-semibold text-ink">{query.isPlaceholderData ? t("updatingActivity") : changed.length && !query.isError ? <><span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" />{t("sinceCheckIn")}</> : <>{incomplete && !reviewed ? <Database size={16} className="text-muted" aria-hidden="true" /> : <CheckCheck size={16} className="text-muted" aria-hidden="true" />}{query.isError ? t("lastSnapshot") : reviewed ? t("checkpointUpdated") : incomplete ? t("indexing") : t("nothingNew")}</>}</h4><p className="mt-1.5 max-w-sm text-pretty text-xs leading-relaxed text-muted">{query.isPlaceholderData ? t("loadingWindow") : changed.length && !query.isError ? t("changed", { count: changed.length }) : reviewed ? incomplete ? t("reviewedIndexing") : t("reviewed") : t("markHint")}</p></div>
            {reviewable.length ? <button type="button" aria-disabled={query.isError || query.isPlaceholderData} onClick={() => review(reviewable)} className={`${btn.secondarySm} min-h-11 whitespace-nowrap aria-disabled:opacity-50`}><motion.span key={reviewCount} initial={reviewCount && !reduced ? { scale: 0.7 } : false} animate={{ scale: 1 }} transition={{ duration: reduced ? 0 : 0.2 }} className="inline-flex"><Check size={13} aria-hidden="true" /></motion.span>{query.isPlaceholderData ? t("updatingButton") : t("markReviewed")}</button> : null}
          </div> : null}
          <p role="status" className="sr-only"><span key={reviewCount}>{notice ? t("reviewedNotice") : null}</span></p>
          <ul aria-label={t("label")} className="divide-y divide-line">
            {shown.map((entry) => <WatchRow key={watchlistKey(entry)} entry={entry} item={byKey.get(watchlistKey(entry))} now={data?.at} pending={query.isPlaceholderData} layoutKey={rowLayout} reduced={Boolean(reduced)} onRemoved={focusAfterRemoval} />)}
          </ul>
          {!shown.length ? <p className="px-6 py-10 text-center text-sm text-muted">{chain ? t("emptyChain", { chain: CHAIN_SHORT[chain] }) : t("emptyThisChain")}</p> : null}
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-4 text-[11px] leading-relaxed text-muted">
            <p className="max-w-md text-pretty">{t("footer")}</p>
            <button type="button" onClick={onBrowse} className="inline-flex min-h-11 items-center gap-1.5 text-xs text-body hover:text-ink">{tm("explore")}</button>
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
  const t = useTranslations("market.watchlist");
  const tm = useTranslations("market");
  const { ago } = useAgo();
  const l = item?.launch;
  const delta = holderChange(entry, item);
  const href = `/t/${entry.chain}/${entry.token}`;
  const cap = l ? localizedCap(capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }), tm("noUsdPrice")) : null;
  const established = !pending && item?.since != null;
  return (
    <motion.li initial={false} layout={reduced ? false : "position"} layoutDependency={layoutKey} transition={{ layout: { duration: 0.24, ease: [0.16, 1, 0.3, 1] } }} className="grid gap-x-5 gap-y-2 py-4 @min-[38rem]:grid-cols-[minmax(0,1.1fr)_minmax(17rem,0.9fr)]">
      <div className="flex min-w-0 items-center gap-2">
        <WatchButton token={entry} onRemoved={onRemoved} />
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg">
          <TokenAvatar chain={entry.chain} token={entry.token} symbol={l?.symbol ?? entry.symbol} image={l?.image_url} size={40} className="shrink-0 rounded-xl" />
          <div className="min-w-0"><span className="block truncate text-[15px] font-semibold text-ink">{l?.name ?? entry.name}</span><span className="mt-1 block truncate text-[11px] text-muted"><span className="font-mono">{l?.symbol ?? entry.symbol}</span> · {CHAIN_SHORT[entry.chain]}</span></div>
        </Link>
        {cap ? <div className="shrink-0 text-right"><span className="text-[11px] text-muted">{tm("marketCap")}</span><span className="mt-0.5 block font-mono text-base font-semibold text-ink tnum" title={`${cap.main} · ${cap.detail}`}>{cap.main}</span></div> : null}
      </div>
      {l ? <>
        <dl className="grid grid-cols-3 pt-2 @min-[38rem]:pt-0">
          <Activity tokenName={l.name} label={t("trades")} value={established ? item?.trades : null} href={`${href}#trades`} />
          <Activity tokenName={l.name} label={t("creatorPosts")} value={established ? item?.creatorPosts : null} href={`${href}#comments`} />
          <Activity tokenName={l.name} label={t("holderChange")} value={established ? delta : null} href={`${href}#holders`} signed />
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-2 text-[11px] leading-relaxed text-muted @min-[38rem]:col-span-2 @min-[38rem]:pl-13"><span>{item?.windowClamped ? t("clamped") : t(entry.seenAt === null ? "sinceSaved" : "sinceReviewed", { time: ago(new Date(entry.seenAt ?? entry.addedAt).toISOString(), now) })}{l.quote_symbol ? ` · ${t("pair", { quote: l.quote_symbol })}` : ""}</span>{item?.holders === null ? <span>{t("holderIndexing")}</span> : entry.holders === null ? <span>{t("reviewToTrack")}</span> : null}</div>
        {item?.windowClamped && delta !== null ? <p className="text-right text-[11px] text-muted @min-[38rem]:col-span-2">{t("holderSinceReview")}</p> : null}
      </> : <p className="mt-3 pl-2 text-xs text-muted sm:pl-14">{item ? t("notIndexed") : t("unavailable")}</p>}
    </motion.li>
  );
}
function Activity({ tokenName, label, value, href, signed = false }: { tokenName: string; label: string; value: number | null | undefined; href: string; signed?: boolean }) {
  const t = useTranslations("market.watchlist");
  const formatted = value == null ? t("pending") : `${signed && value > 0 ? "+" : ""}${number(value)}`;
  return <div className="min-w-0 px-2"><dt className="min-h-8 text-[11px] leading-4 text-muted @min-[21rem]:min-h-4">{label}</dt><dd><Link href={href} aria-label={t("stat", { token: tokenName, label, value: formatted })} title={t("statTitle", { label, value: formatted })} className="group flex min-h-11 items-center justify-between gap-1 rounded-md text-ink transition-colors hover:text-brand motion-reduce:transition-none"><span className={`min-w-0 truncate font-mono tnum ${value == null ? "text-xs text-muted" : "text-lg"}`}>{formatted}</span>{value != null ? <ArrowRight size={12} aria-hidden="true" className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /> : null}</Link></dd></div>;
}
