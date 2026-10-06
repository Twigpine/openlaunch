"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowDownWideNarrow, ArrowRight, LayoutGrid, Rows3, Search, SlidersHorizontal, Star, X } from "lucide-react";
import LaunchRow, { LaunchListHeader, type RowHighlight } from "./LaunchRow";
import LaunchCard from "./LaunchCard";
import { useLive } from "./LiveProvider";
import WatchButton from "./WatchButton";
import { ChainLogo } from "./ChainLogo";
import WatchlistPanel from "./WatchlistPanel";
import { useWatchlist } from "./useWatchlist";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { btn } from "@/components/ui";
import type { LaunchRow as L, LaunchSort, VolumeWindow } from "@/lib/launchpad/queries";
import { CHAIN_SHORT, type ChainKey } from "@/lib/chainPublic";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";
import { FILTERS, filterOnChain, isAddressQuery, matchesFilter, matchesQuery, normalizeQuery, rankHit, type LaunchFilter } from "@/lib/launchpad/search";
import { launchKey, mergeLaunches, refreshInPlace } from "@/lib/launchpad/list-state";
import { liveChip, liveChipParts, liveTier } from "@/lib/launchpad/ranking";
import { PAGE_SIZE } from "@/lib/launchpad/paging";
import { Spinner } from "@/components/Skeleton";
import { layoutCookie, type ListLayout } from "@/lib/launchpad/list-layout";
import { startNav } from "@/components/RouteProgress";

const SORTS: { key: LaunchSort; label: string }[] = [
  { key: "live", label: "Active" },
  { key: "new", label: "New" },
  { key: "mcap", label: "Market cap" },
  { key: "volume", label: "Volume" },
  { key: "gainers", label: "Gainers" },
  { key: "holders", label: "Holders" },
];
const WINDOWS: VolumeWindow[] = ["1h", "24h", "all"];
const CHAIN_FILTERS: { key: ChainKey | null; label: string }[] = [
  { key: null, label: "All chains" },
  ...VISIBLE_CHAINS.map((key) => ({ key, label: CHAIN_SHORT[key] })),
];
const HL_NEW_MS = 60_000;
const HL_TRADE_MS = 2_500;
const REORDER_QUIET_MS = 3_000;
/** When the live order changes, rows and cards glide to their new places instead of jumping. */
const REORDER = { type: "spring", stiffness: 380, damping: 38 } as const;

type Selection = { sort: LaunchSort; window: VolumeWindow; chain: ChainKey | null; filter: LaunchFilter | null };
type SearchResult = { query: string; chain: ChainKey | null; rows: L[]; error?: boolean };
export type ListView = "market" | "watchlist";

/**
 * Shared live data, stable pointer targets, URL-backed filters and scoped async results. `serverNow` is the time the
 * page rendered: the clock starts there, so hydration sees the same tiers, filters and divider as the server's HTML.
 */
