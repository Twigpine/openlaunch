"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowDownWideNarrow, ArrowRight, Check, Search, SlidersHorizontal, X } from "lucide-react";
import LaunchRow, { LaunchListHeader, type RowHighlight } from "./LaunchRow";
import { useLive } from "./LiveProvider";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/vendor/popover";
import ChainSelector from "./ChainSelector";
import { btn } from "@/components/ui";
import type { LaunchRow as L, LaunchSort, VolumeWindow } from "@/lib/launchpad/queries";
import { CHAIN_SHORT, type ChainKey } from "@/lib/chainPublic";
import { FILTERS, filterOnChain, isAddressQuery, matchesFilter, matchesQuery, normalizeQuery, rankHit, type LaunchFilter } from "@/lib/launchpad/search";
import { launchKey, mergeLaunches, refreshInPlace } from "@/lib/launchpad/list-state";
import { liveChip, liveTier } from "@/lib/launchpad/ranking";
import { PAGE_SIZE } from "@/lib/launchpad/paging";
import { Spinner } from "@/components/Skeleton";
import { startNav } from "@/components/RouteProgress";
import styles from "./LaunchList.module.css";

const SORTS: { key: LaunchSort; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "new", label: "New" },
  { key: "mcap", label: "Market cap" },
  { key: "volume", label: "Volume" },
  { key: "gainers", label: "Gainers" },
  { key: "holders", label: "Holders" },
];
const WINDOWS: VolumeWindow[] = ["1h", "24h", "all"];
const HL_NEW_MS = 60_000;
const HL_TRADE_MS = 2_500;
const REORDER_QUIET_MS = 3_000;

type Selection = { sort: LaunchSort; window: VolumeWindow; chain: ChainKey | null; filter: LaunchFilter | null };
type SearchResult = { query: string; chain: ChainKey | null; rows: L[]; error?: boolean };

