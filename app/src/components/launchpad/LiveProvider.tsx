"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { FeedItem, LaunchRow, LaunchSort, LaunchTotals, TrendingSnap, VolumeWindow } from "@/lib/launchpad/queries";
import type { ChainKey } from "@/lib/chainPublic";
import type { LaunchFilter } from "@/lib/launchpad/search";
import type { PostRow } from "@/lib/launchpad/postsServer";
import type { McapMode } from "@/lib/launchpad/mcap-policy";
import { matchesListSelection } from "@/lib/launchpad/list-state";
import type { BoostLane } from "@/lib/launchpad/boostServer";

/**
 * One poller for the whole page. Everything live (toasts, tape, hero totals,
 * the launch list) subscribes here instead of fetching on its own. The list
 * registers the sort it wants; the request then includes the list too.
 * Pauses while the tab is hidden; ticks immediately when it comes back.
 */
export type Live = {
  at: number;
  feed: FeedItem[];
  totals: LaunchTotals;
  ethUsd: number | null;
  launches: LaunchRow[] | null;
  sort: LaunchSort | null;
  window: VolumeWindow;
  chain: ChainKey | null;
  filter?: LaunchFilter | null;
  mcap?: McapMode;
  mcap_policy?: number;
  limit?: number;
  has_more?: boolean | null;
  posts?: PostRow[];
  trending?: TrendingSnap;
  /** Whether BOOST is on: every answer carries it (an older machine does not, and the last value stands). */
  boost_on?: boolean;
  /** The Boosted lane, only while a lane is on screen (wantBoost); absent when not asked for or not read this tick. */
  boost?: BoostLane;
};
type ListParams = { sort: LaunchSort; window: VolumeWindow; chain: ChainKey | null; filter: LaunchFilter | null; mcap: McapMode; limit: number };
type Listener = (live: Live) => void;
type Ctx = {
  live: Live;
  setListParams: (p: ListParams | null) => void;
  refresh: () => void;
  /** Called after every successful tick with the fresh snapshot. Use for setState from a callback (never from an effect body). */
  subscribe: (fn: Listener) => () => void;
  /** A Boosted lane is on screen: polls ask for the lane until the returned function is called. */
  wantBoost: () => () => void;
};
const LiveCtx = createContext<Ctx | null>(null);
const POLL_MS = 5_000;

/** Share visibility-aware polling across the page and discard launch lists for selections that changed in flight. */
export default function LiveProvider({ initial, children }: { initial: Omit<Live, "launches" | "sort" | "window" | "chain"> & Partial<Pick<Live, "launches" | "sort" | "window" | "chain">>; children: React.ReactNode }) {
  const [live, setLive] = useState<Live>({ launches: null, sort: null, window: "all", chain: null, ...initial });
  const params = useRef<ListParams | null>(initial.sort ? { sort: initial.sort, window: initial.window ?? "all", chain: initial.chain ?? null, filter: initial.filter ?? null, mcap: initial.mcap ?? "filtered", limit: initial.limit ?? 40 } : null);
  const inflight = useRef(false);
  const listeners = useRef(new Set<Listener>());
  const boostWanted = useRef(0);
  const last = useRef<Live>(live);

  /** Poll once when visible, merge available totals, and publish only the currently requested list. */
  const tick = useCallback(async () => {
    if (inflight.current || document.visibilityState !== "visible") return;
    inflight.current = true;
    try {
      const p = params.current;
      const parts = p ? [`sort=${p.sort}`, `window=${p.window}`, `limit=${p.limit}`, `mcap=${p.mcap}`, ...(p.chain ? [`chain=${p.chain}`] : []), ...(p.filter ? [`filter=${p.filter}`] : [])] : [];
      if (boostWanted.current > 0) parts.push("boost=1");
      const q = parts.length ? `?${parts.join("&")}` : "";
      const res = await fetch(`/api/launch/live${q}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Live;
      // a list for a sort we no longer want is dropped, not shown
      const current = params.current;
      if (data.launches && (!current || !matchesListSelection(current, data))) data.launches = null;
      // totals merge field-by-field: during a rolling deploy a poll can land on a machine that predates a newly added
      // total, and a missing field must fall back to the last value the client already had, never to undefined in render
      // by_chain is merged one level deeper for the same reason: an older machine answers without a newly added chain
      // boost_on falls back the same way; the lane (`boost`) does not: a tick without it is simply no news for the lane
      const merged: Live = { ...data, totals: { ...last.current.totals, ...data.totals, by_chain: { ...last.current.totals.by_chain, ...data.totals?.by_chain } }, launches: data.launches ?? null, boost_on: data.boost_on ?? last.current.boost_on };
      last.current = merged;
      setLive(merged);
      listeners.current.forEach((fn) => fn(merged));
    } catch {
      /* offline; keep last */
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => void tick(), POLL_MS);
    const onVis = () => void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [tick]);

  const setListParams = useCallback(
    (p: ListParams | null) => {
      const changed = JSON.stringify(p) !== JSON.stringify(params.current);
      params.current = p;
      if (changed && p) void tick();
    },
    [tick],
  );

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const wantBoost = useCallback(() => {
    boostWanted.current += 1;
    return () => {
      boostWanted.current = Math.max(0, boostWanted.current - 1);
    };
  }, []);

  const value = useMemo(() => ({ live, setListParams, refresh: () => void tick(), subscribe, wantBoost }), [live, setListParams, tick, subscribe, wantBoost]);
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>;
}

export function useLive(): Ctx {
  const c = useContext(LiveCtx);
  if (!c) throw new Error("useLive outside LiveProvider");
  return c;
}
