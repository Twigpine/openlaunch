"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { ArrowUpRight, ChartCandlestick, RefreshCw } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { isChartPool, type ChartPool } from "@/lib/launchpad/chart-pool";
import { geckoChartUrl, type GeckoStatus } from "@/lib/launchpad/geckoterminal";

const OnchainChart = dynamic(() => import("./PriceChart"), {
  ssr: false,
  loading: () => <ChartMessage title="Loading on-chain chart…" description="History from Openlaunch’s indexer." />,
});
type Props = ChartPool & { symbol: string; launchedAt: string; hasTrades: boolean; review?: boolean };
type Lookup = GeckoStatus | "checking" | "error";
const fallbackReason: Record<Exclude<Lookup, "ready" | "checking">, string> = {
  unlisted: "Gecko hasn’t indexed this pool yet.",
  inverted: "Gecko lists the quote asset first, so we’re showing the launched token here.",
  unpriced: "Gecko doesn’t have a usable USD price for this pool yet.",
  error: "Gecko is temporarily unavailable.",
};

export default function TokenChart(props: Props) {
  if (!isChartPool(props)) return <ChartMessage title="Chart unavailable" description="This launch does not have a valid pool identity." />;
  return <MarketChart key={[props.chain, props.poolId, props.token, props.quote].join(":").toLowerCase()} {...props} />;
}

function MarketChart({ symbol, chain, token, poolId, quote, launchedAt, hasTrades: initialHasTrades, review = false }: Props) {
  const { resolvedTheme } = useTheme();
  const [lookup, setLookup] = useState<Lookup>("checking");
  const [attempt, setAttempt] = useState(0);
  const [hasTrades, setHasTrades] = useState(initialHasTrades);
  const [source, setSource] = useState<"auto" | "onchain">("auto");
  const pool = { chain, token, poolId, quote };
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const hosted = hasTrades && source === "auto" && lookup === "ready";
  const checking = hasTrades && source === "auto" && lookup === "checking";
  const url = geckoChartUrl(pool, theme, { interval: "15m", metric: "price" });
  const external = geckoChartUrl(pool, theme);
  const onTradesFound = useCallback(() => setHasTrades(true), []);
  const onFrameError = useCallback(() => setLookup("error"), []);

  useEffect(() => {
    if (!hasTrades) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let active = true;
    const query = new URLSearchParams({ chain, token, pool: poolId, quote });
    void (async () => {
      try {
        const response = await fetch("/api/launch/chart-provider?" + query, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Lookup failed.");
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("status" in result)
          || !["ready", "unlisted", "inverted", "unpriced"].includes(String(result.status))) throw new Error("Invalid response.");
        if (active) setLookup(result.status as GeckoStatus);
      } catch {
        if (active) setLookup("error");
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [chain, token, poolId, quote, attempt, hasTrades]);

  function retry() {
    setSource("auto");
    setLookup("checking");
    setAttempt((value) => value + 1);
  }

  return <section aria-label={symbol + " market chart"} className="min-w-0">
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line pb-2">
      <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><ChartCandlestick size={16} className="text-muted" aria-hidden />Market chart</h2>
      <div className="flex flex-wrap items-center gap-1">
        <ToggleGroup aria-label="Chart source" value={[hosted || checking ? "gecko" : "onchain"]}
          onValueChange={(values) => { if (values[0] === "onchain") setSource("onchain"); else if (values[0] === "gecko") retry(); }}
          className="border-0 bg-transparent p-0">
          <ToggleGroupItem value="gecko" disabled={!hasTrades} className="min-h-11 px-3 text-xs">Advanced</ToggleGroupItem>
          <ToggleGroupItem value="onchain" className="min-h-11 px-3 text-xs">On-chain</ToggleGroupItem>
        </ToggleGroup>
        <button type="button" onClick={retry} disabled={checking || !hasTrades}
          className="ui-pressable grid size-11 place-items-center rounded-lg text-muted hover:bg-card hover:text-ink disabled:opacity-40"
          aria-label="Reload advanced chart" title="Reload advanced chart"><RefreshCw size={14} aria-hidden /></button>
        <a href={external} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 px-2 text-xs text-body hover:text-ink">
          GeckoTerminal<ArrowUpRight size={14} aria-hidden />
        </a>
      </div>
    </header>

    {hosted ? <>
      <ChartFrame key={url + ":" + attempt} url={url} symbol={symbol} onError={onFrameError} />
      <p className="mt-3 text-xs leading-relaxed text-muted">Chart and market data by GeckoTerminal. Blank chart? Switch to On-chain above. Reloading, switching sources or changing the site theme may reset drawings.</p>
    </> : checking ? <ChartMessage title="Finding your pool’s chart…" description="Checking the exact token and quote on GeckoTerminal." />
      : <>
        {hasTrades && source === "auto" && lookup !== "ready" && lookup !== "checking"
          ? <p role="status" className="py-3 text-xs leading-relaxed text-muted">{fallbackReason[lookup]} Showing Openlaunch’s indexed history.</p>
          : <p className="py-3 text-xs text-muted">Direct from indexed Uniswap v4 swaps. No external chart required.</p>}
        <OnchainChart chain={chain} token={token} symbol={symbol} launchedAt={launchedAt}
          review={review} onTradesFound={onTradesFound} />
      </>}
  </section>;
}

function ChartMessage({ title, description }: { title: string; description: string }) {
  return <div className="flex min-h-[460px] items-center justify-center bg-paper px-6 py-12 text-center" role="status">
    <div className="max-w-sm"><p className="text-base font-medium text-ink">{title}</p><p className="mt-2 text-sm leading-relaxed text-muted">{description}</p></div>
  </div>;
}

function ChartFrame({ url, symbol, onError }: { url: string; symbol: string; onError: () => void }) {
  // The cross-origin load event proves navigation, not rendered candles. Keep
  // On-chain available and never replace a healthy frame on a blind timeout.
  const [state, setState] = useState<"loading" | "loaded" | "slow">("loading");
  useEffect(() => {
    const timeout = setTimeout(() => setState((current) => current === "loading" ? "slow" : current), 15_000);
    return () => clearTimeout(timeout);
  }, []);

  return <>
    {state !== "loaded" && <p role="status" className="py-2 text-xs text-muted">{state === "slow" ? "Gecko is taking longer than expected. On-chain history is available above." : "Loading GeckoTerminal…"}</p>}
    <iframe title={symbol + " chart by GeckoTerminal"} src={url}
      className="block h-[min(72svh,680px)] min-h-[460px] w-full border-0 bg-paper"
      onLoad={() => setState("loaded")} onError={onError}
      allow="clipboard-write" allowFullScreen referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads" />
  </>;
}