/** Shared live data, stable pointer targets, URL-backed filters and scoped async results. */
export default function LaunchList({ initial, initialHasMore = false, initialSort, initialWindow, initialChain, initialFilter = null, hasDb }: { initial: L[]; initialHasMore?: boolean; initialSort: LaunchSort; initialWindow: VolumeWindow; initialChain: ChainKey | null; initialFilter?: LaunchFilter | null; ethUsd?: number | null; hasDb: boolean }) {
  const router = useRouter();
  const { live, setListParams, subscribe } = useLive();
  const [selection, setSelection] = useState<Selection>({ sort: initialSort, window: initialWindow, chain: initialChain, filter: initialFilter });
  const { sort, window: window_, chain, filter } = selection;
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
  const [now, setNow] = useState(() => Date.now());
  const [holding, setHolding] = useState(false);
  const previous = useRef(new Map(initial.map((l) => [launchKey(l), l])));
  const pendingOrder = useRef<L[] | null>(null);
  const interaction = useRef({ pointer: false, focus: false, at: 0 });
  const listRef = useRef<HTMLUListElement>(null);
  const filtersTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setListParams({ ...selection, limit });
    return () => setListParams(null);
  }, [selection, limit, setListParams]);

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

  function pick(s: LaunchSort, w: VolumeWindow = window_, c: ChainKey | null = chain, f: LaunchFilter | null = filter) {
    const next = { sort: s, window: w, chain: c, filter: f };
    if (JSON.stringify(next) === JSON.stringify(selectionRef.current)) return;
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
    const p = new URLSearchParams();
    if (s !== "live") p.set("sort", s);
    if (w !== "all") p.set("window", w);
    if (c) p.set("chain", c);
    if (f) p.set("filter", f);
    router.replace(p.size ? `/?${p}` : "/", { scroll: false });
    const request = new URLSearchParams(p);
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
    <section aria-labelledby="launches-heading" className="min-w-0 scroll-mt-24">
      <h2 id="launches-heading" className="sr-only">Launches</h2>
      <div className={`${styles.toolbar} market-toolbar`}>
          <div className={styles.searchWrap}>
            <label htmlFor="launch-search" className="sr-only">Search launches</label>
            <Search aria-hidden="true" size={16} className={styles.searchIcon} />
            <input id="launch-search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }} placeholder="Search token, symbol or address" className={styles.searchInput} autoComplete="off" spellCheck={false} />
            {q ? <button type="button" onClick={() => { setQ(""); document.getElementById("launch-search")?.focus(); }} aria-label="Clear search" className={styles.clearSearch}><X size={15} aria-hidden="true" /></button> : null}
          </div>
          <ChainSelector value={chain} onChange={(c) => { const keep = !filter || FILTERS.some((f) => f.key === filter && filterOnChain(f, c)); pick(sort, window_, c, keep ? filter : null); }} />
          <Popover>
            <PopoverTrigger ref={filtersTriggerRef} className={`${styles.filterButton} ui-pressable ${filter ? styles.filterActive : ""}`}><SlidersHorizontal size={14} aria-hidden="true" />Filters{filter ? <span className={styles.filterCount}>1</span> : null}</PopoverTrigger>
            <PopoverContent>
              <div className="flex items-center justify-between gap-3 px-2"><PopoverTitle className="text-sm font-semibold">Filter launches</PopoverTitle><PopoverClose aria-label="Close filters" className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-line hover:text-ink"><X size={15} aria-hidden="true" /></PopoverClose></div>
              <PopoverDescription className="px-2 pb-3 text-xs text-muted">Choose a filter. Select it again to clear.</PopoverDescription>
              <ToggleGroup aria-label="Quick filter" orientation="vertical" value={filter ? [filter] : []} onValueChange={(values) => pick(sort, window_, chain, (values[0] as LaunchFilter | undefined) ?? null)} className="flex w-full flex-col items-stretch gap-1">
                {FILTERS.filter((f) => filterOnChain(f, chain)).map((f) => <ToggleGroupItem key={f.key} value={f.key} title={f.title} className="min-h-11 w-full justify-between px-3 text-sm">{f.label}{filter === f.key ? <Check size={14} aria-hidden="true" /> : null}</ToggleGroupItem>)}
              </ToggleGroup>
            </PopoverContent>
          </Popover>
      </div>
      <div className={styles.sortRail}>
        <div className={`${styles.sortScroller} bb-scroll`}>
          <div role="group" aria-label="Sort launches" className={styles.sortGroup}>
            {SORTS.map((s) => <button key={s.key} type="button" onClick={() => pick(s.key)} aria-pressed={s.key === sort} className={`${styles.sortButton} ui-pressable`}>{s.key === "new" ? <ArrowDownWideNarrow size={13} aria-hidden="true" /> : null}{s.label}</button>)}
          </div>
        </div>
        <div className={styles.sortMeta}>
          {showWindow ? <ToggleGroup aria-label="Volume window" value={[window_]} onValueChange={(values) => { if (values[0]) pick(sort, values[0] as VolumeWindow); }}>
            {WINDOWS.map((w) => <ToggleGroupItem key={w} value={w} className="min-h-9 px-2.5 font-mono tnum">{w === "all" ? "All time" : w}</ToggleGroupItem>)}
          </ToggleGroup> : null}
          <div role="status" className={styles.status}><span className={styles.countText}>{updating || searching ? <><Spinner size={11} />{searching ? "Searching…" : "Updating…"}</> : nq ? <><strong>{shown.length}</strong> matches</> : <><strong>{shown.length}</strong> of <span className="tnum">{live.totals.launches}</span> · {chain ? CHAIN_SHORT[chain] : "all chains"}</>}</span>{filter ? <button type="button" onClick={() => { pick(sort, window_, chain, null); filtersTriggerRef.current?.focus(); }} className={styles.activeFilter} aria-label="Clear active filter">{FILTERS.find((f) => f.key === filter)?.label}<X size={12} aria-hidden="true" /></button> : null}<span className={styles.updateState}><span className={styles.updateDot} aria-hidden="true" />{holding ? "Order paused" : "Live · 5s"}</span></div>
        </div>
      </div>
      <p className="sr-only">{sort === "live" ? "Tokens with buyers first. Every launch stays in New." : "Every token. Open from the start."}</p>
      <LaunchListHeader window={showWindow ? window_ : "all"} />
      <ul className={styles.list} ref={listRef} aria-label="Token launches" aria-busy={updating} onPointerEnter={(e) => { if (e.pointerType === "mouse") interaction.current.pointer = true; }} onPointerLeave={() => { interaction.current.pointer = false; interaction.current.at = Date.now(); }} onPointerDown={() => { interaction.current.at = Date.now(); }} onFocusCapture={() => { interaction.current.focus = true; }} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { interaction.current.focus = false; interaction.current.at = Date.now(); } }}>
        {shown.map((l, i) => {
          const key = launchKey(l);
          const chip = ranked ? liveChip(l, now) : null;
          const rank = !nq && sort !== "new" && (!chip || chip.tier === "live") ? i + 1 : undefined;
          return <Fragment key={key}>
            {i === firstQuiet ? <li className={styles.quietDivider} title="No buyer activity yet. One visible launch per wallet; every launch remains discoverable in New."><span aria-hidden="true" className={styles.quietVisual}><span className={styles.quietDot} /><strong>First-trade queue</strong><span>One market per wallet · always visible in New</span></span><span className="sr-only">Quiet launches. No buyer activity yet. One visible launch per wallet; every launch remains discoverable in New.</span></li> : null}
            <li data-token={key}><LaunchRow l={l} rank={rank} window={showWindow ? window_ : "all"} hl={hl.get(key) ?? null} now={now} pop={Boolean(hl.get(key) && hl.get(key)?.kind !== "new")} chip={chip} /></li>
          </Fragment>;
        })}
        {shown.length === 0 ? <li className="space-y-3 border-t border-line px-5 py-12 text-center">
          <Search size={20} aria-hidden="true" className="mx-auto text-muted" />
          <p className="text-sm font-semibold text-ink">{updating || searching ? "Finding your launches…" : nq || filter || chain ? "No matching launches" : "The next launch could be yours"}</p>
          <p className="mx-auto max-w-xs text-pretty text-xs leading-relaxed text-muted">{!hasDb ? "The launch database is not configured yet." : nq || filter || chain ? "Try a different name, chain or filter." : "New tokens will appear here as soon as they launch."}</p>
          {nq || filter || chain ? <button type="button" onClick={reset} className={btn.secondarySm}>Clear search & filters</button> : <Link href="/launch" className={btn.secondarySm}>Launch the first token <ArrowRight size={13} aria-hidden="true" /></Link>}
        </li> : null}
      </ul>
      {loadError || searchResult?.error ? <p role="alert" className="px-4 py-3 text-xs text-warm-ink">{loadError || "Search is unavailable. Showing matches from loaded launches."}</p> : null}
      <div className="flex min-h-14 items-center justify-center px-4 py-3">
        {!nq && hasMore && rows.length < 200 ? <button type="button" onClick={() => void loadMore()} disabled={loadingMore || updating} className={btn.secondarySm}>{loadingMore ? <><Spinner size={13} /> Loading…</> : <>Load more <ArrowRight size={13} aria-hidden="true" /></>}</button> : <p className="text-center text-[11px] text-muted">{nq ? "Search includes older launches." : rows.length >= 200 && hasMore ? "Showing the first 200. Search or filter to narrow the list." : shown.length ? "You're all caught up." : "One transaction. Zero platform fee."}</p>}
      </div>
    </section>
  );
}
