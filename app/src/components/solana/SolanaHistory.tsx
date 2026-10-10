"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  explorerUrl,
  formatUnits,
  type SolanaConfig,
} from "@/lib/solana/config";
import type { SolanaHistory as SolanaHistoryResponse } from "@/lib/solana/history";
import { linkedTimeoutSignal } from "@/lib/bridge/client";

function Candles({ candles }: { candles: SolanaHistoryResponse["candles"] }) {
  const box = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const valid = candles.every((c) =>
    [c.open, c.high, c.low, c.close].every(
      (p) =>
        Number.isFinite(Number(p)) &&
        Number(p) > 0 &&
        Number(p) < 90_071_992_547_409,
    ),
  );
  useEffect(() => {
    if (!box.current || !valid || !candles.length) return;
    const style = getComputedStyle(box.current);
    const chart = createChart(box.current, {
      width: box.current.clientWidth,
      height: 280,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: style.color,
        fontFamily: style.fontFamily,
        attributionLogo: true,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: resolvedTheme === "dark" ? "#202020" : "#e7e7e4" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#12a474",
      downColor: "#e04458",
      borderVisible: false,
      wickUpColor: "#12a474",
      wickDownColor: "#e04458",
      priceFormat: { type: "price", precision: 12, minMove: 0.000000000001 },
    });
    series.setData(
      candles.map((c) => ({
        time: c.t as UTCTimestamp,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      })),
    );
    chart.timeScale().fitContent();
    const resize = new ResizeObserver(() => {
      if (box.current) chart.applyOptions({ width: box.current.clientWidth });
    });
    resize.observe(box.current);
    return () => {
      resize.disconnect();
      chart.remove();
    };
  }, [candles, valid, resolvedTheme]);
  if (!valid)
    return (
      <p className="py-8 text-sm text-muted">
        Prices exceed this chart’s display range. Exact trade amounts remain
        available below.
      </p>
    );
  return (
    <div
      ref={box}
      className="h-[280px] min-w-0 text-muted"
      aria-label="Five-minute candlesticks in SOL per token. Exact trade records follow."
    />
  );
}

export default function SolanaHistory({
  config,
  pool,
  sequence,
}: {
  config: SolanaConfig;
  pool: string;
  sequence: string;
}) {
  const key = `${config.cluster}:${config.programId}:${pool}`;
  const [record, setRecord] = useState<{
    key: string;
    value: SolanaHistoryResponse;
  } | null>(null);
  const [notice, setNotice] = useState<{ key: string; error: string } | null>(
    null,
  );
  const result = record?.key === key ? record.value : null;
  const error = notice?.key === key ? notice.error : "";
  useEffect(() => {
    const abort = new AbortController();
    let reading = false;
    async function load() {
      if (reading || document.hidden || abort.signal.aborted) return;
      reading = true;
      try {
        const response = await fetch(
          `/api/solana/history/${encodeURIComponent(pool)}`,
          {
            // Not AbortSignal.any: older wallet in-app browsers lack it, and history would never load there.
            signal: linkedTimeoutSignal(abort.signal, 20_000),
            cache: "no-store",
          },
        );
        if (!response.ok)
          throw new Error(
            "Trade history is unavailable. Pool balances and trading remain independent of this chart.",
          );
        const value = (await response.json()) as SolanaHistoryResponse;
        if (value.pool !== pool || !/^\d+$/.test(value.throughSequence))
          throw new Error("History response did not match this pool.");
        if (!abort.signal.aborted) {
          // Confirmed state can reorganize. Do not retain an orphaned higher
          // sequence merely because the newest RPC snapshot has fewer trades.
          setRecord({ key, value });
          setNotice(null);
        }
      } catch (e: unknown) {
        if (!abort.signal.aborted)
          setNotice({
            key,
            error: e instanceof Error ? e.message : "History unavailable.",
          });
      } finally {
        reading = false;
      }
    }
    void load();
    // The API caches each pool and sequence for 30 seconds. Retry even when no
    // further swap changes sequence, including after an initially unavailable RPC transaction.
    const timer = setInterval(() => void load(), 20_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [key, pool, sequence]);
  return (
    <section className="mt-8 min-w-0" aria-label="Recent on-chain trades">
      <h3 className="text-lg font-semibold text-ink">Recent trading</h3>
      <p className="mt-1 text-xs text-muted">
        SOL per token · 5-minute candles · Confirmed program events
      </p>
      {/* A failed refresh keeps the last loaded trades on screen; the error replaces nothing it can't. */}
      {error && !result ? (
        <p className="py-6 text-sm text-muted" role="status">
          {error}
        </p>
      ) : !result ? (
        <p className="py-8 text-sm text-muted" role="status">
          Reading recent transactions…
        </p>
      ) : (
        <>
          {result.candles.length ? (
            <Candles candles={result.candles} />
          ) : (
            <p className="py-10 text-sm leading-relaxed text-muted">
              No timed trades in the recent transaction window. No history is
              drawn from the starting valuation.
            </p>
          )}
          <p className="border-y border-line py-3 text-xs leading-relaxed text-muted">
            Recent window only, not lifetime volume or complete history.{" "}
            {result.coverage.signaturesScanned} signatures checked.
            {BigInt(result.throughSequence) < BigInt(sequence)
              ? " History is catching up with the latest pool state."
              : ""}
            {result.coverage.sequenceGaps
              ? " Some trade sequences are missing from this window."
              : ""}
            {result.coverage.unavailableTransactions > 0
              ? " Some transactions are unavailable from the RPC."
              : ""}
            {error
              ? " The latest refresh failed, so this shows the last trades loaded."
              : ""}
          </p>
          <ul className="divide-y divide-line">
            {result.trades
              .slice(-8)
              .reverse()
              .map((trade) => (
                <li
                  key={`${trade.signature}:${trade.eventIndex}`}
                  className="flex items-center justify-between gap-3 py-3 text-xs"
                >
                  <a
                    href={explorerUrl(config.cluster, "tx", trade.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-body hover:text-brand"
                  >
                    <span className={trade.isBuy ? "text-up" : "text-down"}>
                      {trade.isBuy ? "Buy" : "Sell"}
                    </span>
                    <span className="ml-2 font-code">
                      {trade.trader.slice(0, 5)}…{trade.trader.slice(-4)}
                    </span>
                  </a>
                  <span className="text-right tabular-nums text-ink">
                    {formatUnits(BigInt(trade.tokenAmount), 6)} tokens
                    <span className="block text-muted">
                      {formatUnits(BigInt(trade.curveLamports), 9)} SOL · curve
                      amount
                    </span>
                  </span>
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}
