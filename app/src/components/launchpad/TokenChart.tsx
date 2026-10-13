"use client";

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { isChartPool, type ChartPool } from "@/lib/launchpad/chart-pool";
import { geckoChartUrl, type GeckoStatus } from "@/lib/launchpad/geckoterminal";
import PriceChart from "./PriceChart";

type Props = ChartPool & { symbol: string; launchedAt: string; hasTrades: boolean; review?: boolean };
type Lookup = "idle" | "checking" | GeckoStatus | "error";
const notAvailable: Record<Exclude<Lookup, "idle" | "checking" | "ready">, string> = {
  unlisted: "GeckoTerminal has not indexed this pool yet.",
  inverted: "GeckoTerminal lists this pool the other way round, so its chart would show the pair token.",
  unpriced: "GeckoTerminal has no usable USD price for this pool yet.",
  error: "GeckoTerminal could not be checked just now.",
};

/**
 * The token chart. Our own chart from indexed Uniswap v4 swaps is the default; GeckoTerminal's hosted chart (with
 * its drawing tools) is one tap away for pools it has indexed. The pool is checked only when someone asks for it,
 * and only an exact match of pool, token and pair is ever shown as this token.
 */
export default function TokenChart(props: Props) {
  // A client-side token navigation must not reuse another pool's lookup result.
  return <MarketChart key={[props.chain, props.poolId, props.token, props.quote].join(":").toLowerCase()} {...props} />;
}

function MarketChart(props: Props) {
  const { chain, token, poolId, quote, symbol, launchedAt, review = false } = props;
  const { resolvedTheme } = useTheme();
  const [source, setSource] = useState<"onchain" | "gecko">("onchain");
  const [lookup, setLookup] = useState<Lookup>("idle");
  const [attempt, setAttempt] = useState(0);
  const [foundTrades, setFoundTrades] = useState(false);
  const hasTrades = props.hasTrades || foundTrades;
  const onTradesFound = useCallback(() => setFoundTrades(true), []);
  const onFrameError = useCallback(() => setLookup("error"), []);
  const valid = isChartPool(props);
  const pool: ChartPool = { chain, token, poolId, quote };
  const theme = resolvedTheme === "dark" ? "dark" : "light";

  useEffect(() => {
    if (source !== "gecko" || !valid || !hasTrades) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let active = true;
    void (async () => {
      try {
        const query = new URLSearchParams({ chain, token, pool: poolId, quote });
        const response = await fetch(`/api/launch/chart-provider?${query}`, { cache: "no-store", signal: controller.signal });
        const result: unknown = response.ok ? await response.json() : null;
        const status = result && typeof result === "object" && "status" in result ? String(result.status) : "";
        if (active) setLookup(["ready", "unlisted", "inverted", "unpriced"].includes(status) ? status as GeckoStatus : "error");
      } catch {
        if (active) setLookup("error");
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [source, valid, hasTrades, chain, token, poolId, quote, attempt]);

  function pick(next: "onchain" | "gecko") {
    setSource(next);
    if (next === "gecko") {
      setLookup("checking");
      setAttempt((value) => value + 1);
    }
  }

  const showGecko = source === "gecko" && lookup === "ready";
  return (
    <div className="min-w-0 space-y-2">
      {valid && hasTrades ? (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {source === "gecko" && lookup !== "ready" && lookup !== "idle" ? (
            <p role="status" className="mr-auto text-xs text-muted">{lookup === "checking" ? "Finding this pool on GeckoTerminal…" : `${notAvailable[lookup]} Showing our own chart.`}</p>
          ) : null}
          <ToggleGroup aria-label="Chart source" value={[source]} onValueChange={(values) => { const next = values[0]; if (next === "onchain" || next === "gecko") pick(next); }}>
            <ToggleGroupItem value="onchain" className="px-2.5 text-[11px]">On-chain</ToggleGroupItem>
            <ToggleGroupItem value="gecko" className="px-2.5 text-[11px]">GeckoTerminal</ToggleGroupItem>
          </ToggleGroup>
          <button type="button" onClick={() => pick("gecko")} disabled={source === "gecko" && lookup === "checking"}
            className="ui-pressable grid size-9 place-items-center rounded-lg text-muted hover:bg-card hover:text-ink disabled:opacity-40"
            aria-label="Reload GeckoTerminal chart" title="Reload GeckoTerminal chart"><RefreshCw size={14} aria-hidden="true" /></button>
        </div>
      ) : null}
      {showGecko ? (
        <section aria-label={`${symbol} chart by GeckoTerminal`} className="overflow-hidden rounded-2xl border border-line bg-paper">
          <ChartFrame key={`${theme}:${attempt}`} symbol={symbol} url={geckoChartUrl(pool, theme, { interval: "15m", metric: "price" })} onError={onFrameError} />
          <p className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[11px] text-muted">
            <span>Chart and market data by GeckoTerminal. Blank chart? Switch back to On-chain. Reloads, source and theme changes may reset drawings.</span>
            <a href={geckoChartUrl(pool, theme)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-body hover:text-ink">Open on GeckoTerminal<ArrowUpRight size={12} aria-hidden="true" /></a>
          </p>
        </section>
      ) : (
        <PriceChart key={`${chain}:${token}`} chain={chain} token={token} symbol={symbol} launchedAt={launchedAt} review={review} onTradesFound={onTradesFound} />
      )}
    </div>
  );
}

function ChartFrame({ url, symbol, onError }: { url: string; symbol: string; onError: () => void }) {
  // A cross-origin load event proves navigation, not rendered candles. Keep the
  // manual on-chain escape hatch and never discard a frame on a blind timeout.
  const [state, setState] = useState<"loading" | "loaded" | "slow">("loading");
  useEffect(() => {
    const timeout = setTimeout(() => setState((current) => current === "loading" ? "slow" : current), 15_000);
    return () => clearTimeout(timeout);
  }, []);

  return <>
    {state !== "loaded" && <p role="status" className="px-4 py-2 text-xs text-muted">{state === "slow" ? "GeckoTerminal is taking longer than expected. On-chain history is available above." : "Loading GeckoTerminal…"}</p>}
    <iframe title={`${symbol} chart by GeckoTerminal`} src={url}
      className="block h-[min(72svh,640px)] min-h-[440px] w-full border-0 bg-paper"
      onLoad={() => setState("loaded")} onError={onError}
      allow="clipboard-write" allowFullScreen referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads" />
  </>;
}