export default function LaunchList({ initial, initialHasMore = false, initialSort, initialWindow, initialChain, initialFilter = null, initialView = "market", initialLayout = "list", frame = "rounded-2xl border border-line bg-paper", bare = false, hasDb, serverNow }: { initial: L[]; serverNow: number; frame?: string; bare?: boolean; initialHasMore?: boolean; initialSort: LaunchSort; initialWindow: VolumeWindow; initialChain: ChainKey | null; initialFilter?: LaunchFilter | null; initialView?: ListView; initialLayout?: ListLayout; ethUsd?: number | null; hasDb: boolean }) {
  const router = useRouter();
  const { live, setListParams, subscribe } = useLive();
  const [selection, setSelection] = useState<Selection>({ sort: initialSort, window: initialWindow, chain: initialChain, filter: initialFilter });
  const { sort, window: window_, chain, filter } = selection;
  const [view, setView] = useState<ListView>(initialView);
  const [layout, setLayout] = useState<ListLayout>(initialLayout);
  // `bare`: the list sits on the page (the full-screen home) instead of in its own box, aligned to the page column
  const pad = bare ? "px-0" : "px-4";
  const reduced = useReducedMotion();
  const watchlist = useWatchlist();
  const selectionRef = useRef(selection);
  const generation = useRef(0);
  const selectionRequest = useRef<AbortController | null>(null);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<SearchResult | null>(null);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [limit, setLimit] = useState(Math.max(PAGE_SIZE, initial.length));
  const limitRef = useRef(limit);
  const [rows, setRows] = useState<L[]>(initial);
  const [hl, setHl] = useState<Map<string, RowHighlight>>(new Map());
  const [now, setNow] = useState(serverNow);
  const [holding, setHolding] = useState(false);
  const previous = useRef(new Map(initial.map((l) => [launchKey(l), l])));
  const pendingOrder = useRef<L[] | null>(null);
  const interaction = useRef({ pointer: false, focus: false, at: 0 });
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    // the watchlist reads its own endpoint; the shared poll only carries the market list while it is on screen
    setListParams(view === "market" ? { ...selection, limit } : null);
    return () => setListParams(null);
  }, [selection, limit, view, setListParams]);

  useEffect(() => {
    const clock = setInterval(() => {
      const t = Date.now();
      setNow((current) => Math.floor(t / 5_000) === Math.floor(current / 5_000) ? current : t);
      setHl((cur) => {
        const next = new Map([...cur].filter(([, value]) => value && t - value.at < (value.kind === "new" ? HL_NEW_MS : HL_TRADE_MS)));
        return next.size === cur.size ? cur : next;
      });
      const active = interaction.current;
      if (pendingOrder.current && !active.pointer && !active.focus && t - active.at >= REORDER_QUIET_MS) {
        setRows(pendingOrder.current);
        pendingOrder.current = null;
        setHolding(false);
      }
    }, 1_000);
    return () => { clearInterval(clock); selectionRequest.current?.abort(); };
  }, []);

  useEffect(() => subscribe((snap) => {
    const current = selectionRef.current;
    const incoming = snap.launches;
    if (!incoming || snap.sort !== current.sort || snap.window !== current.window || (snap.chain ?? null) !== current.chain || (snap.filter ?? null) !== current.filter || (snap.limit !== undefined && snap.limit !== limitRef.current)) return;
    const t = Date.now();
    const changes = new Map<string, RowHighlight>();
    for (const row of incoming) {
      const key = launchKey(row);
      const old = previous.current.get(key);
      if (!old && t - new Date(row.block_time).getTime() < 600_000) changes.set(key, { kind: "new", at: t });
      else if (old && (row.buys > old.buys || row.sells > old.sells)) changes.set(key, { kind: row.sells > old.sells && row.buys === old.buys ? "sell" : "buy", at: t });
    }
    if (changes.size) setHl((cur) => new Map([...cur, ...changes]));
    previous.current = new Map(incoming.map((row) => [launchKey(row), row]));
    if (typeof snap.has_more === "boolean") setHasMore(snap.has_more);
    setUpdating(false);
    setLoadError(null);
    const active = interaction.current;
    if (active.pointer || active.focus || t - active.at < REORDER_QUIET_MS) {
      pendingOrder.current = incoming;
      setRows((cur) => refreshInPlace(cur, incoming));
      setHolding(true);
    } else {
      pendingOrder.current = null;
      setRows(incoming);
      setHolding(false);
    }
  }), [subscribe]);

  /** The URL carries the view as well as the selection, so going back to the page reopens the same tab. */
  function syncUrl(next: Selection, v: ListView): URLSearchParams {
    const p = new URLSearchParams();
    if (next.sort !== "live") p.set("sort", next.sort);
    if (next.window !== "all") p.set("window", next.window);
    if (next.chain) p.set("chain", next.chain);
    if (next.filter) p.set("filter", next.filter);
    if (v === "watchlist") p.set("view", "watchlist");
    router.replace(p.size ? `/?${p}` : "/", { scroll: false });
    return p;
  }

  function pick(s: LaunchSort, w: VolumeWindow = window_, c: ChainKey | null = chain, f: LaunchFilter | null = filter, v: ListView = view) {
    const next = { sort: s, window: w, chain: c, filter: f };
    if (JSON.stringify(next) === JSON.stringify(selectionRef.current)) {
      if (v !== view) { setView(v); syncUrl(next, v); }
      return;
    }
    setView(v);
    selectionRef.current = next;
    const version = ++generation.current;
    selectionRequest.current?.abort();
    const controller = new AbortController();
    selectionRequest.current = controller;
    pendingOrder.current = null;
    setHolding(false);
    setSelection(next);
    limitRef.current = PAGE_SIZE;
    setLimit(PAGE_SIZE);
    setLoadingMore(false);
    setUpdating(true);
    setLoadError(null);
    const request = syncUrl(next, v);
    request.delete("view");
    request.set("sort", s); // the URL omits the default sort, but the API defaults to "new": the request must always carry it
    request.set("limit", String(PAGE_SIZE));
    void fetch(`/api/launch/list?${request}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("List unavailable");
        const data = await res.json() as { launches: L[]; has_more: boolean };
        if (controller.signal.aborted || generation.current !== version) return;
        previous.current = new Map(data.launches.map((row) => [launchKey(row), row]));
        pendingOrder.current = null;
        setRows(data.launches);
        setHasMore(data.has_more);
        setHl(new Map());
      })
      .catch(() => { if (!controller.signal.aborted && generation.current === version) setLoadError("Could not refresh this view. Live updates will retry."); })
      .finally(() => { if (generation.current === version) setUpdating(false); });
  }

  const nq = normalizeQuery(q);
  useEffect(() => {
    if (!nq) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/launch/search?q=${encodeURIComponent(nq)}${chain ? `&chain=${chain}` : ""}`, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error("Search unavailable");
        const data = await res.json() as { launches: L[] };
        if (controller.signal.aborted) return;
        if (isAddressQuery(nq) && data.launches.length === 1) {
          startNav();
          router.push(`/t/${data.launches[0].chain}/${data.launches[0].token}`);
        }
        setRemote({ query: nq, chain, rows: data.launches });
      } catch {
        if (!controller.signal.aborted) setRemote({ query: nq, chain, rows: [], error: true });
      }
    }, 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [nq, chain, router]);

  async function loadMore() {
    if (loadingMore || updating) return;
    selectionRequest.current?.abort();
    const version = generation.current;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const p = new URLSearchParams({ sort, window: window_, limit: String(PAGE_SIZE), offset: String(rows.length) });
      if (chain) p.set("chain", chain);
      if (filter) p.set("filter", filter);
      const res = await fetch(`/api/launch/list?${p}`, { cache: "no-store" });
      if (!res.ok) throw new Error("List unavailable");
      const data = await res.json() as { launches: L[]; has_more: boolean };
      if (generation.current !== version) return;
      const merged = mergeLaunches(rows, data.launches);
      for (const row of data.launches) previous.current.set(launchKey(row), row);
      pendingOrder.current = null;
      setRows((cur) => mergeLaunches(cur, data.launches));
      setHasMore(data.has_more);
      limitRef.current = Math.min(200, merged.length);
      setLimit(limitRef.current);
    } catch {
      if (generation.current === version) setLoadError("Could not load more launches. Please try again.");
    } finally {
      if (generation.current === version) setLoadingMore(false);
    }
  }

  /** Rows or cards; remembered in a cookie so the next visit renders the same layout from the server. */
  function chooseLayout(next: ListLayout) {
    setLayout(next);
    document.cookie = layoutCookie(next);
  }

  const searchResult = remote?.query === nq && remote.chain === chain ? remote : null;
  const searching = Boolean(nq && !searchResult);
  const candidates = nq ? mergeLaunches(rows, searchResult?.rows ?? []) : rows;
  const shown = candidates.filter((row) => (!chain || row.chain === chain) && matchesFilter(row, filter, now) && (!nq || matchesQuery(row, nq)));
  if (nq) shown.sort((a, b) => rankHit(a, nq) - rankHit(b, nq));
  const showWindow = sort === "volume";
  const reset = () => { setQ(""); pick("live", "all", null, null); };
  const ranked = sort === "live" && !nq; // tiers, chips and the quiet divider apply to the live view only
  const firstQuiet = ranked ? shown.findIndex((row) => liveTier(row, now) === "quiet") : -1; // one divider, where the database's order enters the quiet tier

  return (
    <section id="launches" aria-labelledby="launches-heading" className={`min-w-0 scroll-mt-24 ${bare ? "" : `overflow-hidden ${frame}`}`}>
      <div className={`space-y-4 ${pad} ${bare ? "pt-2" : "pt-5"}`}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 id="launches-heading" className={`font-semibold tracking-tight text-ink ${bare ? "text-xl" : "text-base"}`}>Launches</h2>
              <span className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted tnum" title="Total launches across all chains">{live.totals.launches}</span>
            </div>
            <p className="mt-1 text-xs text-muted">{view === "watchlist" ? "The tokens you starred, and what changed since you last looked." : sort === "live" ? "Tokens with buyers first. Every launch stays in New." : "Every token. Open from the start."}</p>
          </div>
          <div className={`relative w-full sm:w-64 ${view === "watchlist" ? "hidden" : ""}`}>
            <label htmlFor="launch-search" className="sr-only">Search launches</label>
            <Search aria-hidden="true" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input id="launch-search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }} placeholder="Name, symbol or address" className="h-11 w-full rounded-xl border border-line-strong bg-card pl-9 pr-11 text-[13px] text-ink placeholder:text-muted focus:border-brand" autoComplete="off" spellCheck={false} />
            {q ? <button type="button" onClick={() => { setQ(""); document.getElementById("launch-search")?.focus(); }} aria-label="Clear search" className="absolute right-0 top-0 grid h-11 w-11 place-items-center rounded-xl text-muted hover:text-ink"><X size={15} aria-hidden="true" /></button> : null}
          </div>
        </div>
        <div className={`overflow-x-auto bb-scroll ${bare ? "" : "-mx-4 px-4"}`}>
          <ToggleGroup aria-label="Sort launches" variant="underline" value={[view === "watchlist" ? "watchlist" : sort]} onValueChange={(values) => { const next = values[0]; if (!next) return; if (next === "watchlist") pick(sort, window_, chain, filter, "watchlist"); else pick(next as LaunchSort, window_, chain, filter, "market"); }} className="min-w-max gap-5">
            {SORTS.map((s) => <ToggleGroupItem key={s.key} value={s.key} thumbClassName="inset-x-0" className="min-h-11 rounded-none px-0">{s.key === "new" ? <ArrowDownWideNarrow size={13} aria-hidden="true" /> : null}{s.label}</ToggleGroupItem>)}
            <ToggleGroupItem value="watchlist" thumbClassName="inset-x-0" className="min-h-11 rounded-none px-0">
              <Star size={13} aria-hidden="true" fill={view === "watchlist" ? "currentColor" : "none"} />Watchlist
              {watchlist.ready && watchlist.entries.length ? <span className="font-mono text-[11px] text-muted tnum"><span className="sr-only">, </span>{watchlist.entries.length}<span className="sr-only"> saved</span></span> : null}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div className={`space-y-3 border-t border-line py-3 ${pad}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ToggleGroup aria-label="Chain" value={[chain ?? "all"]} onValueChange={(values) => { const value = values[0]; if (!value) return; const c = value === "all" ? null : (value as ChainKey); const keep = !filter || FILTERS.some((f) => f.key === filter && filterOnChain(f, c)); pick(sort, window_, c, keep ? filter : null); }}>
            {CHAIN_FILTERS.map((c) => <ToggleGroupItem key={c.key ?? "all"} value={c.key ?? "all"} title={c.label}>{c.key ? <ChainLogo chain={c.key} size={16} /> : null}<span className={c.key ? "max-sm:sr-only" : undefined}>{c.label}</span></ToggleGroupItem>)}
          </ToggleGroup>
          <div className="flex flex-wrap items-center gap-2">
            {showWindow && view === "market" ? <ToggleGroup aria-label="Volume window" value={[window_]} onValueChange={(values) => { if (values[0]) pick(sort, values[0] as VolumeWindow); }}>
              {WINDOWS.map((w) => <ToggleGroupItem key={w} value={w} className="px-2.5 font-mono tnum">{w === "all" ? "All time" : w}</ToggleGroupItem>)}
            </ToggleGroup> : null}
            {view === "market" ? <ToggleGroup aria-label="Layout" value={[layout]} onValueChange={(values) => { const next = values[0]; if (next === "list" || next === "cards") chooseLayout(next); }}>
              <ToggleGroupItem value="list" aria-label="Show as rows" title="Rows" className="px-2.5"><Rows3 size={14} aria-hidden="true" /><span className="hidden sm:inline">Rows</span></ToggleGroupItem>
              <ToggleGroupItem value="cards" aria-label="Show as cards" title="Cards" className="px-2.5"><LayoutGrid size={14} aria-hidden="true" /><span className="hidden sm:inline">Cards</span></ToggleGroupItem>
            </ToggleGroup> : null}
          </div>
        </div>
        <div className={`flex items-start gap-2 ${view === "watchlist" ? "hidden" : ""}`}>
          <SlidersHorizontal aria-hidden="true" size={13} className="mt-3.5 shrink-0 text-muted" />
          <ToggleGroup aria-label="Quick filter" value={filter ? [filter] : []} onValueChange={(values) => pick(sort, window_, chain, (values[0] as LaunchFilter | undefined) ?? null)} variant="chips" className="min-w-0 overflow-x-auto bb-scroll">
            {FILTERS.filter((f) => filterOnChain(f, chain)).map((f) => <ToggleGroupItem key={f.key} value={f.key} title={f.title} className="min-h-10 px-2.5 text-[11px]">{f.label}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
      </div>
      {view === "watchlist" ? <WatchlistPanel chain={chain} onBrowse={() => pick(sort, window_, chain, filter, "market")} /> : <>
      <div role="status" className={`flex min-h-9 items-center justify-between gap-2 border-t border-line text-[11px] text-muted ${pad}`}>
        <span className="inline-flex items-center gap-2">{updating || searching ? <><Spinner size={11} />{searching ? "Searching all launches…" : "Updating view…"}</> : nq ? <><span className="font-mono tnum">{shown.length}</span> matches</> : <><span className="font-mono tnum">{shown.length}</span> shown · {chain ? CHAIN_SHORT[chain] : "all chains"}</>}</span>
        <span className="shrink-0">{holding ? "Order held while browsing" : "Updates every 5s"}</span>
      </div>
      {layout === "list" ? <LaunchListHeader window={showWindow ? window_ : "all"} /> : null}
      <ul ref={listRef} aria-label="Token launches" aria-busy={updating} className={layout === "cards" ? `grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-4 border-t border-line pt-4 ${pad}` : undefined} onPointerEnter={(e) => { if (e.pointerType === "mouse") interaction.current.pointer = true; }} onPointerLeave={() => { interaction.current.pointer = false; interaction.current.at = Date.now(); }} onPointerDown={() => { interaction.current.at = Date.now(); }} onFocusCapture={() => { interaction.current.focus = true; }} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { interaction.current.focus = false; interaction.current.at = Date.now(); } }}>
        {shown.map((l, i) => {
          const key = launchKey(l);
          const chip = ranked ? liveChip(l, now) : null;
          const rank = !nq && sort !== "new" && (!chip || chip.tier === "live") ? i + 1 : undefined;
          const flash = hl.get(key) ?? null;
          // keyed by layout too: switching layouts redraws the list instead of flying every token across the page
          return <Fragment key={`${layout}:${key}`}>
            {i === firstQuiet ? <li className={layout === "cards" ? "col-span-full pt-2 text-[11px] text-muted" : "border-b border-line bg-card px-4 py-2 text-[11px] text-muted"}><span className="font-medium text-body">Quiet launches</span> · no buyers yet. One row per wallet; every launch stays in New.</li> : null}
            {layout === "cards" ? (
              <motion.li layout={reduced ? false : "position"} transition={REORDER} data-token={key} className={`relative rounded-2xl ${flash ? `bb-card-${flash.kind}` : ""}`}>
                <LaunchCard l={l} rank={rank} hl={flash} now={now} pop={Boolean(flash && flash.kind !== "new")} chip={ranked ? liveChipParts(l, now) : null} />
                {/* outside the card's link: saving never navigates */}
                <div className="absolute right-2 top-2 z-20"><WatchButton overlay token={{ chain: l.chain, token: l.token, name: l.name, symbol: l.symbol }} /></div>
              </motion.li>
            ) : (
              <motion.li layout={reduced ? false : "position"} transition={REORDER} data-token={key} className="relative">
                <LaunchRow l={l} rank={rank} window={showWindow ? window_ : "all"} hl={flash} now={now} pop={Boolean(flash && flash.kind !== "new")} chip={chip} />
                {/* outside the row's link: saving never navigates */}
                <div className="absolute right-1 top-2 md:top-1/2 md:-translate-y-1/2"><WatchButton token={{ chain: l.chain, token: l.token, name: l.name, symbol: l.symbol }} /></div>
              </motion.li>
            )}
          </Fragment>;
        })}
        {shown.length === 0 ? <li className="col-span-full space-y-3 border-t border-line px-5 py-12 text-center">
          <Search size={20} aria-hidden="true" className="mx-auto text-muted" />
          <p className="text-sm font-semibold text-ink">{updating || searching ? "Finding your launches…" : nq || filter || chain ? "No matching launches" : "The next launch could be yours"}</p>
          <p className="mx-auto max-w-xs text-pretty text-xs leading-relaxed text-muted">{!hasDb ? "The launch database is not configured yet." : nq || filter || chain ? "Try a different name, chain or filter." : "New tokens will appear here as soon as they launch."}</p>
          {nq || filter || chain ? <button type="button" onClick={reset} className={btn.secondarySm}>Clear search & filters</button> : <Link href="/launch" className={btn.secondarySm}>Launch the first token <ArrowRight size={13} aria-hidden="true" /></Link>}
        </li> : null}
      </ul>
      {loadError || searchResult?.error ? <p role="alert" className={`py-3 text-xs text-warm-ink ${pad}`}>{loadError || "Search is unavailable. Showing matches from loaded launches."}</p> : null}
      <div className={`flex min-h-14 items-center justify-center py-3 ${pad}`}>
        {!nq && hasMore && rows.length < 200 ? <button type="button" onClick={() => void loadMore()} disabled={loadingMore || updating} className={btn.secondarySm}>{loadingMore ? <><Spinner size={13} /> Loading…</> : <>Load more <ArrowRight size={13} aria-hidden="true" /></>}</button> : <p className="text-center text-[11px] text-muted">{nq ? "Search includes older launches." : rows.length >= 200 && hasMore ? "Showing the first 200. Search or filter to narrow the list." : shown.length ? "You're all caught up." : "One transaction. Zero platform fee."}</p>}
      </div>
      </>}
    </section>
  );
}
