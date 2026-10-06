"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { INTERVALS, bucketStart, defaultInterval, type Interval } from "@/lib/launchpad/candles";
import { chartRangeSelection, type ChartRange } from "@/lib/launchpad/chart-terminal";
import { mergeChartPayload, type ChartPayload } from "@/lib/launchpad/chart-payload";
import type { ChainKey } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { useLive } from "./LiveProvider";
import TradingChart from "./TradingChart";

/** One bounded history request, then shared-clock refreshes. No extra poller. */
export default function PriceChart({ chain, token, symbol, launchedAt, review = false, onTradesFound }: { chain: ChainKey; token: string; symbol: string; launchedAt: string; review?: boolean; onTradesFound?: () => void }) {
  const reviewMode = process.env.NODE_ENV === "development" && review;
  const launchT = Math.floor(new Date(launchedAt).getTime() / 1000);
  const [interval, setInterval] = useState<Interval>(() => defaultInterval(nowMs() / 1000 - launchT));
  const [range, setRange] = useState<ChartRange>("auto");
  const [result, setResult] = useState<{ key: string; data: ChartPayload } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const { address } = useAccount();
  const { subscribe } = useLive();
  const requestKey = `${chain}:${token.toLowerCase()}:${interval}:${range}:${address?.toLowerCase() ?? ""}`;
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const ready = useRef("");
  const lastFull = useRef(0);
  const lastSeen = useRef("");
  const fetching = useRef(false);

  const load = useCallback(async (tailOnly = false) => {
    if (tailOnly && (ready.current !== requestKey || fetching.current)) return;
    const id = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    fetching.current = true;
    if (!tailOnly) { setLoading(true); setFailure(null); }
    try {
      const now = Math.floor(nowMs() / 1000);
      const from = tailOnly ? bucketStart(now, INTERVALS[interval]) - INTERVALS[interval] * 3
        : range === "auto" ? undefined : chartRangeSelection(range, launchT, now).from;
      const query = new URLSearchParams({ chain, token, interval });
      if (from !== undefined) query.set("from", String(from));
      if (address && !reviewMode) query.set("wallet", address);
      const endpoint = reviewMode ? "/ui-review-charts/candles" : "/api/launch/candles";
      const response = await fetch(`${endpoint}?${query}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Chart request failed (${response.status}).`);
      const payload = await response.json() as ChartPayload;
      if (id !== generation.current || controller.signal.aborted) return;
      ready.current = requestKey;
      if (payload.baseline.hasPriorTrades || payload.candles.length) onTradesFound?.();
      if (!tailOnly) lastFull.current = nowMs();
      setFailure(null);
      setResult((current) => ({ key: requestKey,
        data: mergeChartPayload(current?.key === requestKey ? current.data : null, payload, tailOnly) }));
    } catch (error) {
      if (id !== generation.current || controller.signal.aborted) return;
      setFailure({ key: requestKey, message: error instanceof Error ? error.message : "Chart unavailable." });
    } finally {
      if (id === generation.current) { fetching.current = false; setLoading(false); }
    }
  }, [requestKey, chain, token, interval, range, address, launchT, reviewMode, onTradesFound]);

  useEffect(() => {
    const lifetime = generation;
    const timer = setTimeout(() => void load(), 0);
    return () => { clearTimeout(timer); lifetime.current++; request.current?.abort(); fetching.current = false; };
  }, [load]);

  useEffect(() => subscribe((snapshot) => {
    if (ready.current !== requestKey || fetching.current) return;
    // Periodic full reconciliation catches trades outside the global top-24
    // feed and corrects history. Hidden tabs already pause the shared clock.
    if (nowMs() - lastFull.current >= 60_000) { void load(); return; }
    const hit = snapshot.feed.find((item) => item.kind === "swap" && item.chain === chain && item.token.toLowerCase() === token.toLowerCase());
    if (!hit || hit.kind !== "swap") return;
    const identity = `${requestKey}:${hit.tx_hash}:${hit.quote_wei}`;
    if (identity === lastSeen.current) return;
    lastSeen.current = identity;
    void load(true);
  }), [subscribe, requestKey, chain, token, load]);

  return <TradingChart chain={chain} token={token} symbol={symbol} interval={interval} range={range}
    data={result?.key === requestKey ? result.data : null} loading={loading || (result?.key !== requestKey && failure?.key !== requestKey)}
    error={failure?.key === requestKey ? failure.message : null} hasWallet={Boolean(address) && !reviewMode}
    onIntervalChange={(next) => { setInterval(next); setRange("auto"); }}
    onRangeChange={(next) => { const selection = chartRangeSelection(next, launchT, Math.floor(nowMs() / 1000)); setRange(next); setInterval(selection.interval); }}
    onRefresh={() => void load()} />;
}
